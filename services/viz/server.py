import io
import os
import hashlib
from typing import Optional, List

import numpy as np
import matplotlib
matplotlib.use('Agg')  # non-GUI backend
import matplotlib.pyplot as plt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Body, Header
from fastapi.responses import Response, JSONResponse
from ai_heart import analyze_pcg_from_pcm
from pcg_hsmm import segment_pcg_hsmm
import httpx
from scipy.io import wavfile

PORT = int(os.getenv('PORT', '4006'))
MEDIA_BASE = os.getenv('MEDIA_BASE', 'http://media-service:4003')
ANALYSIS_BASE = os.getenv('ANALYSIS_BASE', 'http://analysis-service:4004')

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Compute-Time","X-STFT-Time","X-Plot-Time"],
)

# Try to set a font that supports CJK
def _init_fonts():
    try:
        # Prefer Noto Sans CJK if available
        matplotlib.rcParams['font.sans-serif'] = [
            'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR',
            'Noto Sans', 'DejaVu Sans', 'Arial', 'Helvetica', 'sans-serif'
        ]
        matplotlib.rcParams['axes.unicode_minus'] = False
    except Exception:
        pass

_init_fonts()

def _slice_by_time(y: np.ndarray, sr: int, start_sec: Optional[float], end_sec: Optional[float]):
    n = len(y)
    if start_sec is None and end_sec is None:
        return y
    start_idx = 0 if start_sec is None else int(max(0, start_sec) * sr)
    end_idx = n if end_sec is None else int(min(end_sec, n / sr) * sr)
    start_idx = int(np.clip(start_idx, 0, n))
    end_idx = int(np.clip(end_idx, start_idx, n))
    return y[start_idx:end_idx]


def _decimate_to_2k(y: np.ndarray, sr: int):
    target_sr = 2000
    if sr > target_sr:
        k = max(1, int(round(sr / target_sr)))
        if k > 1:
            win = min(len(y), k)
            if win > 1:
                box = np.ones(win, dtype=np.float32) / float(win)
                y = np.convolve(y, box, mode='same').astype(np.float32)
            y = y[::k]
            sr = int(round(sr / k))
    return y.astype(np.float32, copy=False), int(sr)


def _sha256_hex_of_floats(y: np.ndarray, sr: int) -> str:
    y32 = y.astype(np.float32, copy=False)
    h = hashlib.sha256()
    h.update(b'pcg-2k\x00')
    h.update(sr.to_bytes(4, 'little', signed=False))
    h.update(y32.tobytes(order='C'))
    return h.hexdigest()


def _welch_band_power(y: np.ndarray, sr: int, lo: float, hi: float) -> float:
    n = len(y)
    if n < 64:
        return 0.0
    win = 1024 if n >= 2048 else max(128, 1 << (int(np.log2(n)) - 1))
    hop = max(32, win // 2)
    total = 0.0
    frames = 0
    w = np.hanning(win).astype(np.float32)
    for k in range(0, n - win, hop):
        seg = y[k:k + win] * w
        sp = np.fft.rfft(seg)
        freqs = np.fft.rfftfreq(win, 1.0 / sr)
        mask = (freqs >= lo) & (freqs < hi)
        total += float(np.sum((np.abs(sp[mask]) ** 2)))
        frames += 1
    return total / (frames + 1e-9)


def _pcg_quality_core(y: np.ndarray, sr: int):
    # Downsample to ~2kHz for consistency
    y, sr = _decimate_to_2k(y, sr)
    n = len(y)
    issues = []
    if sr <= 0 or n == 0:
        return { 'isHeart': False, 'qualityOk': False, 'score': 0.0, 'issues': ['empty'], 'metrics': {} }
    dur = n / sr
    if dur < 3.0:
        issues.append('too_short')

    # Spectral characteristics
    p_lo = _welch_band_power(y, sr, 20, 150)
    p_mid = _welch_band_power(y, sr, 150, 400)
    p_hf = _welch_band_power(y, sr, 600, 1000)
    p_vlf = _welch_band_power(y, sr, 0, 20)
    snr_db = 10.0 * np.log10((p_lo + p_mid + 1e-9) / (p_vlf + 1e-9))
    low_prop = float((p_lo + p_mid) / (p_lo + p_mid + p_hf + 1e-9))
    if low_prop < 0.50:
        issues.append('energy_not_in_heart_band')

    # Envelope periodicity
    win = max(1, int(0.05 * sr))
    env = np.convolve(np.abs(y), np.ones(win, dtype=np.float32) / float(win), mode='same')
    env /= (np.max(env) + 1e-9)
    ac_full = np.correlate(env, env, mode='full')
    ac = ac_full[n - 1: n - 1 + int(2.0 * sr)]
    # normalized by ac at 0 lag
    ac0 = ac[0] + 1e-9
    min_lag = int(0.3 * sr)  # 200 bpm
    max_lag = int(1.8 * sr)  # 33 bpm
    pr = 0.0
    hr_bpm = None
    if max_lag > min_lag + 5:
        seg = ac[min_lag:max_lag]
        pk = int(np.argmax(seg))
        peak_val = float(seg[pk])
        pr = float(max(0.0, min(1.0, peak_val / ac0)))
        lag = min_lag + pk
        hr_bpm = float(60.0 * sr / lag)
    if pr < 0.12:
        issues.append('weak_periodicity')

    # Cycle consistency estimate via simple peak picking
    thr = max(0.15, float(np.median(env) + 0.5 * np.std(env)))
    min_dist = int(0.2 * sr)
    # simple peak finder
    peaks = []
    i = min_dist
    while i < n - min_dist:
        seg = env[i - min_dist:i + min_dist + 1]
        if env[i] == seg.max() and env[i] >= thr:
            peaks.append(i)
            i += min_dist
        i += 1
    rr = np.diff(np.array(peaks)) / float(sr) if len(peaks) >= 2 else np.array([])
    cycle_cv = float(np.std(rr) / (np.mean(rr) + 1e-9)) if rr.size else 1.0
    if rr.size == 0 or cycle_cv > 0.8:
        issues.append('unstable_cycles')

    # Score (0..1)
    score = 0.4 * pr + 0.25 * max(0.0, min(1.0, (snr_db + 5.0) / 15.0)) + 0.2 * max(0.0, min(1.0, (low_prop - 0.4) / 0.6)) + 0.15 * max(0.0, min(1.0, 1.0 - min(1.0, cycle_cv)))
    # Heuristic pass
    is_heart = ((pr >= 0.12) and (low_prop >= 0.50) and (dur >= 3.0)) or (score >= 0.5)
    # Fallback: try HSMM segmentation to confirm heart-like periodicity
    if not is_heart:
        try:
            from pcg_hsmm import segment_pcg_hsmm
            m = segment_pcg_hsmm(sr, y.tolist())
            hb = m.get('hrBpm') or 0
            s1 = m.get('events',{}).get('s1',[]) or []
            s2 = m.get('events',{}).get('s2',[]) or []
            if 40 <= float(hb) <= 200 and min(len(s1), len(s2)) >= 3:
                is_heart = True
        except Exception:
            pass
    # Quality OK: looser constraints (screening)
    quality_ok = is_heart and (snr_db >= 0.0) and (cycle_cv <= 0.8)
    return {
        'isHeart': bool(is_heart),
        'qualityOk': bool(quality_ok),
        'score': float(score),
        'issues': issues,
        'metrics': {
            'durationSec': float(dur),
            'snrDb': float(snr_db),
            'lowBandProp': float(low_prop),
            'periodicity': float(pr),
            'cycleCV': float(cycle_cv),
            'hrBpmEst': float(hr_bpm) if hr_bpm else None,
            'sr': int(sr)
        }
    }


async def _fetch_wav_and_decode(media_id: str, auth_header: Optional[str]):
    if not media_id:
        return None, None, 'missing mediaId'
    url = f"{MEDIA_BASE}/file/{media_id}"
    headers = {}
    if auth_header:
        headers['Authorization'] = auth_header
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, headers=headers)
        if r.status_code != 200:
            return None, None, f"media fetch failed: {r.status_code}"
        data = r.content
        try:
            bio = io.BytesIO(data)
            sr, x = wavfile.read(bio)
            if x.dtype.kind in ('i', 'u'):
                maxv = np.iinfo(x.dtype).max
                y = (x.astype(np.float32) / float(maxv))
            elif x.dtype.kind == 'f':
                y = x.astype(np.float32)
            else:
                return None, None, 'unsupported wav dtype'
            return int(sr), y, None
        except Exception as e:
            return None, None, f'unsupported format or decode failed: {e}'


