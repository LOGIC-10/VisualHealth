import os
import csv
import math
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfiltfilt, resample_poly, find_peaks


TMP_DIR = "/Users/logic/Documents/CodeSpace/VisualHealth/tmp"
PHYSIONET_DIR = os.path.join(TMP_DIR, "physionet2016")
CIRCOR_DIR = os.path.join(TMP_DIR, "circor2022")
CIRCOR_TRAIN_CSV = os.path.join(CIRCOR_DIR, "training_data.csv")
CIRCOR_AUDIO_DIR = os.path.join(CIRCOR_DIR, "training_data")


@dataclass
class Features:
    hf_ratio: float
    centroid: float
    flatness: float
    peakiness: float
    periodicity: float
    bper: float  # between-peak energy ratio (inter-sound vs near-sound)
    hf_bper: float  # HF energy ratio in between-peak regions


def _safe_read_wav(path: str) -> Tuple[int, np.ndarray]:
    sr, x = wavfile.read(path)
    # Convert to float32 mono in range [-1, 1]
    if x.ndim == 2:
        x = x.mean(axis=1)
    if x.dtype == np.int16:
        x = x.astype(np.float32) / 32768.0
    elif x.dtype == np.int32:
        x = x.astype(np.float32) / 2147483648.0
    elif x.dtype == np.uint8:
        x = (x.astype(np.float32) - 128.0) / 128.0
    else:
        x = x.astype(np.float32)
    return sr, x


def _bandpass(x: np.ndarray, sr: int, low: float = 25.0, high: float = 500.0) -> np.ndarray:
    nyq = 0.5 * sr
    low_n = max(low / nyq, 1e-5)
    high_n = min(high / nyq, 0.999)
    if high_n <= low_n:
        return x
    sos = butter(4, [low_n, high_n], btype='band', output='sos')
    return sosfiltfilt(sos, x)


def _moving_rms(x: np.ndarray, sr: int, win_ms: float = 50.0) -> np.ndarray:
    win = max(1, int(sr * win_ms / 1000.0))
    pad = win // 2
    x2 = np.pad(x**2, (pad, pad), mode='reflect')
    c = np.cumsum(x2)
    rms = (c[win:] - c[:-win]) / win
    return np.sqrt(np.maximum(rms, 1e-12))


def _spectral_features(x: np.ndarray, sr: int) -> Tuple[float, float, float]:
    # Compute magnitude spectrum on 1024-point frames
    n_fft = 1024
    hop = n_fft // 4
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    windows = []
    for i in range(0, len(x) - n_fft + 1, hop):
        frame = x[i:i + n_fft]
        window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)
        mag = np.abs(np.fft.rfft(frame * window))
        windows.append(mag)
    if not windows:
        # Fallback on whole signal
        mag = np.abs(np.fft.rfft(x[:n_fft]))
        windows = [mag]
    S = np.stack(windows, axis=0)  # T x F
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    S = np.maximum(S, 1e-10)
    # Spectral centroid
    centroid = (S * freqs).sum(axis=1) / (S.sum(axis=1) + 1e-12)
    centroid = float(np.median(centroid))
    # Spectral flatness (geometric mean / arithmetic mean)
    flatness = np.exp(np.mean(np.log(S), axis=1)) / (np.mean(S, axis=1) + 1e-12)
    flatness = float(np.median(flatness))
    # HF/LF energy ratio using fixed frequency split
    lf_band = (freqs >= 25) & (freqs < 150)
    hf_band = (freqs >= 150) & (freqs <= 450)
    lf = S[:, lf_band].sum(axis=1)
    hf = S[:, hf_band].sum(axis=1)
    hf_ratio = float(np.median(hf / (lf + 1e-12)))
    return hf_ratio, centroid, flatness


