#!/usr/bin/env python3
"""
Iterative evaluation on CirCor DigiScope (PhysioNet 2022) training set.

Downloads training_data.csv, fetches up to N subjects and their per-location
recordings (.wav) and segmentations (.tsv). Computes:
  - Segmentation F1/IoU for states S1/Sys/S2/Dia (ignoring state 0) vs .tsv
  - Murmur presence AUROC using our murmur score aggregated across locations

Usage:
  python scripts/eval_circor2022_iter.py --subjects 100 --out evals/physionet2022
"""
import argparse
import os
import sys
import csv
import json
import math
from typing import Dict, Any, List, Tuple

import numpy as np
from scipy.io import wavfile
import urllib.request

sys.path.insert(0, os.path.abspath('services/viz'))
import server as srv  # type: ignore


BASE = 'https://physionet.org/files/circor-heart-sound/1.0.3'


def fetch(url: str, dest: str):
    if os.path.exists(dest):
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    urllib.request.urlretrieve(url, dest)


def load_subjects(csv_path: str, limit: int) -> List[Dict[str, Any]]:
    rows = []
    with open(csv_path, newline='') as f:
        r = csv.DictReader(f)
        for i, row in enumerate(r):
            rows.append(row)
            if len(rows) >= limit:
                break
    return rows


def parse_locations(s: str) -> List[str]:
    # AV, MV, PV, TV
    locs = []
    for k in ['AV', 'MV', 'PV', 'TV']:
        if s and k in s:
            locs.append(k)
    return locs


def tsv_to_labels(tsv_path: str, sr_target: int) -> np.ndarray:
    # Returns per-sample integer labels at sr_target following mapping:
    # 0=unlabeled, 1=S1, 2=Sys, 3=S2, 4=Dia
    with open(tsv_path, 'r') as f:
        lines = [l.strip() for l in f if l.strip()]
    # find duration
    max_t = 0.0
    segs: List[Tuple[float, float, int]] = []
    for ln in lines:
        a, b, s = ln.split('\t')
        a = float(a); b = float(b); s = int(float(s))  # robust parse
        segs.append((a, b, s))
        if b > max_t:
            max_t = b
    n = int(math.ceil(max_t * sr_target)) + 1
    y = np.zeros(n, dtype=np.int16)
    for a, b, s in segs:
        ia = max(0, int(round(a * sr_target)))
        ib = min(n, int(round(b * sr_target)))
        if ib > ia:
            y[ia:ib] = s
    return y


