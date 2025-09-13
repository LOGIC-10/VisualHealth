#!/usr/bin/env python3
"""
Quick HSMM sanity check on PhysioNet 2016 training-a subset.

Usage:
  python scripts/eval_hsmm_physionet2016.py tmp/physionet2016

Expects directory to contain:
  - REFERENCE.csv (abnormal=1, normal=-1)
  - aXXXX.wav files

Downloads a small subset is not handled here. See CLI steps run previously.
"""
import os
import sys
import json
import numpy as np
from scipy.io import wavfile

sys.path.insert(0, os.path.abspath('services/viz'))
from pcg_hsmm import segment_pcg_hsmm


def band_energy(seg, sr, lo, hi):
    if len(seg) < 32:
        return 0.0
    n = int(2 ** np.ceil(np.log2(max(64, len(seg)))))
    w = np.hanning(len(seg))
    sp = np.fft.rfft(seg * w, n=n)
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    m = (freqs >= lo) & (freqs < hi)
    return float(np.sum((np.abs(sp[m]) ** 2)))


def main(base):
    ref = {}
    with open(os.path.join(base, 'REFERENCE.csv')) as f:
        for line in f:
            rid, lab = line.strip().split(',')
            ref[rid] = 1 if lab == '1' else 0

    ids = [r[:-4] for r in os.listdir(base) if r.endswith('.wav') and r[:-4] in ref]
    ids = sorted(ids)[:50]  # limit for speed
    rows = []
    for rid in ids:
        path = os.path.join(base, rid + '.wav')
        sr, x = wavfile.read(path)
        if x.dtype.kind in ('i', 'u'):
            x = x.astype('float32') / float(np.iinfo(x.dtype).max)
        elif x.dtype.kind == 'f':
            x = x.astype('float32')
        if x.ndim > 1:
            x = x[:, 0]
        m = segment_pcg_hsmm(int(sr), x.tolist())
        y = x
        sr2 = int(m.get('sampleRate', sr))
        if sr != sr2 and sr2 > 0:
            ratio = int(round(sr / sr2))
            if ratio > 1:
                y = y[::ratio]
        s1 = m.get('events', {}).get('s1', [])
        s2 = m.get('events', {}).get('s2', [])
        sys_hf = []
        dia_hf = []
        for j in range(min(len(s1), len(s2))):
            a = s1[j]
            b = s2[j]
            if b > a and b - a > 10:
                seg = y[a:b]
                sys_hf.append(band_energy(seg, sr2, 150, 400) / (band_energy(seg, sr2, 20, 150) + 1e-9))
            if j + 1 < len(s1) and s1[j + 1] > b:
                seg2 = y[b:s1[j + 1]]
                if len(seg2) > 10:
                    dia_hf.append(band_energy(seg2, sr2, 150, 400) / (band_energy(seg2, sr2, 20, 150) + 1e-9))
        sh = float(np.median(sys_hf)) if sys_hf else 0.0
        dh = float(np.median(dia_hf)) if dia_hf else 0.0
        score = sh - dh
        rows.append({'id': rid, 'label': ref[rid], 'score': score})

    from sklearn.metrics import roc_auc_score
    ys = np.array([r['label'] for r in rows])
    ss = np.array([r['score'] for r in rows])
    auc = float(roc_auc_score(ys, ss)) if len(set(ys)) > 1 else None
    pred = (ss >= 0.1).astype(int)
    acc = float((pred == ys).mean())
    out = {'n': len(rows), 'acc': acc, 'auc': auc}
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    base = sys.argv[1] if len(sys.argv) > 1 else 'tmp/physionet2016'
    main(base)