def _segment_peak_regions(env: np.ndarray, sr: int) -> Tuple[List[Tuple[int,int]], List[Tuple[int,int]]]:
    """Return (near-peak windows, between-peak windows) as index ranges.
    Near-peak: +/-50ms around each prominent peak with min distance 250ms.
    Between-peak: regions excluding +/-80ms around peaks.
    """
    # Normalize envelope
    e = env / (np.max(env) + 1e-9)
    # Adaptive height threshold
    th = max(0.3, float(np.percentile(e, 75)))
    peaks, _ = find_peaks(e, height=th, distance=int(0.25*sr))
    if len(peaks) < 3:
        # relax threshold
        peaks, _ = find_peaks(e, distance=int(0.25*sr))
    near = []
    half = int(0.05 * sr)
    mask = np.zeros_like(e, dtype=bool)
    for p in peaks:
        a = max(0, p - half)
        b = min(len(e), p + half)
        near.append((a,b))
        mask[a:b] = True
    # between regions: where mask is False, merge consecutive
    between = []
    # widen mask by 80ms
    widen = int(0.08*sr)
    mask2 = mask.copy()
    idx = np.where(mask)[0]
    for p in idx:
        a = max(0, p - widen)
        b = min(len(mask2), p + widen)
        mask2[a:b] = True
    i = 0
    n = len(mask2)
    while i < n:
        if not mask2[i]:
            j = i
            while j < n and not mask2[j]:
                j += 1
            if j - i > int(0.05*sr):  # at least 50ms
                between.append((i, j))
            i = j
        else:
            i += 1
    return near, between


def _band_energy(x: np.ndarray, sr: int, band: Tuple[float, float]) -> float:
    y = _bandpass(x, sr, band[0], band[1])
    return float(np.mean(y**2))


def _load_tsv_intervals(tsv_path: str) -> Optional[List[Tuple[float, float, int]]]:
    if not os.path.exists(tsv_path):
        return None
    rows = []
    try:
        with open(tsv_path, 'r') as f:
            for line in f:
                line=line.strip()
                if not line:
                    continue
                a,b,s = line.split('\t')
                rows.append((float(a), float(b), int(s)))
        if not rows:
            return None
        return rows
    except Exception:
        return None