def segmentation_scores(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    # compute F1 and IoU per state 1..4; ignore 0
    res: Dict[str, float] = {}
    for s, name in [(1, 'S1'), (2, 'Sys'), (3, 'S2'), (4, 'Dia')]:
        tp = int(np.sum((y_pred == s) & (y_true == s)))
        fp = int(np.sum((y_pred == s) & (y_true != s)))
        fn = int(np.sum((y_pred != s) & (y_true == s)))
        iou = tp / float(tp + fp + fn + 1e-9)
        prec = tp / float(tp + fp + 1e-9)
        rec = tp / float(tp + fn + 1e-9)
        f1 = 2 * prec * rec / float(prec + rec + 1e-9)
        res[f'{name}_F1'] = f1
        res[f'{name}_IoU'] = iou
    # macro
    f1s = [res[k] for k in res if k.endswith('_F1')]
    ious = [res[k] for k in res if k.endswith('_IoU')]
    res['macro_F1'] = float(np.mean(f1s)) if f1s else 0.0
    res['macro_IoU'] = float(np.mean(ious)) if ious else 0.0
    return res


async def run_pcg_advanced(sr: int, x: np.ndarray) -> Dict[str, Any]:
    res = await srv.pcg_advanced(sampleRate=int(sr), pcm=x.astype('float32').tolist(), hash=None, useHsmm=True, authorization=None)
    import json as _json
    return _json.loads(res.body)


def murmur_score(extras: Dict[str, Any]) -> float:
    m = (extras or {}).get('murmur') or {}
    sys = m.get('systolic') or {}
    dia = m.get('diastolic') or {}
    def sc(side):
        cov = float(side.get('coverage') or 0.0)
        br = float(side.get('bandRatio') or 0.0)
        bonus = 0.0
        pitch = side.get('pitchHz')
        if pitch is not None and 150 <= float(pitch) <= 400:
            bonus = 0.1
        return cov * max(0.0, min(3.0, br)) + bonus
    return max(sc(sys), sc(dia))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--subjects', type=int, default=100)
    ap.add_argument('--work-dir', type=str, default='tmp/circor2022')
    ap.add_argument('--out', type=str, default='evals/physionet2022')
    ap.add_argument('--per-subject-locs', type=int, default=2)
    args = ap.parse_args()

    os.makedirs(args.work_dir, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    # fetch metadata
    csv_path = os.path.join(args.work_dir, 'training_data.csv')
    fetch(f"{BASE}/training_data.csv?download", csv_path)
    subjects = load_subjects(csv_path, args.subjects)

    import asyncio
    seg_metrics = []
    rows = []
    for subj in subjects:
        pid = subj['Patient ID']
        mur = subj['Murmur']
        label = 1 if mur and mur.lower() == 'present' else (0 if mur and mur.lower() == 'absent' else None)
        locs = parse_locations(subj.get('Recording locations:', ''))[:args.per_subject_locs]  # type: ignore
        best_macro_f1 = None
        agg_score = 0.0
        count_rec = 0
        for loc in locs:
            wav_url = f"{BASE}/training_data/{pid}_{loc}.wav?download"
            tsv_url = f"{BASE}/training_data/{pid}_{loc}.tsv?download"
            wav_path = os.path.join(args.work_dir, 'training_data', f'{pid}_{loc}.wav')
            tsv_path = os.path.join(args.work_dir, 'training_data', f'{pid}_{loc}.tsv')
            try:
                fetch(wav_url, wav_path)
                fetch(tsv_url, tsv_path)
            except Exception:
                continue
            # read audio
            sr, x = wavfile.read(wav_path)
            if x.dtype.kind in ('i','u'):
                x = x.astype(np.float32) / float(np.iinfo(x.dtype).max)
            elif x.dtype.kind == 'f':
                x = x.astype(np.float32)
            if x.ndim > 1:
                x = x[:, 0]
            # ground truth labels at 2kHz to match our pipeline
            y_true = tsv_to_labels(tsv_path, 2000)
            # run our analysis
            try:
                j = asyncio.get_event_loop().run_until_complete(run_pcg_advanced(int(sr), x))
            except RuntimeError:
                j = asyncio.run(run_pcg_advanced(int(sr), x))
            # derive predicted labels from HSMM path events of /pcg_advanced
            # We rebuild path by mapping envelope peaks to s1/s2 and filling systole/diastole with indices ranges
            n2 = len(y_true)
            s1 = list(map(int, (j.get('events') or {}).get('s1') or []))
            s2 = list(map(int, (j.get('events') or {}).get('s2') or []))
            y_pred = np.zeros(n2, dtype=np.int16)
            for a, b in zip(s1, s2):
                if b > a:
                    y_pred[max(0, a):min(n2, b)] = 2  # systole
                    y_pred[max(0, a-5):min(n2, a+5)] = 1  # S1 narrow mark
            for i in range(min(len(s2), len(s1)-1)):
                a = s2[i]; b = s1[i+1]
                if b > a:
                    y_pred[max(0, a):min(n2, b)] = 4  # diastole
                    y_pred[max(0, a-5):min(n2, a+5)] = 3  # S2 narrow mark
            # trim to length
            if len(y_pred) > n2:
                y_pred = y_pred[:n2]
            if len(y_pred) < n2:
                y_pred = np.pad(y_pred, (0, n2 - len(y_pred)))
            segm = segmentation_scores(y_true, y_pred)
            best_macro_f1 = segm['macro_F1'] if (best_macro_f1 is None or segm['macro_F1'] > best_macro_f1) else best_macro_f1
            # murmur score aggregation per subject (max across locations)
            score = murmur_score(j.get('extras', {}))
            agg_score = max(agg_score, score)
            count_rec += 1
        if count_rec == 0:
            continue
        rows.append({'id': pid, 'label': label, 'macroF1': best_macro_f1, 'murmurScore': agg_score, 'locs': locs})
        if best_macro_f1 is not None:
            seg_metrics.append(best_macro_f1)

    # Overall metrics
    from sklearn.metrics import roc_auc_score
    scores = [r['murmurScore'] for r in rows if r['label'] is not None]
    labels = [r['label'] for r in rows if r['label'] is not None]
    auc = float(roc_auc_score(labels, scores)) if len(set(labels)) > 1 else None
    macroF1 = float(np.mean(seg_metrics)) if seg_metrics else None

    out = {
        'subjects': args.subjects,
        'perSubjectLocs': args.per_subject_locs,
        'counts': {
            'rows': len(rows),
            'labeledForMurmur': len(scores),
        },
        'metrics': {
            'murmurAUC': auc,
            'segMacroF1': macroF1,
        },
        'rowsSample': rows[:50],
    }
    os.makedirs(args.out, exist_ok=True)
    import datetime as dt
    path = os.path.join(args.out, f'run-{dt.datetime.utcnow().strftime("%Y%m%d-%H%M%S")}.json')
    with open(path, 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Saved:', path)


if __name__ == '__main__':
    main()
