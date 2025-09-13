import math
from typing import Dict, Any, List, Tuple

import numpy as np
from scipy.signal import resample_poly, get_window


def _resample_to_target(y: np.ndarray, sr: int, target_sr: int = 2000) -> Tuple[np.ndarray, int]:
    sr = int(sr)
    if sr <= 0:
        return y.astype(np.float32, copy=False), sr
    if sr == target_sr:
        return y.astype(np.float32, copy=False), sr
    # polyphase resampling with anti-aliasing
    up = target_sr
    down = sr
    g = math.gcd(up, down)
    up //= g
    down //= g
    y2 = resample_poly(y.astype(np.float32, copy=False), up, down).astype(np.float32, copy=False)
    return y2, target_sr


def _hilbert_envelope(y: np.ndarray, sr: int, smooth_ms: float = 50.0) -> np.ndarray:
    # Use absolute with moving average to avoid heavy Hilbert dependency
    x = np.abs(y).astype(np.float32, copy=False)
    win = max(1, int(round(smooth_ms * 1e-3 * sr)))
    if win <= 1:
        return x
    w = np.ones(win, dtype=np.float32) / float(win)
    return np.convolve(x, w, mode='same').astype(np.float32, copy=False)


def _frame_signal(y: np.ndarray, sr: int, frame_hop_s: float = 0.02, frame_win_s: float = 0.04) -> Tuple[np.ndarray, int, int]:
    hop = max(1, int(round(frame_hop_s * sr)))
    win = max(hop, int(round(frame_win_s * sr)))
    n = len(y)
    if n < win:
        pad = np.zeros(win, dtype=np.float32)
        pad[:n] = y
        y = pad
        n = len(y)
    num = 1 + (n - win) // hop
    idx = np.arange(win, dtype=np.int64)[None, :] + np.arange(num, dtype=np.int64)[:, None] * hop
    frames = y[idx]
    return frames, hop, win


