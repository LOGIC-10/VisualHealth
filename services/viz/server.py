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