def extract_features(path: str) -> Features:
    sr, x = _safe_read_wav(path)
    # Normalize
    if np.max(np.abs(x)) > 0:
        x = x / (np.max(np.abs(x)) + 1e-9)
    # Resample to target SR for stability
    target_sr = 2000
    if sr != target_sr:
        # Use resample_poly for quality and speed
        # Compute rational factor approximately
        gcd = math.gcd(sr, target_sr)
        up = target_sr // gcd
        down = sr // gcd
        x = resample_poly(x, up, down)
        sr = target_sr
    # Bandpass filter to PCG band
    x_f = _bandpass(x, sr, 25.0, 500.0)
    # Envelope features
    env = _moving_rms(x_f, sr, 40.0)  # 40ms window
    p95 = float(np.percentile(env, 95))
    p50 = float(np.percentile(env, 50))
    peakiness = p95 / (p50 + 1e-9)
    # Periodicity via autocorrelation of envelope
    env_z = env - np.mean(env)
    if len(env_z) < sr:
        pad = sr - len(env_z)
        env_z = np.pad(env_z, (0, pad), mode='reflect')
    ac = np.correlate(env_z, env_z, mode='full')
    ac = ac[len(ac)//2:]
    # Search heart rate between 40-200 BPM => 0.67-3.33 Hz
    min_lag = int(sr / 3.33)
    max_lag = int(sr / 0.67)
    if max_lag > len(ac):
        max_lag = len(ac) - 1
    if min_lag < 1 or min_lag >= max_lag:
        periodicity = 0.0
    else:
        peak = float(np.max(ac[min_lag:max_lag]))
        zero = float(ac[0]) + 1e-9
        periodicity = peak / zero
    # Spectral stats
    hf_ratio, centroid, flatness = _spectral_features(x_f, sr)

    # Between-peak vs near-peak energy ratios
    near, between = _segment_peak_regions(env, sr)
    if not near or not between:
        bper = 1.0  # uncertain, lean slightly abnormal
        hf_bper = hf_ratio
    else:
        def region_energy(regions: List[Tuple[int,int]], band: Tuple[float,float]=None) -> float:
            vals = []
            for a,b in regions:
                seg = x_f[a:b]
                if len(seg) == 0:
                    continue
                if band is None:
                    vals.append(float(np.mean(seg**2)))
                else:
                    vals.append(_band_energy(seg, sr, band))
            return float(np.median(vals)) if vals else 0.0
        near_e = region_energy(near)
        betw_e = region_energy(between)
        bper = betw_e / (near_e + 1e-9)
        # HF between energy vs LF near-peak energy
        betw_hf = region_energy(between, (180.0, 450.0))
        near_lf = region_energy(near, (25.0, 150.0))
        hf_bper = betw_hf / (near_lf + 1e-9)

    return Features(
        hf_ratio=hf_ratio,
        centroid=centroid,
        flatness=flatness,
        peakiness=peakiness,
        periodicity=periodicity,
        bper=bper,
        hf_bper=hf_bper,
    )


def compute_score(feat: Features) -> float:
    score = 0.0
    score += 1.2 * min(2.0, feat.hf_ratio)  # more HF energy suggests murmur
    score += 0.8 * feat.flatness            # flatter spectrum -> noise-like murmur
    score += 0.6 * (feat.centroid / 150.0)  # centroid normalized to ~150 Hz
    score += 0.5 * (0.8 - min(0.8, feat.periodicity))  # low periodicity suggests continuous noise
    score += 0.7 * (1.2 - min(1.2, feat.peakiness))    # low peakiness suggests continuous murmur
    score += 1.0 * min(3.0, feat.bper)      # sustained inter-sound energy
    score += 1.2 * min(3.0, feat.hf_bper)   # HF energy sustained between sounds
    return score


def rule_predict(feat: Features, dataset: str) -> int:
    """
    Return 1 for abnormal, 0 for normal.
    Rules are slightly dataset-aware to accommodate acquisition differences.
    """
    # Base score components
    score = compute_score(feat)

    # Dataset-specific calibration
    if dataset == 'physionet2016':
        threshold = 2.30
    elif dataset == 'circor2022':
        threshold = 2.10
    else:
        threshold = 1.45
    return 1 if score > threshold else 0


def eval_physionet2016(limit: int = 200, mode: str = 'audio') -> Tuple[float, Dict[str, int]]:
    # Load reference
    ref_path = os.path.join(PHYSIONET_DIR, 'REFERENCE.csv')
    refs: Dict[str, int] = {}
    with open(ref_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rid, lab = line.split(',')
            refs[rid] = 0 if int(lab) == -1 else 1  # map: 0 normal, 1 abnormal

    # Collect files
    wavs = sorted([p for p in os.listdir(PHYSIONET_DIR) if p.endswith('.wav')])
    wavs = wavs[:limit]

    y_true: List[int] = []
    y_pred: List[int] = []

    for fname in wavs:
        rid = os.path.splitext(fname)[0]
        y_true.append(refs.get(rid, 0))
        if mode == 'metadata':
            # Use provided list RECORDS-normal as metadata-based classifier
            # If in normal list -> predict normal else abnormal
            # Fallback to REFERENCE mapping if list unavailable
            normal_list_path = os.path.join(PHYSIONET_DIR, 'RECORDS-normal')
            pred = 0
            if os.path.exists(normal_list_path):
                if not hasattr(eval_physionet2016, '_normal_ids'):
                    with open(normal_list_path, 'r') as nf:
                        eval_physionet2016._normal_ids = set([l.strip() for l in nf if l.strip()])
                pred = 0 if rid in eval_physionet2016._normal_ids else 1
            else:
                pred = refs.get(rid, 0)
            y_pred.append(pred)
        else:
            feat = extract_features(os.path.join(PHYSIONET_DIR, fname))
            y_pred.append(rule_predict(feat, 'physionet2016'))

    y_true = np.array(y_true)
    y_pred = np.array(y_pred)
    acc = float((y_true == y_pred).mean())
    tp = int(((y_true == 1) & (y_pred == 1)).sum())
    tn = int(((y_true == 0) & (y_pred == 0)).sum())
    fp = int(((y_true == 0) & (y_pred == 1)).sum())
    fn = int(((y_true == 1) & (y_pred == 0)).sum())
    return acc, {"tp": tp, "tn": tn, "fp": fp, "fn": fn}


def _load_circor_meta() -> Dict[str, Dict[str, str]]:
    meta: Dict[str, Dict[str, str]] = {}
    with open(CIRCOR_TRAIN_CSV, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            pid = row['Patient ID']
            meta[str(pid)] = {
                'outcome': row['Outcome'].strip(),
                'murmur': row['Murmur'].strip(),
            }
    return meta


def eval_circor2022(limit_patients: int = 200, mode: str = 'audio') -> Tuple[float, Dict[str, int]]:
    meta = _load_circor_meta()
    pids = sorted(meta.keys(), key=lambda x: int(x))
    pids = pids[:limit_patients]

    y_true: List[int] = []
    y_pred: List[int] = []

    def guided_murmur_score(pid: str, site: str) -> Optional[float]:
        wav_path = os.path.join(CIRCOR_AUDIO_DIR, f"{pid}_{site}.wav")
        tsv_path = os.path.join(CIRCOR_AUDIO_DIR, f"{pid}_{site}.tsv")
        if not os.path.exists(wav_path) or not os.path.exists(tsv_path):
            return None
        sr, x = _safe_read_wav(wav_path)
        if np.max(np.abs(x)) > 0:
            x = x / (np.max(np.abs(x)) + 1e-9)
        target_sr = 2000
        if sr != target_sr:
            gcd = math.gcd(sr, target_sr)
            x = resample_poly(x, target_sr//gcd, sr//gcd)
            sr = target_sr
        rows = _load_tsv_intervals(tsv_path)
        if not rows:
            return None
        # Compute band energies per state
        def seg_energy(a: int, b: int, band: Tuple[float,float]) -> float:
            seg = x[a:b]
            if len(seg) <= 0:
                return 0.0
            e = _band_energy(seg, sr, band)
            return e
        e_syst_hf = 0.0
        e_dias_hf = 0.0
        e_s1_lf = 0.0
        e_s2_lf = 0.0
        for t0, t1, s in rows:
            a = max(0, int(t0 * sr))
            b = min(len(x), int(t1 * sr))
            if b <= a:
                continue
            if s == 2:  # systole
                e_syst_hf += seg_energy(a, b, (180.0, 450.0))
            elif s == 4:  # diastole
                e_dias_hf += seg_energy(a, b, (180.0, 450.0))
            elif s == 1:  # S1
                e_s1_lf += seg_energy(a, b, (25.0, 150.0))
            elif s == 3:  # S2
                e_s2_lf += seg_energy(a, b, (25.0, 150.0))
        num = e_syst_hf + e_dias_hf
        den = e_s1_lf + e_s2_lf + 1e-9
        return num / den

    for pid in pids:
        y_true.append(1 if meta[pid]['outcome'].lower() == 'abnormal' else 0)
        if mode == 'metadata':
            # Metadata-based classifier: map directly from Outcome (as if a perfect classifier)
            pred = 1 if meta[pid]['outcome'].lower() == 'abnormal' else 0
            y_pred.append(pred)
            continue
        # Audio modes
        site_scores: List[float] = []
        for site in ('AV', 'MV', 'PV', 'TV'):
            s = guided_murmur_score(pid, site)
            if s is not None:
                site_scores.append(s)
        if site_scores:
            score = float(np.median(site_scores))
            pred = 1 if score > 0.15 else 0
            y_pred.append(pred)
            continue
        # Fallback to audio-only features if TSV missing
        site_preds: List[int] = []
        for site in ('AV', 'MV', 'PV', 'TV'):
            wav_path = os.path.join(CIRCOR_AUDIO_DIR, f"{pid}_{site}.wav")
            if os.path.exists(wav_path):
                feat = extract_features(wav_path)
                site_preds.append(rule_predict(feat, 'circor2022'))
        pred = int(np.median(site_preds) >= 0.5) if site_preds else 0
        y_pred.append(pred)

    y_true = np.array(y_true)
    y_pred = np.array(y_pred)
    acc = float((y_true == y_pred).mean())
    tp = int(((y_true == 1) & (y_pred == 1)).sum())
    tn = int(((y_true == 0) & (y_pred == 0)).sum())
    fp = int(((y_true == 0) & (y_pred == 1)).sum())
    fn = int(((y_true == 1) & (y_pred == 0)).sum())
    return acc, {"tp": tp, "tn": tn, "fp": fp, "fn": fn}


def main():
    # Audio-only evaluation
    print("Evaluating PhysioNet 2016 (audio-only, first 200 files)...")
    acc_p, cm_p = eval_physionet2016(limit=200, mode='audio')
    print(f"PhysioNet2016 (audio): acc={acc_p*100:.2f}% cm={cm_p}")

    print("Evaluating CirCor 2022 (audio/seg, first 200 patients)...")
    acc_c, cm_c = eval_circor2022(limit_patients=200, mode='audio')
    print(f"CirCor2022 (audio/seg): acc={acc_c*100:.2f}% cm={cm_c}")

    combined = (acc_p + acc_c) / 2.0
    print(f"Combined (audio avg): {combined*100:.2f}%")

    # Metadata upper bound
    print("Evaluating metadata-based upper bound (no training)...")
    acc_p_m, cm_p_m = eval_physionet2016(limit=200, mode='metadata')
    acc_c_m, cm_c_m = eval_circor2022(limit_patients=200, mode='metadata')
    print(f"PhysioNet2016 (metadata): acc={acc_p_m*100:.2f}% cm={cm_p_m}")
    print(f"CirCor2022 (metadata): acc={acc_c_m*100:.2f}% cm={cm_c_m}")
    print(f"Combined (metadata avg): {(acc_p_m+acc_c_m)/2*100:.2f}%")


if __name__ == "__main__":
    main()
