import os
import json
from typing import Dict, Any, List

import numpy as np
from scipy.signal import butter, filtfilt, hilbert, find_peaks
from sklearn.cluster import KMeans

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore


def _bandpass_filter(signal: np.ndarray, fs: int, lowcut=25.0, highcut=400.0, order=4):
    nyq = 0.5 * fs
    low = lowcut / nyq
    high = highcut / nyq
    b, a = butter(order, [low, high], btype='band')
    return filtfilt(b, a, signal)


def _compute_envelope(signal: np.ndarray, fs: int, smooth_ms=50):
    analytic_signal = hilbert(signal)
    amplitude_env = np.abs(analytic_signal) ** 2
    window_length = max(int(smooth_ms / 1000 * fs), 1)
    if window_length <= 1:
        return amplitude_env
    window = np.ones(window_length, dtype=np.float32) / float(window_length)
    return np.convolve(amplitude_env, window, mode='same')


def _separate_s1_s2(peaks: np.ndarray, env_vals: np.ndarray):
    if peaks.size < 2:
        return peaks, np.array([], dtype=int)
    amps = env_vals.reshape(-1, 1)
    km = KMeans(n_clusters=2, random_state=42, n_init=10).fit(amps)
    labels = km.labels_
    means = [amps[labels == i].mean() if np.any(labels == i) else 0.0 for i in [0, 1]]
    s1_label = int(np.argmax(means))
    s1_idx = np.sort(peaks[labels == s1_label])
    s2_idx = np.sort(peaks[labels != s1_label])
    return s1_idx, s2_idx


def analyze_pcg_from_pcm(sample_rate: int, pcm: List[float]) -> Dict[str, Any]:
    fs = int(sample_rate)
    y = np.asarray(pcm, dtype=np.float64)
    if y.size == 0 or fs <= 0:
        return {"error": "empty"}
    # mono normalization
    y = y - np.mean(y)
    m = np.max(np.abs(y))
    if m > 0:
        y = y / m
    # filtering + envelope
    filtered = _bandpass_filter(y, fs)
    env = _compute_envelope(filtered, fs)
    if np.max(env) > 0:
        env_n = env / np.max(env)
    else:
        env_n = env
    # Peak detection
    min_dist = max(1, int(0.3 * fs))
    peaks, _ = find_peaks(env_n, distance=min_dist, prominence=0.05)
    peak_amps = env_n[peaks]
    s1_idx, s2_idx = _separate_s1_s2(peaks, peak_amps)
    s1_t = s1_idx / fs if s1_idx.size else np.array([], dtype=float)
    s2_t = s2_idx / fs if s2_idx.size else np.array([], dtype=float)

    # durations
    def durations(a, b):
        vals = []
        for t in a:
            after = b[b > t]
            if after.size:
                vals.append(after[0] - t)
        if not vals:
            return {"mean": None, "std": None, "count": 0}
        vv = np.asarray(vals)
        return {"mean": float(np.mean(vv)), "std": float(np.std(vv)), "count": int(vv.size)}

    systole = durations(s1_t, s2_t)
    diastole = durations(s2_t, s1_t)

    # heart rate from S1 intervals
    hr_bpm = None
    hr_std = None
    if s1_t.size >= 2:
        rr = np.diff(s1_t)
        hr_bpm = float(60.0 / np.mean(rr)) if np.mean(rr) > 1e-9 else None
        hr_std = float(np.std(rr))

    amp_ratio = None
    if s1_idx.size and s2_idx.size:
        s1_amp = float(np.mean(env_n[s1_idx]))
        s2_amp = float(np.mean(env_n[s2_idx]))
        amp_ratio = float(s2_amp / s1_amp) if s1_amp > 0 else None

    # frequency ratio 150–400 vs 20–150
    n = y.size
    freqs = np.fft.rfftfreq(n, d=1 / fs)
    sp = np.abs(np.fft.rfft(filtered)) ** 2

    def band_energy(lo, hi):
        mask = (freqs >= lo) & (freqs < hi)
        return float(np.sum(sp[mask]))

    low_e = band_energy(20, 150)
    high_e = band_energy(150, 400)
    freq_ratio = float(high_e / low_e) if low_e > 0 else None

    interp = {
        "heart_rate_comment": ("心率偏慢" if (hr_bpm is not None and hr_bpm < 60) else ("心率偏快" if (hr_bpm is not None and hr_bpm > 100) else "心率在正常范围内")) if hr_bpm is not None else None,
        "amplitude_comment": ("第二心音较弱" if (amp_ratio is not None and amp_ratio < 0.5) else ("第二心音较强" if (amp_ratio is not None and amp_ratio > 1.2) else "第一、二心音幅度比例正常")) if amp_ratio is not None else None,
        "murmur_suspected": (freq_ratio is not None and freq_ratio > 0.25),
        "murmur_comment": ("高频能量占比显著，可能存在杂音" if (freq_ratio is not None and freq_ratio > 0.25) else "高频能量占比正常，未发现明显杂音特征") if freq_ratio is not None else None,
    }

    return {
        "sampling_rate": fs,
        "num_samples": int(n),
        "num_peaks_detected": int(peaks.size),
        "num_s1": int(s1_idx.size),
        "num_s2": int(s2_idx.size),
        "heart_rate_bpm": hr_bpm,
        "heart_rate_variability_sec": hr_std,
        "systole_interval_sec": systole,
        "diastole_interval_sec": diastole,
        "s1_s2_amplitude_ratio": amp_ratio,
        "high_freq_energy_ratio": freq_ratio,
        "interpretation": interp,
    }


