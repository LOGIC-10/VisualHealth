#!/usr/bin/env python3
"""
Iterative evaluation on PhysioNet 2016 (training-a) using viz/pcg_advanced extras.

Downloads up to N normal and N abnormal WAVs, runs analysis (in-process),
computes screening metrics and saves a JSON report under evals/physionet2016.

Usage:
  python scripts/eval_physionet2016_iter.py --per-class 100 --out-dir evals/physionet2016
"""
import argparse
import datetime as dt
import json
import os
import sys
from typing import List, Dict, Any

import numpy as np
from scipy.io import wavfile
import urllib.request

sys.path.insert(0, os.path.abspath('services/viz'))
import server as srv  # type: ignore


BASE_URL = 'https://physionet.org/files/challenge-2016/1.0.0/training-a'


def download_list(name: str, dest_dir: str) -> List[str]:
    url = f"{BASE_URL}/{name}"
    path = os.path.join(dest_dir, name)
    if not os.path.exists(path):
        urllib.request.urlretrieve(url, path)
    with open(path, 'r') as f:
        return [l.strip() for l in f if l.strip()]


def ensure_wavs(ids: List[str], dest_dir: str):
    os.makedirs(dest_dir, exist_ok=True)
    for rid in ids:
        wp = os.path.join(dest_dir, rid + '.wav')
        if os.path.exists(wp):
            continue
        url = f"{BASE_URL}/{rid}.wav"
        try:
            urllib.request.urlretrieve(url, wp)
        except Exception:
            try:
                if os.path.exists(wp):
                    os.remove(wp)
            except Exception:
                pass


def murmur_score_from_extras(extras: Dict[str, Any]) -> float:
    m = (extras or {}).get('murmur') or {}
    sys = m.get('systolic') or {}
    dia = m.get('diastolic') or {}
    def sc(side):
        cov = float(side.get('coverage') or 0.0)
        br = float(side.get('bandRatio') or 0.0)
        pitch = float(side.get('pitchHz') or 0.0)
        # score: coverage * band ratio; small pitch bonus around 200-300 Hz
        bonus = 0.0
        if 150 <= pitch <= 400:
            bonus = 0.1
        return cov * max(0.0, min(3.0, br)) + bonus
    return max(sc(sys), sc(dia))


async def analyze_one(wav_path: str) -> Dict[str, Any]:
    sr, x = wavfile.read(wav_path)
    if x.dtype.kind in ('i','u'):
        x = x.astype(np.float32) / float(np.iinfo(x.dtype).max)
    elif x.dtype.kind == 'f':
        x = x.astype(np.float32)
    if x.ndim > 1:
        x = x[:, 0]
    res = await srv.pcg_advanced(sampleRate=int(sr), pcm=x.astype('float32').tolist(), hash=None, useHsmm=True, authorization=None)
    import json as _json
    j = _json.loads(res.body)
    return j


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--per-class', type=int, default=100)
    ap.add_argument('--work-dir', type=str, default='tmp/physionet2016')
    ap.add_argument('--out-dir', type=str, default='evals/physionet2016')
    args = ap.parse_args()

    os.makedirs(args.work_dir, exist_ok=True)
    os.makedirs(args.out_dir, exist_ok=True)

    normals = download_list('RECORDS-normal', args.work_dir)[:args.per_class]
    abnormals = download_list('RECORDS-abnormal', args.work_dir)[:args.per_class]
    ids = normals + abnormals
    labels = {rid: 0 for rid in normals}
    labels.update({rid: 1 for rid in abnormals})

    ensure_wavs(ids, args.work_dir)

    import asyncio
    rows = []
    for rid in ids:
        wp = os.path.join(args.work_dir, rid + '.wav')
        try:
            j = asyncio.get_event_loop().run_until_complete(analyze_one(wp))
        except RuntimeError:
            # in case no running loop
            j = asyncio.run(analyze_one(wp))
        extras = j.get('extras', {})
        murmur = extras.get('murmur', {})
        present = bool(murmur.get('present'))
        score = float(murmur_score_from_extras(extras))
        rows.append({
            'id': rid,
            'label': labels[rid],
            'hrBpm': j.get('hrBpm'),
            'qc': j.get('qc'),
            'murmurPresent': present,
            'murmurScore': score,
            'extras': extras,
        })

    # metrics
    ys = np.array([r['label'] for r in rows])
    ss = np.array([r['murmurScore'] for r in rows])
    try:
        from sklearn.metrics import roc_auc_score
        auc = float(roc_auc_score(ys, ss))
    except Exception:
        auc = None
    # choose threshold at Youden on simple grid
    best_acc = 0.0
    best_t = 0.2
    for t in np.linspace(0.05, 1.5, 30):
        pred = (ss >= t).astype(int)
        acc = float((pred == ys).mean())
        if acc > best_acc:
            best_acc = acc; best_t = float(t)
    pred = (ss >= best_t).astype(int)
    from sklearn.metrics import precision_recall_fscore_support
    p, r, f1, _ = precision_recall_fscore_support(ys, pred, average='binary', zero_division=0)

    out = {
        'timestamp': dt.datetime.utcnow().isoformat() + 'Z',
        'perClass': args.per_class,
        'counts': {
            'total': int(len(rows)),
            'normal': int((ys == 0).sum()),
            'abnormal': int((ys == 1).sum()),
        },
        'metrics': {
            'auc': auc,
            'acc_at_best_t': best_acc,
            'best_t': best_t,
            'precision': float(p),
            'recall': float(r),
            'f1': float(f1)
        },
        'rows': rows[:50]  # keep first 50 rows to limit repo size; full rows kept in work dir
    }

    # Save
    fname = f"run-{dt.datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.json"
    path = os.path.join(args.out_dir, fname)
    with open(path, 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Saved:', path)


if __name__ == '__main__':
    main()