@app.post('/waveform_pcm')
async def render_waveform_pcm(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...),
    startSec: Optional[float] = Body(None),
    endSec: Optional[float] = Body(None),
    width: int = Body(1400),
    height: int = Body(240),
):
    y = np.asarray(pcm, dtype=np.float32)
    sr = int(sampleRate)
    y = _slice_by_time(y, sr, startSec, endSec)
    if len(y) == 0:
        return JSONResponse({"error": "empty segment"}, status_code=400)

    # Compute an envelope for visual clarity
    # Downsample to pixel columns using max abs within bins
    n = len(y)
    cols = max(1, int(width))
    bins = np.linspace(0, n, num=cols + 1, dtype=int)
    max_env = np.zeros(cols, dtype=np.float32)
    for i in range(cols):
        seg = y[bins[i]:bins[i+1]]
        if seg.size:
            max_env[i] = np.max(np.abs(seg))
    # Normalize
    if np.max(max_env) > 0:
        max_env = max_env / np.max(max_env)

    fig, ax = plt.subplots(figsize=(width/100, height/100), dpi=100)
    ax.fill_between(np.arange(cols), -max_env, max_env, color='#0ea5e9', alpha=0.9, linewidth=0)
    ax.set_xlim(0, cols)
    ax.set_ylim(-1.05, 1.05)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.axis('off')
    buf = io.BytesIO()
    plt.tight_layout(pad=0)
    fig.savefig(buf, format='png', dpi=100, bbox_inches='tight', pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    return Response(content=buf.read(), media_type='image/png')


import time


@app.post('/spectrogram_pcm')
async def render_spectrogram_pcm(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...),
    startSec: Optional[float] = Body(None),
    endSec: Optional[float] = Body(None),
    width: int = Body(1400),
    height: int = Body(320),
    maxFreq: Optional[int] = Body(2000),
    hash: Optional[str] = Body(None),
    authorization: Optional[str] = Header(default=None, convert_underscores=False),
):
    t0_all = time.perf_counter()
    y = np.asarray(pcm, dtype=np.float32)
    sr = int(sampleRate)
    y = _slice_by_time(y, sr, startSec, endSec)
    if len(y) == 0:
        return JSONResponse({"error": "empty segment"}, status_code=400)

    # Downsample to ~2kHz for consistency and speed
    y, sr = _decimate_to_2k(y, sr)

    # Cache lookup (if hash provided)
    cache_hash = (hash or '').strip()
    if cache_hash:
        try:
            headers = {'Authorization': authorization} if authorization else {}
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{ANALYSIS_BASE}/cache/{cache_hash}", headers=headers)
                if r.status_code == 200:
                    j = r.json()
                    smid = j.get('spec_media_id')
                    if smid:
                        mr = await client.get(f"{MEDIA_BASE}/file/{smid}", headers=headers)
                        if mr.status_code == 200:
                            hdr = { 'X-Cache': 'HIT', 'X-Compute-Time': '0.00', 'X-STFT-Time': '0.00', 'X-Plot-Time': '0.00' }
                            return Response(content=mr.content, media_type='image/png', headers=hdr)
        except Exception:
            pass

    # Spectrogram via STFT (on ~2kHz)
    n_fft = 1024
    hop = n_fft // 4
    # STFT
    window = np.hanning(n_fft).astype(np.float32)
    num_frames = 1 + (len(y) - n_fft) // hop if len(y) >= n_fft else 1
    frames = []
    t0_stft = time.perf_counter()
    for i in range(num_frames):
        start = i * hop
        seg = y[start:start + n_fft]
        if len(seg) < n_fft:
            pad = np.zeros(n_fft, dtype=np.float32)
            pad[:len(seg)] = seg
            seg = pad
        frames.append(np.fft.rfft(seg * window))
    t1_stft = time.perf_counter()
    S = np.abs(np.stack(frames, axis=1))  # (freq_bins, time)
    S /= (np.max(S) + 1e-9)
    S_db = 20.0 * np.log10(S + 1e-6)
    freqs = np.fft.rfftfreq(n_fft, d=1.0/sr)
    if maxFreq and maxFreq > 0:
        idx = np.where(freqs <= maxFreq)[0]
        S_db = S_db[idx, :]

    # Time axis in seconds
    times = np.arange(S_db.shape[1]) * (hop / sr)
    f = np.fft.rfftfreq(n_fft, d=1.0/sr)
    if maxFreq and maxFreq > 0:
        f = f[f <= maxFreq]
    extent = [0, times[-1] if len(times) else 0, f[0] if len(f) else 0, f[-1] if len(f) else (sr/2)]

    t0_plot = time.perf_counter()
    fig, ax = plt.subplots(figsize=(width/100, height/100), dpi=100)
    im = ax.imshow(S_db, origin='lower', aspect='auto', cmap='magma', extent=extent)
    ax.set_xlabel('Time (s)')
    ax.set_ylabel('Frequency (Hz)')
    ax.grid(color='w', alpha=0.2, linewidth=0.5)
    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label('Magnitude (dB)')
    plt.tight_layout(pad=0.2)
    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=100, bbox_inches='tight', pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    t1_all = time.perf_counter()
    # Timings
    stft_ms = (t1_stft - t0_stft) * 1000.0
    plot_ms = (time.perf_counter() - t0_plot) * 1000.0
    total_ms = (t1_all - t0_all) * 1000.0
    headers = {
        'X-Compute-Time': f"{total_ms:.2f}",
        'X-STFT-Time': f"{stft_ms:.2f}",
        'X-Plot-Time': f"{plot_ms:.2f}",
    }
    return Response(content=buf.read(), media_type='image/png', headers=headers)