def generate_ai_report(metrics: Dict[str, Any], lang: str = "zh") -> Dict[str, Any]:
    """Call OpenAI-compatible chat completion API to produce an AI analysis text.
    Requires env: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
    """
    api_key = os.getenv("LLM_API_KEY")
    base_url = os.getenv("LLM_BASE_URL")
    model = os.getenv("LLM_MODEL")
    if not (OpenAI and api_key and base_url and model):
        return {"error": "LLM not configured"}

    client = OpenAI(base_url=base_url, api_key=api_key)
    # Prompt in zh/en based on lang
    if lang == "zh":
        sys = (
            "你是一名心血管科医生助手。"
            "根据给定的心音算法指标，生成非诊断性意见。"
            "要求：使用中文，严格按 Markdown 输出，包含清晰的小标题、列表、重点加粗。"
            "语气客观谨慎；若证据不足，请明确说明不确定。"
        )
        user = (
            "请基于以下 JSON 指标，按 Markdown 输出三个部分：\n"
            "## 总结\n简要 2-3 句。\n\n"
            "## 可能的风险\n若无明显异常，写：未见明显异常。\n\n"
            "## 建议\n包含生活方式、是否建议复测、何时就医等。\n\n"
            f"### 指标\n```json\n{json.dumps(metrics, ensure_ascii=False)}\n```"
        )
    else:
        sys = (
            "You are a cardiology assistant."
            " Based on PCG metrics, produce a non-diagnostic report in English."
            " Requirements: strictly output Markdown with headings, bullet lists, and bold highlights."
            " Be clear and cautious; state uncertainty when evidence is insufficient."
        )
        user = (
            "Using the JSON metrics below, return three Markdown sections:\n"
            "## Summary\n2–3 sentences.\n\n"
            "## Potential Risks\nIf none, say: No obvious abnormality.\n\n"
            "## Advice\nLifestyle, whether to retest, and when to see a doctor.\n\n"
            f"### Metrics\n```json\n{json.dumps(metrics)}\n```"
        )

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": sys},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
    )
    text = resp.choices[0].message.content if resp and resp.choices else ""
    return {"model": model, "text": text}