def _spectral_features(frames: np.ndarray, sr: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    # frames: (T, W)
    T, W = frames.shape
    window = get_window('hann', W, fftbins=True).astype(np.float32)
    F = np.fft.rfft(frames * window[None, :], axis=1)
    S = np.abs(F).astype(np.float32)
    P = (S ** 2).astype(np.float32)
    freqs = np.fft.rfftfreq(W, d=1.0 / sr)
    # spectral flux
    dS = np.diff(S, axis=0, prepend=S[:1])
    flux = np.sqrt((dS ** 2).sum(axis=1))
    # band energies
    lo_mask = (freqs >= 20) & (freqs < 150)
    hi_mask = (freqs >= 150) & (freqs <= 400)
    lo_e = (P[:, lo_mask].sum(axis=1) + 1e-9)
    hi_e = (P[:, hi_mask].sum(axis=1) + 1e-9)
    hf_ratio = (hi_e / lo_e)
    # overall magnitude (envelope proxy)
    mag = S.sum(axis=1)
    return mag, flux, hf_ratio


def _normalize_colwise(X: np.ndarray) -> np.ndarray:
    X = X.astype(np.float32, copy=False)
    mu = np.nanmean(X, axis=0)
    sd = np.nanstd(X, axis=0) + 1e-6
    Z = (X - mu) / sd
    Z = np.clip(Z, -3.0, 3.0)
    # map to [0,1]
    return (Z + 3.0) / 6.0


def _estimate_hr_bpm(y: np.ndarray, sr: int) -> Tuple[float, float]:
    # Return (hr_bpm, salience)
    env = _hilbert_envelope(y, sr, smooth_ms=50.0)
    env = env / (np.max(env) + 1e-9)
    n = len(env)
    ac = np.correlate(env, env, mode='full')[n - 1: n - 1 + int(2.0 * sr)]
    min_lag = int(0.3 * sr)  # 200 bpm upper bound
    max_lag = int(1.8 * sr)  # 33 bpm lower bound
    if max_lag <= min_lag + 5:
        return None, 0.0  # type: ignore
    seg = ac[min_lag:max_lag]
    pk = int(np.argmax(seg))
    peak_val = float(seg[pk])
    base = float(np.median(seg)) + 1e-9
    sal = (peak_val - base) / (np.max(seg) + 1e-9)
    lag = min_lag + pk
    hr = 60.0 * sr / float(lag)
    return float(hr), float(max(0.0, min(1.0, sal)))


def _emission_scores(features: np.ndarray) -> np.ndarray:
    # features: [T, 4] -> env, d_env, flux, hf
    env = features[:, 0]
    denv = features[:, 1]
    flux = features[:, 2]
    hf = features[:, 3]
    # Hand-tuned weights for 4 states: S1, Sys, S2, Dia
    W = np.array([
        [1.4, 1.0, -0.2, 0.2],   # S1: high env, high rising edge, low flux, mild hf
        [0.6, -0.2, 0.9, 0.5],   # Sys: medium env, flux high, hf medium-high
        [1.2, 1.0, 0.2, 0.8],    # S2: high env, rising edge, higher hf
        [-1.0, -0.6, -0.8, -0.5] # Dia: low everything
    ], dtype=np.float32)
    B = np.array([0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    X = np.stack([env, denv, flux, hf], axis=1)
    E = X @ W.T + B[None, :]
    return E.astype(np.float32, copy=False)


def _hsmm_viterbi(E: np.ndarray, frame_rate: float, hr_bpm: float) -> np.ndarray:
    # E: [T, 4] emission scores; returns best state path (ints 0..3)
    T = E.shape[0]
    C = frame_rate * 60.0 / max(30.0, min(200.0, hr_bpm))  # frames per cycle
    # duration priors (in frames)
    s1_mu = max(2.0, min(8.0, 0.06 * C))
    s2_mu = max(2.0, min(8.0, 0.05 * C))
    sys_mu = max(0.15 * C, min(0.45 * C, 0.32 * C))
    dia_mu = max(0.2 * C, min(0.8 * C, 0.62 * C))
    mus = [s1_mu, sys_mu, s2_mu, dia_mu]
    sigs = [max(1.5, 0.25 * s1_mu), 0.25 * sys_mu, max(1.5, 0.25 * s2_mu), 0.25 * dia_mu]
    mins = [2, max(2, int(0.10 * C)), 2, max(2, int(0.20 * C))]
    maxs = [8, max(min(T, int(0.6 * C)), mins[1] + 2), 8, max(min(T, int(1.0 * C)), mins[3] + 2)]

    # Precompute duration log priors for each state and d
    maxD = max(maxs)
    dur_logp = np.full((4, maxD + 1), -np.inf, dtype=np.float32)
    for s in range(4):
        mu = float(mus[s])
        sig = float(sigs[s]) + 1e-6
        for d in range(mins[s], maxs[s] + 1):
            dur_logp[s, d] = -0.5 * ((d - mu) / sig) ** 2

    # DP arrays
    dp = np.full((T + 1, 4), -np.inf, dtype=np.float32)
    ptr_state = -np.ones((T + 1, 4), dtype=np.int16)
    ptr_dur = np.zeros((T + 1, 4), dtype=np.int16)

    # Allow any start state at t>=mins[s]
    for s in range(4):
        dmin, dmax = mins[s], maxs[s]
        for d in range(dmin, min(dmax, T) + 1):
            emis = E[:d, s].sum()
            score = float(dur_logp[s, d] + emis)
            if score > dp[d, s]:
                dp[d, s] = score
                ptr_state[d, s] = -1
                ptr_dur[d, s] = d

    # transitions: 0->1->2->3->0
    def prev_state(s: int) -> int:
        return (s - 1) % 4

    for t in range(1, T + 1):
        for s in range(4):
            ps = prev_state(s)
            dmin, dmax = mins[s], maxs[s]
            dmax2 = min(dmax, t)
            if dmax2 < dmin:
                continue
            # try all durations ending at t
            best = dp[t, s]
            best_d = ptr_dur[t, s]
            for d in range(dmin, dmax2 + 1):
                prev_t = t - d
                base = dp[prev_t, ps]
                if base == -np.inf:
                    continue
                emis = E[prev_t:t, s].sum()
                score = float(base + dur_logp[s, d] + emis)
                if score > best:
                    best = score
                    best_d = d
                    ptr_state[t, s] = ps
            dp[t, s] = best
            ptr_dur[t, s] = best_d

    # best end
    end_t = T
    end_s = int(np.argmax(dp[end_t]))
    # backtrack
    path = np.zeros(T, dtype=np.int16)
    t = end_t
    s = end_s
    while t > 0 and s >= 0:
        d = int(ptr_dur[t, s])
        if d <= 0:
            # fallback one step to avoid deadlock
            d = 1
        path[t - d:t] = s
        ps = int(ptr_state[t, s])
        if ps < 0:
            break
        t -= d
        s = ps
    # if not fully covered, fill with most probable state by emission
    if t > 0:
        fill = int(np.argmax(E[:t].mean(axis=0)))
        path[:t] = fill
    return path.astype(np.int32)


def segment_pcg_hsmm(sample_rate: int, pcm: List[float]) -> Dict[str, Any]:
    sr = int(sample_rate)
    y = np.asarray(pcm, dtype=np.float32)
    if y.size == 0 or sr <= 0:
        return {"error": "empty"}
    # resample for consistency
    y2, sr2 = _resample_to_target(y, sr, 2000)
    # feature extraction per frame
    frames, hop, win = _frame_signal(y2, sr2, 0.02, 0.04)
    mag, flux, hf_ratio = _spectral_features(frames, sr2)
    env = _hilbert_envelope(y2, sr2, 50.0)
    # frame envelope and derivative
    # align env to frame centers
    centers = (np.arange(frames.shape[0]) * hop + win // 2).astype(np.int64)
    env_f = env[np.clip(centers, 0, len(env) - 1)]
    denv_f = np.diff(env_f, prepend=env_f[:1])
    # stack features and normalize
    F = np.stack([env_f, denv_f, flux, hf_ratio], axis=1)
    Fn = _normalize_colwise(F)
    # HR estimation
    hr_bpm, hr_sal = _estimate_hr_bpm(y2, sr2)
    if not hr_bpm:
        hr_bpm = 75.0
        hr_sal = 0.0
    # emissions and HSMM
    E = _emission_scores(Fn)
    path = _hsmm_viterbi(E, frame_rate=sr2 / hop, hr_bpm=hr_bpm)
    # derive S1/S2 event indices: pick local maxima of env within S1/S2 regions
    s1_frames = np.where(path == 0)[0]
    s2_frames = np.where(path == 2)[0]
    def peak_from_regions(fr_idx: np.ndarray) -> List[int]:
        if fr_idx.size == 0:
            return []
        peaks = []
        start = fr_idx[0]
        prev = fr_idx[0]
        for t in fr_idx[1:]:
            if t == prev + 1:
                prev = t
                continue
            # region [start, prev]
            a = start * hop
            b = min(len(env) - 1, prev * hop + win)
            seg = env[a:b]
            if seg.size:
                pk = int(np.argmax(seg))
                peaks.append(a + pk)
            start = t
            prev = t
        # tail
        a = start * hop
        b = min(len(env) - 1, prev * hop + win)
        seg = env[a:b]
        if seg.size:
            pk = int(np.argmax(seg))
            peaks.append(a + pk)
        return sorted(set(peaks))

    s1_idx = peak_from_regions(s1_frames)
    s2_idx = peak_from_regions(s2_frames)

    # RR / durations
    s1t = np.array(s1_idx, dtype=np.float64) / sr2 if len(s1_idx) else np.array([], dtype=np.float64)
    s2t = np.array(s2_idx, dtype=np.float64) / sr2 if len(s2_idx) else np.array([], dtype=np.float64)
    rr = np.diff(s1t) if s1t.size >= 2 else np.array([], dtype=np.float64)
    sys = []
    dia = []
    for s1 in s1t:
        after = s2t[s2t > s1]
        if after.size:
            st = after[0] - s1
            if 0.03 <= st <= 0.8:
                sys.append(st)
    for s2 in s2t:
        after = s1t[s1t > s2]
        if after.size:
            dt = after[0] - s2
            if dt > 0:
                dia.append(dt)
    ds_ratio = float(np.mean(dia) / np.mean(sys)) if (len(sys) and len(dia)) else None

    # SQI: SNR band ratio + HR salience + cycle consistency
    # approximate SNR using frames energy
    snr_db = 10.0 * np.log10((np.mean(hf_ratio) + 1e-9) / (np.var(env_f) + 1e-9))
    cyc_cv = float(np.std(rr) / (np.mean(rr) + 1e-9)) if rr.size else 1.0
    seg_q = float(max(0.0, min(1.0, 0.6 * (hr_sal) + 0.4 * (1.0 - min(1.0, cyc_cv)))))

    return {
        'sampleRate': sr2,
        'frameRate': float(sr2 / hop),
        'hrBpm': float(hr_bpm),
        'hrSalience': float(hr_sal),
        'events': {
            's1': s1_idx[:200],
            's2': s2_idx[:200],
        },
        'rrMeanSec': float(np.mean(rr)) if rr.size else None,
        'rrStdSec': float(np.std(rr)) if rr.size else None,
        'systoleMs': float(np.mean(sys) * 1000.0) if sys else None,
        'diastoleMs': float(np.mean(dia) * 1000.0) if dia else None,
        'dsRatio': ds_ratio,
        'sqi': {
            'hrSalience': float(hr_sal),
            'cycleCV': float(cyc_cv) if rr.size else None,
            'segQuality': seg_q,
            'snrDbApprox': float(snr_db),
        }
    }