@app.post('/features_media')
async def features_media(
    mediaId: str = Body(...),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    sr, y, err = await _fetch_wav_and_decode(mediaId, authorization)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    # reuse compute_features_pcm core
    # minimal inline copy to avoid refactor
    n = len(y)
    dur = n / sr
    rms = float(np.sqrt(np.mean(y**2)))
    zc = float(np.mean(np.abs(np.diff(np.sign(y)))))/2.0 * sr/len(y) * len(y)/sr
    n_fft = 1024
    hop = 256
    window = np.hanning(n_fft).astype(np.float32)
    frames = []
    for i in range(0, max(len(y)-n_fft, 0)+1, hop):
        seg = y[i:i+n_fft]
        if len(seg) < n_fft:
            pad = np.zeros(n_fft, dtype=np.float32)
            pad[:len(seg)] = seg
            seg = pad
        spec = np.abs(np.fft.rfft(seg * window))
        frames.append(spec)
    if not frames:
        frames = [np.abs(np.fft.rfft(np.pad(y, (0, max(0, n_fft-len(y)))), n=n_fft))]
    S = np.stack(frames, axis=1)
    S_power = S ** 2
    freqs = np.fft.rfftfreq(n_fft, d=1.0/sr)
    mag_sum = S_power.sum(axis=0) + 1e-9
    centroid = float(np.mean((freqs[:, None] * S_power).sum(axis=0) / mag_sum))
    bandwidth = float(np.mean(np.sqrt((((freqs[:, None] - centroid) ** 2) * S_power).sum(axis=0) / mag_sum)))
    cumsum = np.cumsum(S_power, axis=0)
    total = cumsum[-1, :]
    roll_idx = np.array([np.searchsorted(cumsum[:, i], 0.95 * total[i]) for i in range(S_power.shape[1])])
    rolloff = float(np.mean(freqs[roll_idx]))
    flatness = float(np.mean(np.exp(np.mean(np.log(S_power + 1e-9), axis=0) / (np.mean(S_power, axis=0) + 1e-9))))
    flux = float(np.mean(np.sqrt(np.sum(np.diff(S, axis=1, prepend=S[:, :1]) ** 2, axis=0))))
    peak = float(np.max(np.abs(y)))
    crest = float(peak / (rms + 1e-9))
    return {
        "sampleRate": sr,
        "durationSec": dur,
        "rms": rms,
        "zcrPerSec": zc,
        "spectralCentroid": centroid,
        "spectralBandwidth": bandwidth,
        "rolloff95": rolloff,
        "spectralFlatness": flatness,
        "spectralFlux": flux,
        "peak": peak,
        "crestFactor": crest,
    }


@app.post('/pcg_quality_pcm')
async def pcg_quality_pcm(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...)
):
    sr = int(sampleRate)
    y = np.asarray(pcm, dtype=np.float32)
    if len(y) == 0 or sr <= 0:
        return JSONResponse({ 'isHeart': False, 'qualityOk': False, 'score': 0.0, 'issues': ['empty'], 'metrics': {} })
    res = _pcg_quality_core(y, sr)
    return JSONResponse(content=res)


