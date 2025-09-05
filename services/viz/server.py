import io
import os
from typing import Optional, List

import numpy as np
import matplotlib
matplotlib.use('Agg')  # non-GUI backend
import matplotlib.pyplot as plt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Body
from fastapi.responses import Response, JSONResponse
from ai_heart import analyze_pcg_from_pcm

PORT = int(os.getenv('PORT', '4006'))

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


@app.post('/spectrogram_pcm')
async def render_spectrogram_pcm(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...),
    startSec: Optional[float] = Body(None),
    endSec: Optional[float] = Body(None),
    width: int = Body(1400),
    height: int = Body(320),
    maxFreq: Optional[int] = Body(2000),
):
    y = np.asarray(pcm, dtype=np.float32)
    sr = int(sampleRate)
    y = _slice_by_time(y, sr, startSec, endSec)
    if len(y) == 0:
        return JSONResponse({"error": "empty segment"}, status_code=400)

    # Spectrogram via STFT
    n_fft = 1024
    hop = n_fft // 4
    # STFT
    window = np.hanning(n_fft).astype(np.float32)
    num_frames = 1 + (len(y) - n_fft) // hop if len(y) >= n_fft else 1
    frames = []
    for i in range(num_frames):
        start = i * hop
        seg = y[start:start + n_fft]
        if len(seg) < n_fft:
            pad = np.zeros(n_fft, dtype=np.float32)
            pad[:len(seg)] = seg
            seg = pad
        frames.append(np.fft.rfft(seg * window))
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
    return Response(content=buf.read(), media_type='image/png')


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


@app.post('/pcg_advanced')
async def pcg_advanced(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...)
):
    # Heuristic CPU-only PCG analysis modules (baseline, non-diagnostic)
    sr = int(sampleRate)
    y = np.asarray(pcm, dtype=np.float32)
    n = len(y)
    if n == 0 or sr <= 0:
        return JSONResponse({"error": "empty"}, status_code=400)

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

    # Peak picking and S1/S2 assignment
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

    return {
        'durationSec': dur,
        'hrBpm': float(hr_bpm) if hr_bpm else None,
        'rrMeanSec': float(np.mean(rr)) if len(rr) else None,
        'rrStdSec': float(np.std(rr)) if len(rr) else None,
        'systoleMs': float(np.mean(systoles)*1000.0) if len(systoles) else None,
        'diastoleMs': float(np.mean(diastoles)*1000.0) if len(diastoles) else None,
        'dsRatio': float(ds_ratio) if ds_ratio else None,
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
            'usablePct': usable_pct
        },
        # limited events for UI (indices truncated)
        'events': {
            's1': s1_idx[:200],
            's2': s2_idx[:200]
        }
    }


@app.post('/hard_algo_metrics')
async def hard_algo_metrics(
    sampleRate: int = Body(...),
    pcm: List[float] = Body(...)
):
    try:
        m = analyze_pcg_from_pcm(sampleRate, pcm)
        return m
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# LLM-related endpoints have been moved to a dedicated llm-service