@app.post('/pcg_quality_media')
async def pcg_quality_media(
    mediaId: str = Body(...),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    sr, y, err = await _fetch_wav_and_decode(mediaId, authorization)
    if err:
        return JSONResponse({ 'isHeart': False, 'qualityOk': False, 'score': 0.0, 'issues': ['media_error'], 'error': err, 'metrics': {} }, status_code=400)
    res = _pcg_quality_core(y, sr)
    return JSONResponse(content=res)


@app.post('/spectrogram_media')
async def spectrogram_media(
    mediaId: str = Body(...),
    width: int = Body(1400),
    height: int = Body(320),
    maxFreq: Optional[int] = Body(2000),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    t0_all = time.perf_counter()
    sr, y, err = await _fetch_wav_and_decode(mediaId, authorization)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    # Downsample to ~2kHz
    y, sr = _decimate_to_2k(y, sr)
    # reuse spectrogram code
    n_fft = 1024
    hop = n_fft // 4
    window = np.hanning(n_fft).astype(np.float32)
    num_frames = 1 + (len(y) - n_fft) // hop if len(y) >= n_fft else 1
    frames = []
    t0_stft = time.perf_counter()
    for i in range(num_frames):
        start = i * hop
        seg = y[start:start + n_fft]
        if len(seg) < n_fft:
            pad = np.zeros(n_fft, dtype=np.float32)
            pad[:len(seg)] = seg
            seg = pad
        frames.append(np.fft.rfft(seg * window))
    t1_stft = time.perf_counter()
    S = np.abs(np.stack(frames, axis=1))
    S /= (np.max(S) + 1e-9)
    S_db = 20.0 * np.log10(S + 1e-6)
    freqs = np.fft.rfftfreq(n_fft, d=1.0/sr)
    if maxFreq and maxFreq > 0:
        idx = np.where(freqs <= maxFreq)[0]
        S_db = S_db[idx, :]
    times = np.arange(S_db.shape[1]) * (hop / sr)
    f = np.fft.rfftfreq(n_fft, d=1.0/sr)
    if maxFreq and maxFreq > 0:
        f = f[f <= maxFreq]
    extent = [0, times[-1] if len(times) else 0, f[0] if len(f) else 0, f[-1] if len(f) else (sr/2)]
    t0_plot = time.perf_counter()
    fig, ax = plt.subplots(figsize=(width/100, height/100), dpi=100)
    im = ax.imshow(S_db, origin='lower', aspect='auto', cmap='magma', extent=extent)
    ax.set_xlabel('Time (s)'); ax.set_ylabel('Frequency (Hz)')
    ax.grid(color='w', alpha=0.2, linewidth=0.5)
    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label('Magnitude (dB)')
    plt.tight_layout(pad=0.2)
    buf = io.BytesIO(); fig.savefig(buf, format='png', dpi=100, bbox_inches='tight', pad_inches=0); plt.close(fig)
    buf.seek(0)
    t1_all = time.perf_counter()
    stft_ms = (t1_stft - t0_stft) * 1000.0
    plot_ms = (time.perf_counter() - t0_plot) * 1000.0
    total_ms = (t1_all - t0_all) * 1000.0
    headers = {
        'X-Compute-Time': f"{total_ms:.2f}",
        'X-STFT-Time': f"{stft_ms:.2f}",
        'X-Plot-Time': f"{plot_ms:.2f}",
    }
    return Response(content=buf.read(), media_type='image/png', headers=headers)


@app.post('/pcg_advanced_media')
async def pcg_advanced_media(
    payload: dict = Body(...),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    # Accept multiple shapes: {mediaId}, {media_id}, {id}
    mediaId = None
    try:
        mediaId = payload.get('mediaId') or payload.get('media_id') or payload.get('id')
    except Exception:
        mediaId = None
    sr, y, err = await _fetch_wav_and_decode(mediaId, authorization)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    # Reuse pcg_advanced core by calling the function directly
    # Inline a light wrapper via existing endpoint code path
    # We duplicate minimal logic by calling pcg_advanced internal computation
    # For brevity, we send through /pcg_advanced code by constructing body is not trivial here; replicate below
    # Apply the same decimation logic as pcg_advanced
    # Ensure ~2kHz
    y, sr = _decimate_to_2k(y, sr)
    # Prefer provided hash (from client) to align cross-endpoint caching
    cache_hash = None
    try:
        provided = payload.get('hash')
        if isinstance(provided, str) and len(provided) >= 32:
            cache_hash = provided
    except Exception:
        cache_hash = None
    if not cache_hash:
        # Compute a stable hash of the decimated signal
        cache_hash = _sha256_hex_of_floats(y, sr)
    # Now reuse the original function body by simple local call
    # Build a minimal shim: call analyze_pcg_from_pcm for hard metrics? keep our heuristic version
    # Here we call the same code path as pcg_advanced (heuristic)
    # To avoid duplicate implementation, we call the function below inline (copy kept in file)
    useHsmm = False
    try:
        useHsmm = bool(payload.get('useHsmm'))
    except Exception:
        useHsmm = False
    return await pcg_advanced(sampleRate=sr, pcm=y.tolist(), hash=cache_hash, useHsmm=useHsmm, authorization=authorization)


@app.post('/hard_algo_metrics_media')
async def hard_algo_metrics_media(
    mediaId: str = Body(...),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    sr, y, err = await _fetch_wav_and_decode(mediaId, authorization)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    try:
        m = analyze_pcg_from_pcm(sr, y.tolist())
        return m
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post('/features_pcm')
async def compute_features_pcm(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...)
):
    y = np.asarray(pcm, dtype=np.float32)
    sr = int(sampleRate)
    n = len(y)
    if n == 0:
        return JSONResponse({"error": "empty"}, status_code=400)
    dur = n / sr
    rms = float(np.sqrt(np.mean(y**2)))
    zc = float(np.mean(np.abs(np.diff(np.sign(y)))))/2.0 * sr/len(y) * len(y)/sr  # approx crossings/sec
    # spectral features via FFT over frames
    n_fft = 1024
    hop = 256
    window = np.hanning(n_fft).astype(np.float32)
    frames = []
    for i in range(0, max(len(y)-n_fft, 0)+1, hop):
        seg = y[i:i+n_fft]
        if len(seg) < n_fft:
            pad = np.zeros(n_fft, dtype=np.float32)
            pad[:len(seg)] = seg
            seg = pad
        spec = np.abs(np.fft.rfft(seg * window))
        frames.append(spec)
    if not frames:
        frames = [np.abs(np.fft.rfft(np.pad(y, (0, max(0, n_fft-len(y)))), n=n_fft))]
    S = np.stack(frames, axis=1)
    S_power = S ** 2
    freqs = np.fft.rfftfreq(n_fft, d=1.0/sr)
    mag_sum = np.sum(S_power, axis=0) + 1e-9
    centroid = float(np.mean(np.sum(freqs[:, None] * S_power, axis=0) / mag_sum))
    bandwidth = float(np.mean(np.sqrt(np.sum(((freqs[:, None] - centroid) ** 2) * S_power, axis=0) / mag_sum)))
    cumsum = np.cumsum(S_power, axis=0)
    total = cumsum[-1, :]
    roll_idx = np.array([np.searchsorted(cumsum[:, i], 0.95 * total[i]) for i in range(S_power.shape[1])])
    rolloff = float(np.mean(freqs[roll_idx]))
    flatness = float(np.mean(np.exp(np.mean(np.log(S_power + 1e-9), axis=0)) / (np.mean(S_power, axis=0) + 1e-9)))
    flux = float(np.mean(np.sqrt(np.sum(np.diff(S, axis=1, prepend=S[:, :1]) ** 2, axis=0))))
    peak = float(np.max(np.abs(y)))
    crest = float(peak / (rms + 1e-9))
    return {
        "sampleRate": sr,
        "durationSec": dur,
        "rms": rms,
        "zcrPerSec": zc,
        "spectralCentroid": centroid,
        "spectralBandwidth": bandwidth,
        "rolloff95": rolloff,
        "spectralFlatness": flatness,
        "spectralFlux": flux,
        "peak": peak,
        "crestFactor": crest,
    }


def _moving_average(x: np.ndarray, win: int):
    if win <= 1:
        return x.copy()
    win = int(win)
    c = np.cumsum(np.insert(np.abs(x), 0, 0))
    m = (c[win:] - c[:-win]) / float(win)
    # pad to original length
    pad_left = win // 2
    pad_right = len(x) - len(m) - pad_left
    return np.pad(m, (pad_left, pad_right), mode='edge')


def _find_peaks(x: np.ndarray, distance: int, threshold: float):
    peaks = []
    n = len(x)
    i = distance
    while i < n - distance:
        seg = x[i - distance:i + distance + 1]
        if x[i] == seg.max() and x[i] >= threshold:
            peaks.append(i)
            i += distance
        i += 1
    return peaks


def _tkeo(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32, copy=False)
    if len(x) < 3:
        return np.zeros_like(x)
    y = np.zeros_like(x)
    y[1:-1] = x[1:-1] * x[1:-1] - x[:-2] * x[2:]
    return np.maximum(0.0, y)


def _shannon_envelope(x: np.ndarray, sr: int, smooth_ms: float = 50.0) -> np.ndarray:
    # Shannon energy operator: -x^2 * log(x^2)
    e = x.astype(np.float32, copy=False)
    e = e * e
    e = -(e * (np.log(e + 1e-9)))
    win = max(1, int(round(smooth_ms * 1e-3 * sr)))
    w = np.ones(win, dtype=np.float32) / float(win)
    return np.convolve(e, w, mode='same')


def _respiration_from_env(env: np.ndarray, sr: int):
    # Downsample env to ~20 Hz then estimate dominant frequency 0.08–0.8 Hz
    target = 20
    k = max(1, int(round(sr / target)))
    z = env[::k].astype(np.float32, copy=False)
    fs = sr / k
    n = len(z)
    nfft = 1 << int(np.ceil(np.log2(max(64, n))))
    spec = np.abs(np.fft.rfft(z * np.hanning(len(z)), n=nfft))
    freqs = np.fft.rfftfreq(nfft, d=1.0 / fs)
    band = (freqs >= 0.08) & (freqs <= 0.8)
    if not np.any(band):
        return (None, 0.0), z, fs
    sb = spec[band]
    fi = np.argmax(sb)
    freq = float(freqs[band][fi])
    rate = freq * 60.0
    dom = float(sb[fi] / (np.mean(sb) + 1e-9))
    return (rate, dom), z, fs


def _corr_at_events(series: np.ndarray, fs: float, event_idx: list) -> float:
    if not event_idx or len(event_idx) < 3:
        return 0.0
    t = np.array(event_idx, dtype=np.int64) / fs
    # sample series at event times using nearest index
    idx = np.clip((t * fs).astype(np.int64), 0, len(series) - 1)
    vals = series[idx]
    # correlate consecutive pairs against linear ramp
    x = np.arange(len(vals), dtype=np.float32)
    if np.std(vals) < 1e-6:
        return 0.0
    r = float(np.corrcoef(x, vals)[0, 1])
    return r


@app.post('/pcg_advanced')
async def pcg_advanced(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...),
    hash: Optional[str] = Body(None),
    useHsmm: bool = Body(False),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    # Heuristic CPU-only PCG analysis modules (baseline, non-diagnostic)
    import time as _time
    _t0_all = _time.perf_counter()
    sr = int(sampleRate)
    y = np.asarray(pcm, dtype=np.float32)
    n = len(y)
    if n == 0 or sr <= 0:
        return JSONResponse({"error": "empty"}, status_code=400)

    # Optional decimation for performance: downsample to ~2000 Hz max
    # PCG metrics here mostly rely on bands < 600 Hz and envelope timing
    # This simple decimator (box filter + pick every k-th sample) avoids SciPy dependency
    target_sr = 2000
    if sr > target_sr:
        k = max(1, int(round(sr / target_sr)))
        if k > 1:
            # box filter to mitigate aliasing
            win = min(len(y), k)
            if win > 1:
                box = np.ones(win, dtype=np.float32) / float(win)
                y = np.convolve(y, box, mode='same').astype(np.float32)
            y = y[::k]
            sr = int(round(sr / k))
            n = len(y)

    dur = n / sr
    # Envelope
    env = _moving_average(y, max(1, int(0.05 * sr)))
    env = env / (np.max(np.abs(env)) + 1e-9)

    # HR estimation by autocorrelation of envelope
    ac = np.correlate(env, env, mode='full')[n-1: n-1 + int(1.5*sr)]
    min_lag = int(0.4 * sr)  # 150 bpm upper
    max_lag = int(1.5 * sr)  # 40 bpm lower
    peak_lag = None
    if max_lag > min_lag + 5:
        lag_seg = ac[min_lag:max_lag]
        lag_idx = np.argmax(lag_seg)
        peak_lag = min_lag + lag_idx
    hr_bpm = 60.0 * sr / peak_lag if peak_lag else None

    # Peak picking and S1/S2 assignment (HSMM optional)
    if useHsmm:
        try:
            m = segment_pcg_hsmm(sr, y.tolist())
            s1_idx = list(map(int, m.get('events', {}).get('s1', []) or []))
            s2_idx = list(map(int, m.get('events', {}).get('s2', []) or []))
            if not hr_bpm:
                hb = m.get('hrBpm')
                try:
                    hr_bpm = float(hb) if hb else None
                except Exception:
                    pass
        except Exception:
            s1_idx = []
            s2_idx = []
    else:
        thr = max(0.2, float(np.median(env) + 0.5 * np.std(env)))
        min_dist = int(0.2 * sr)
        cand = _find_peaks(env, distance=min_dist, threshold=thr)
        # Assign as alternating S1/S2 using expected cycle
        s1_idx = []
        s2_idx = []
        if hr_bpm:
            cycle = sr * 60.0 / hr_bpm
        else:
            cycle = sr * 0.8
        i = 0
        last_was_s1 = True
        while i < len(cand):
            if not s1_idx:
                s1_idx.append(cand[i]); last_was_s1 = True; i += 1; continue
            dt = cand[i] - (s1_idx[-1] if last_was_s1 else s2_idx[-1])
            if dt < 0.7 * cycle:  # likely within the same cycle -> S2
                if last_was_s1:
                    s2_idx.append(cand[i]); last_was_s1 = False
                else:
                    s1_idx.append(cand[i]); last_was_s1 = True
            else:  # new cycle -> S1
                s1_idx.append(cand[i]); last_was_s1 = True
            i += 1

        s1_idx = sorted(set(s1_idx))
        s2_idx = sorted(set(s2_idx))

    # Cycle metrics
    rr = []
    systoles = []
    diastoles = []
    if len(s1_idx) >= 2:
        rr = np.diff(np.array(s1_idx)) / sr
    # systole: S1 -> nearest S2 after S1 within 0.7*cycle
    for s1 in s1_idx:
        later_s2 = [p for p in s2_idx if p > s1]
        if not later_s2:
            continue
        s2 = later_s2[0]
        st = (s2 - s1) / sr
        if st > 0 and st < 0.8:
            systoles.append(st)
    # diastole: S2 -> next S1
    for s2 in s2_idx:
        next_s1 = [p for p in s1_idx if p > s2]
        if not next_s1:
            continue
        d = (next_s1[0] - s2) / sr
        if d > 0:
            diastoles.append(d)
    ds_ratio = (np.mean(diastoles) / np.mean(systoles)) if (len(systoles) and len(diastoles)) else None

    # S2 split (A2-P2) in 12–80 ms window: double-peak on high-freq envelope
    def s2_split_for(idx):
        w = int(0.12 * sr)
        s = max(0, idx - int(0.02*sr))
        e = min(n, idx + w)
        seg = y[s:e]
        # high-frequency emphasis via first difference
        hf = _moving_average(np.abs(np.diff(seg, prepend=seg[:1])), max(1, int(0.004*sr)))
        # find two peaks between 12-80ms after S2
        start = idx + int(0.012*sr) - s
        end = min(len(hf), idx + int(0.08*sr) - s)
        if end - start < 3:
            return None
        sub = hf[start:end]
        # largest two peaks
        if len(sub) < 3: return None
        p1 = np.argmax(sub)
        sub2 = sub.copy(); sub2[max(0,p1-3):p1+4] = 0
        p2 = np.argmax(sub2)
        if sub[p2] < 0.3 * sub[p1]:
            return None
        dms = abs(p2 - p1) * 1000.0 / sr
        if 12 <= dms <= 80:
            return dms
        return None

    s2_splits = [s2_split_for(i) for i in s2_idx]
    s2_splits = [v for v in s2_splits if v is not None]

    # A2-OS: 40–120 ms after S2, transient detection
    def a2_os_for(idx):
        s = idx + int(0.04*sr)
        e = idx + int(0.12*sr)
        if s >= n: return None
        e = min(n, e)
        seg = np.abs(y[s:e])
        if len(seg) < 5: return None
        peak_i = np.argmax(seg)
        if seg[peak_i] > (np.median(seg) + 3*np.std(seg)):
            return (peak_i) * 1000.0 / sr
        return None

    a2_os = [a2_os_for(i) for i in s2_idx]
    a2_os = [v for v in a2_os if v is not None]

    # Intensities
    s1_int = float(np.mean([env[i] for i in s1_idx])) if s1_idx else None
    s2_int = float(np.mean([env[i] for i in s2_idx])) if s2_idx else None

    # Murmur metrics: high-frequency energy ratio in systole/diastole (150–600 Hz)
    def band_energy(start_idx, end_idx):
        if end_idx <= start_idx: return 0.0
        seg = y[start_idx:end_idx]
        if len(seg) <= 16: return 0.0
        # simple Welch-like: split into frames
        hop = max(16, int(0.01*sr)); win = max(32, int(0.02*sr))
        total = 0.0
        frames = 0
        for k in range(0, len(seg)-win, hop):
            wseg = seg[k:k+win] * np.hanning(win)
            sp = np.fft.rfft(wseg)
            freqs = np.fft.rfftfreq(win, 1.0/sr)
            mask = (freqs >= 150) & (freqs <= 600)
            total += float(np.sum(np.abs(sp[mask])**2))
            frames += 1
        return total / (frames+1e-9)

    sys_energy = None
    dia_energy = None
    if systoles and s1_idx and s2_idx:
        pairs = min(len(s1_idx), len(s2_idx))
        es = []; ed = []
        for j in range(pairs):
            s1 = s1_idx[j]
            s2 = s2_idx[j] if j < len(s2_idx) else None
            if s2 and s2 > s1:
                es.append(band_energy(s1, s2))
                next_s1 = s1_idx[j+1] if j+1 < len(s1_idx) else None
                if next_s1 and next_s1 > s2:
                    ed.append(band_energy(s2, next_s1))
        if es: sys_energy = float(np.mean(es))
        if ed: dia_energy = float(np.mean(ed))

    # Systolic shape: rising / falling / flat based on envelope trend over systole
    sys_shape = None
    if systoles and s1_idx and s2_idx:
        slopes = []
        pairs = min(len(s1_idx), len(s2_idx))
        for j in range(pairs):
            s1 = s1_idx[j]; s2 = s2_idx[j]
            if s2 > s1:
                seg = env[s1:s2]
                if len(seg) > 5:
                    coef = np.polyfit(np.linspace(0,1,len(seg)), seg, 1)[0]
                    slopes.append(coef)
        if slopes:
            m = float(np.mean(slopes))
            if m > 0.02: sys_shape = 'crescendo'
            elif m < -0.02: sys_shape = 'decrescendo'
            else: sys_shape = 'plateau'

    # QC: SNR (simple band ratio), motion/resp artifacts (LF proportion), usable pct (envelope > thresh)
    # SNR: 25–400 Hz vs 0–25 Hz power
    def band_power_whole(lo, hi):
        win = 1024 if n >= 2048 else max(128, 1<<(int(np.log2(n)) - 1))
        hop = win//2
        total=0.0; frames=0
        for k in range(0, n-win, hop):
            wseg = y[k:k+win]*np.hanning(win)
            sp = np.fft.rfft(wseg)
            freqs = np.fft.rfftfreq(win,1.0/sr)
            mask=(freqs>=lo)&(freqs<=hi)
            total += float(np.sum(np.abs(sp[mask])**2)); frames+=1
        return total/(frames+1e-9)
    sig = band_power_whole(25,400)
    noise = band_power_whole(0,25)
    snr_db = 10.0*np.log10((sig+1e-9)/(noise+1e-9))

    # motion/resp artifacts proportion: LF envelope variance
    env_lf = _moving_average(env, max(1,int(0.3*sr)))
    art = np.mean((env_lf - np.median(env_lf))**2)
    base = np.mean((env - np.median(env))**2) + 1e-9
    motion_pct = float(min(1.0, max(0.0, art/base)))

    usable_pct = float(np.mean(env > (np.median(env)+0.1*np.std(env))))

    # Respiratory rate estimation and S2 split typing
    resp_rate = None; resp_dom = None; split_type = None; split_corr = None
    try:
        # Use a smoothed envelope to estimate respiration
        env_lf2 = _moving_average(env, max(1, int(0.5 * sr)))
        (rr_est, rr_dom), env_ds, fs_ds = _respiration_from_env(env_lf2, sr)
        if rr_est:
            resp_rate = float(rr_est)
            resp_dom = float(rr_dom)
        # Correlate S2 split with respiration envelope sampled at S2 indices
        if s2_splits and s2_idx:
            split_corr = _corr_at_events(env_ds, fs_ds, s2_idx[:len(env_ds)])
            ms = np.array(s2_splits, dtype=np.float32)
            mean_split = float(np.median(ms)) if len(ms) else None
            std_split = float(np.std(ms)) if len(ms) else None
            if mean_split:
                if mean_split > 50.0:
                    split_type = 'wide'
                elif std_split is not None and std_split < 10.0 and mean_split > 30.0:
                    split_type = 'fixed'
                elif split_corr is not None and split_corr > 0.2:
                    split_type = 'physiologic'
                elif split_corr is not None and split_corr < -0.2:
                    split_type = 'paradoxical'
                else:
                    split_type = 'indeterminate'
    except Exception:
        pass

    # Additional sounds: S3/S4 detection using low-band energy + TKEO in specific windows
    def _detect_extra_sounds():
        s3_hits=0; s4_hits=0; s3_scores=[]; s4_scores=[]
        ec_hits=0; msc_hits=0; os_hits=len(a2_os)
        ec_scores=[]; msc_scores=[]
        # Precompute helper envelopes
        tke = _tkeo(y)
        for j in range(min(len(s1_idx), len(s2_idx))):
            s1i = s1_idx[j]; s2i = s2_idx[j]
            # S3: 80–200 ms after S2
            w3a = s2i + int(0.08*sr); w3b = min(n, s2i + int(0.20*sr))
            if w3b - w3a > int(0.03*sr):
                seg = y[w3a:w3b]
                e_low = _welch_band_power(seg, sr, 20, 100)
                base = _welch_band_power(y[max(0,w3b-int(0.2*sr)):w3b], sr, 20, 100)
                score = e_low / (base + 1e-9)
                if score > 2.5:
                    s3_hits += 1; s3_scores.append(score)
            # S4: 60–120 ms before S1
            w4a = max(0, s1i - int(0.12*sr)); w4b = max(0, s1i - int(0.06*sr))
            if w4b - w4a > int(0.03*sr):
                seg = y[w4a:w4b]
                e_low = _welch_band_power(seg, sr, 20, 100)
                base = _welch_band_power(y[w4a:max(0,w4a-int(0.2*sr))], sr, 20, 100)
                score = e_low / (base + 1e-9)
                if score > 2.5:
                    s4_hits += 1; s4_scores.append(score)
            # Ejection click: 20–60 ms after S1, HF transient
            eca = s1i + int(0.02*sr); ecb = min(n, s1i + int(0.06*sr))
            if ecb - eca > int(0.01*sr):
                seg = tke[eca:ecb]
                if seg.size:
                    z = (seg - np.median(seg)) / (np.std(seg)+1e-9)
                    sc = float(np.max(z))
                    if sc > 3.0:
                        ec_hits += 1; ec_scores.append(sc)
            # Mid-systolic click: mid of systole ±10ms
            if s2i > s1i:
                mid = s1i + int(0.5 * (s2i - s1i))
                msa = max(0, mid - int(0.01*sr)); msb = min(n, mid + int(0.01*sr))
                if msb > msa:
                    seg = tke[msa:msb]
                    z = (seg - np.median(seg)) / (np.std(seg)+1e-9)
                    sc = float(np.max(z))
                    if sc > 3.0:
                        msc_hits += 1; msc_scores.append(sc)
        cycles = max(1, min(len(s1_idx), len(s2_idx)))
        return {
            's3Prob': float(min(1.0, s3_hits / cycles)),
            's4Prob': float(min(1.0, s4_hits / cycles)),
            's3Cycles': int(s3_hits),
            's4Cycles': int(s4_hits),
            'ejectionClickProb': float(min(1.0, ec_hits / cycles)),
            'midSystolicClickProb': float(min(1.0, msc_hits / cycles)),
            'openingSnapProb': float(min(1.0, len(a2_os) / max(1,len(s2_idx))))
        }

    extras_sounds = _detect_extra_sounds()

    # Murmur characterization
    def _murmur_characterization():
        sys_present=False; dia_present=False
        sys_shape_local=None; dia_shape_local=None
        sys_pitch=None; dia_pitch=None
        sys_ratio=None; dia_ratio=None
        cover = 0.0
        # For each cycle compute high-band energy envelope and decide
        shapes=[]; pitches=[]; coverages=[]; ratios=[]
        for j in range(min(len(s1_idx), len(s2_idx))):
            s1i = s1_idx[j]; s2i = s2_idx[j]
            if s2i <= s1i: continue
            seg = y[s1i:s2i]
            # frame-based energy in 150–400 Hz
            hop = max(8, int(0.01*sr)); win = max(16, int(0.02*sr))
            e=[]; cents=[]
            for k in range(0, len(seg)-win, hop):
                wseg = seg[k:k+win] * np.hanning(win)
                sp = np.abs(np.fft.rfft(wseg))
                freqs = np.fft.rfftfreq(win, 1.0/sr)
                m = (freqs>=150)&(freqs<=400)
                pw = (sp[m]**2).sum()
                e.append(pw)
                if pw>0:
                    cents.append((freqs[m]*(sp[m]**2)).sum()/pw)
            if len(e)<3: continue
            e = np.array(e, dtype=np.float32)
            e = e/(np.max(e)+1e-9)
            # threshold by median+0.3*std
            th = float(np.median(e)+0.3*np.std(e))
            active = e>th
            frac = float(np.mean(active))
            if frac>0.3:
                sys_present=True
                coverages.append(frac)
                # shape via slope
                slope = float(np.polyfit(np.linspace(0,1,len(e)), e, 1)[0])
                if slope>0.05: shapes.append('crescendo')
                elif slope<-0.05: shapes.append('decrescendo')
                else: shapes.append('plateau')
                if cents:
                    pitches.append(float(np.median(cents)))
                # ratio
                be = band_power_whole(150,400)
                le = band_power_whole(20,150)
                if le>0: ratios.append(float(be/le))
        if shapes:
            # pick most common
            sys_shape_local = max(set(shapes), key=shapes.count)
        if pitches:
            sys_pitch = float(np.median(pitches))
        if ratios:
            sys_ratio = float(np.median(ratios))
        if coverages:
            cover = float(np.median(coverages))
        # Diastolic (same steps)
        dshapes=[]; dpitches=[]; dratios=[]; dcover=[]
        for j in range(min(len(s1_idx)-1, len(s2_idx))):
            s2i = s2_idx[j]; s1n = s1_idx[j+1]
            if s1n <= s2i: continue
            seg = y[s2i:s1n]
            hop = max(8, int(0.01*sr)); win = max(16, int(0.02*sr))
            e=[]; cents=[]
            for k in range(0, len(seg)-win, hop):
                wseg = seg[k:k+win] * np.hanning(win)
                sp = np.abs(np.fft.rfft(wseg))
                freqs = np.fft.rfftfreq(win, 1.0/sr)
                m = (freqs>=150)&(freqs<=400)
                pw = (sp[m]**2).sum()
                e.append(pw)
                if pw>0:
                    cents.append((freqs[m]*(sp[m]**2)).sum()/pw)
            if len(e)<3: continue
            e = np.array(e, dtype=np.float32); e = e/(np.max(e)+1e-9)
            th = float(np.median(e)+0.3*np.std(e))
            active = e>th
            frac = float(np.mean(active))
            if frac>0.3:
                dia_present=True; dcover.append(frac)
                slope = float(np.polyfit(np.linspace(0,1,len(e)), e, 1)[0])
                if slope>0.05: dshapes.append('crescendo')
                elif slope<-0.05: dshapes.append('decrescendo')
                else: dshapes.append('plateau')
                if cents: dpitches.append(float(np.median(cents)))
                be = band_power_whole(150,400); le = band_power_whole(20,150)
                if le>0: dratios.append(float(be/le))
        if dshapes:
            dia_shape_local = max(set(dshapes), key=dshapes.count)
        if dpitches:
            dia_pitch = float(np.median(dpitches))
        if dratios:
            dia_ratio = float(np.median(dratios))
        dcover_m = float(np.median(dcover)) if dcover else 0.0
        return {
            'present': bool(sys_present or dia_present),
            'phase': ('systolic' if sys_present else '') + ('/diastolic' if dia_present else ''),
            'systolic': {
                'present': bool(sys_present),
                'extent': 'holo' if cover>0.8 else ('early' if cover<=0.4 else ('mid' if cover<=0.6 else 'late')),
                'shape': sys_shape_local,
                'pitchHz': sys_pitch,
                'bandRatio': sys_ratio,
                'coverage': cover,
            },
            'diastolic': {
                'present': bool(dia_present),
                'extent': 'holo' if dcover_m>0.8 else ('early' if dcover_m<=0.4 else ('mid' if dcover_m<=0.6 else 'late')),
                'shape': dia_shape_local,
                'pitchHz': dia_pitch,
                'bandRatio': dia_ratio,
                'coverage': dcover_m,
            }
        }

    extras_murmur = _murmur_characterization()
    # Add simple grade proxy (0-3) and confidence (0..1)
    def _grade_and_conf(m):
        sys = m.get('systolic') or {}; dia = m.get('diastolic') or {}
        def side(s):
            cov = float(s.get('coverage') or 0.0); br = float(s.get('bandRatio') or 0.0)
            return cov * br
        raw = max(side(sys), side(dia))
        # thresholds for grades
        if raw < 0.1: grade = 0
        elif raw < 0.3: grade = 1
        elif raw < 0.6: grade = 2
        else: grade = 3
        # confidence: bounded by QC and consistency
        conf = float(min(1.0, max(0.0, (snr_db + 5.0)/15.0))) * float(min(1.0, max(0.0, usable_pct)))
        return grade, conf
    grade, mconf = _grade_and_conf(extras_murmur)
    extras_murmur['gradeProxy'] = int(grade)
    extras_murmur['confidence'] = float(mconf)

    # S1/S2 durations (width at 25% local peak within ±50ms window)
    def _event_width_ms(idx_list):
        ws = []
        half = int(0.05 * sr)
        for i in idx_list:
            a = max(0, i - half); b = min(n, i + half)
            seg = env[a:b]
            if seg.size < 3: continue
            th = 0.25 * float(np.max(seg))
            # find contiguous region around i above th
            left = i
            while left > a and env[left] >= th:
                left -= 1
            right = i
            while right < b and env[right] >= th:
                right += 1
            ws.append((right - left) / sr * 1000.0)
        return float(np.median(ws)) if ws else None
    s1_dur_ms = _event_width_ms(s1_idx)
    s2_dur_ms = _event_width_ms(s2_idx)

    # Rhythm screening: AF/ectopy suspicion using RR series
    af_suspected=False; ectopy_suspected=False
    rr_cv = float(np.std(rr)/ (np.mean(rr)+1e-9)) if len(rr) else None
    pnn50 = None
    sampen = None
    sd1 = None; sd2 = None
    if len(rr):
        diffs = np.abs(np.diff(rr))
        pnn50 = float(np.mean(diffs > 0.05))
        # Poincare
        sd1 = float(np.sqrt(0.5*np.var(np.diff(rr))))
        sd2 = float(np.sqrt(2*np.var(rr) - 0.5*np.var(np.diff(rr)))) if len(rr)>1 else None
        # Approximate sample entropy (m=2, r=0.2*std)
        try:
            r = 0.2*np.std(rr) + 1e-9
            def _phi(m):
                N=len(rr)
                if N<=m+1: return 0.0
                count=0; total=0
                for i in range(N-m):
                    for j in range(i+1, N-m):
                        if np.max(np.abs(rr[i:i+m]-rr[j:j+m]))<r:
                            count+=1
                    total += (N-m-1-i)
                return count/(total+1e-9)
            a=_phi(2); b=_phi(3)
            sampen = float(-np.log((b+1e-12)/(a+1e-12)))
        except Exception:
            sampen=None
        # Rules of thumb (screening only)
        if (rr_cv and rr_cv>0.2) and (pnn50 and pnn50>0.2) and (sampen and sampen>0.5):
            af_suspected=True
        if (pnn50 and 0.1<pnn50<0.3) and (rr_cv and rr_cv>0.12) and not af_suspected:
            ectopy_suspected=True

    _result = {
        'durationSec': dur,
        'hrBpm': float(hr_bpm) if hr_bpm else None,
        'rrMeanSec': float(np.mean(rr)) if len(rr) else None,
        'rrStdSec': float(np.std(rr)) if len(rr) else None,
        'systoleMs': float(np.mean(systoles)*1000.0) if len(systoles) else None,
        'diastoleMs': float(np.mean(diastoles)*1000.0) if len(diastoles) else None,
        'dsRatio': float(ds_ratio) if ds_ratio else None,
        's1DurMs': float(s1_dur_ms) if s1_dur_ms else None,
        's2DurMs': float(s2_dur_ms) if s2_dur_ms else None,
        's2SplitMs': float(np.median(s2_splits)) if len(s2_splits) else None,
        'a2OsMs': float(np.median(a2_os)) if len(a2_os) else None,
        's1Intensity': s1_int,
        's2Intensity': s2_int,
        'sysHighFreqEnergy': sys_energy,
        'diaHighFreqEnergy': dia_energy,
        'sysShape': sys_shape,
        'qc': {
            'snrDb': float(snr_db),
            'motionPct': motion_pct,
            'usablePct': usable_pct,
            'contactNoiseSuspected': bool((snr_db < 3.0) or (motion_pct > 0.5))
        },
        # limited events for UI (indices truncated)
        'events': {
            's1': s1_idx[:200],
            's2': s2_idx[:200]
        },
        'extras': {
            'respiration': {
                'respRate': resp_rate,
                'respDominance': resp_dom,
                's2SplitType': split_type,
                's2SplitCorr': float(split_corr) if split_corr is not None else None
            },
            'additionalSounds': extras_sounds,
            'murmur': extras_murmur,
            'rhythm': {
                'rrCV': rr_cv,
                'pNN50': pnn50,
                'sampleEntropy': sampen,
                'poincareSD1': sd1,
                'poincareSD2': sd2,
                'afSuspected': af_suspected,
                'ectopySuspected': ectopy_suspected
            }
        }
    }
    _t1_all = _time.perf_counter()
    # Persist into cross-record cache by provided hash (best-effort)
    try:
        cache_hash = (hash or '').strip()
        if cache_hash:
            async with httpx.AsyncClient(timeout=5.0) as client:
                headers2 = {'Authorization': authorization} if authorization else {}
                await client.post(f"{ANALYSIS_BASE}/cache", json={'hash': cache_hash, 'adv': _result}, headers=headers2)
    except Exception:
        pass
    headers = {'X-Compute-Time': f"{(_t1_all - _t0_all)*1000.0:.2f}"}
    return JSONResponse(content=_result, headers=headers)


@app.post('/hard_algo_metrics')
async def hard_algo_metrics(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...)
):
    try:
        # Downsample to ~2kHz for consistency & speed
        sr = int(sampleRate)
        y = np.asarray(pcm, dtype=np.float32)
        y, sr = _decimate_to_2k(y, sr)
        m = analyze_pcg_from_pcm(sr, y.tolist())
        return m
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# LLM-related endpoints have been moved to a dedicated llm-service


@app.post('/pcg_segment_hsmm')
async def pcg_segment_hsmm(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...),
):
    try:
        m = segment_pcg_hsmm(sampleRate, pcm)
        return JSONResponse(content=m)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post('/pcg_segment_hsmm_media')
async def pcg_segment_hsmm_media(
    mediaId: str = Body(...),
    authorization: Optional[str] = Header(default=None, convert_underscores=False)
):
    try:
        sr, y, err = await _fetch_wav_and_decode(mediaId, authorization)
        if err:
            return JSONResponse({"error": err}, status_code=400)
        m = segment_pcg_hsmm(sr, y.tolist())
        return JSONResponse(content=m)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
