#!/usr/bin/env python3
"""Phase A — train multi-label tag detectors + calibrate per-tag thresholds.

One independent one-vs-rest balanced-LogReg detector per tag over the v2
embeddings (the OvR generalisation of the single-label head). Each tag gets its
OWN calibrated threshold so a note is tagged with every tag whose detector fires.

Why per-tag thresholds: the balanced detectors' raw probabilities are not
comparable across tags (recall-rich but mis-scaled), so we calibrate each tag's
threshold on held-out CV folds to a PRECISION-LOWER-BOUND target with a recall
floor. precision-LB is pessimistic (single-label GT counts a correct SECONDARY
tag as a false positive), so true precision runs higher — validated by the LLM
audit (overall 62.5% true vs 45% LB at the 70%-recall point).

Content Creation is DROPPED: it failed as a learnable distinction in BOTH
architectures (single-label F1 0.12; multi-label detector precision 21%). Its
~20 items are excluded from training; their content gets its topical tags.

Adjustment valves (tune over time):
  PRECISION_LB_TARGET — per-tag precision-LB floor the threshold aims for
  RECALL_FLOOR        — don't raise a threshold past this recall

Exports <vault>/.roost/cache/tag-detectors.json (version 2):
  { tags: string[], W: (T x 768), b: (T), thresholds: (T), norm: "l2", version: 2 }

Run: ROOST_VAULT=<vault> python scripts/train-tag-detectors.py
"""
import json
import os

import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.model_selection import StratifiedKFold

DROP_TAGS = {"Content Creation"}          # abolished (unlearnable in both architectures)
PRECISION_LB_TARGET = 0.50                 # per-tag precision-LB floor (true precision runs higher)
RECALL_FLOOR = 0.35                        # don't raise a threshold below this recall
SEED = 1729


def load_xy(vault):
    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    labels, _ = L.load_honest_labels(vault)
    ids, X, y = [], [], []
    for iid, c in labels.items():
        if c in DROP_TAGS:
            continue
        v = cache.get(iid)
        if v is None:
            continue
        v = np.asarray(v, np.float64)
        n = np.linalg.norm(v)
        if n == 0 or not np.isfinite(v).all():
            continue
        ids.append(iid)
        X.append(v / n)
        y.append(c)
    return ids, np.array(X), np.array(y)


def calibrate_thresholds(X, y, classes):
    """CV per-tag threshold = lowest t with precision-LB >= target & recall >= floor;
    else the t maximising precision-LB subject to recall >= 0.20."""
    ci = {c: i for i, c in enumerate(classes)}
    prob = np.zeros((len(y), len(classes)))
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=SEED).split(X, y):
        o = OneVsRestClassifier(
            LogisticRegression(max_iter=1500, C=1, class_weight="balanced"), n_jobs=-1
        )
        o.fit(X[tr], y[tr])
        P = o.predict_proba(X[te])
        for j, gc in enumerate(o.classes_):
            prob[te, ci[gc]] = P[:, j]
    ti = np.array([ci[c] for c in y])
    grid = np.arange(0.10, 0.91, 0.025)
    thr, rows = np.zeros(len(classes)), []
    for j, c in enumerate(classes):
        p, istrue = prob[:, j], (ti == j)
        chosen, fallback = None, (0.0, grid[0])  # (best precLB, t)
        for t in grid:
            fire = p >= t
            tp = (fire & istrue).sum()
            fp = (fire & ~istrue).sum()
            fn = (~fire & istrue).sum()
            rec = tp / (tp + fn) if tp + fn else 0
            prc = tp / (tp + fp) if tp + fp else 0
            if prc > fallback[0] and rec >= 0.20:
                fallback = (prc, t)
            if chosen is None and prc >= PRECISION_LB_TARGET and rec >= RECALL_FLOOR:
                chosen = t
        t = chosen if chosen is not None else fallback[1]
        thr[j] = t
        fire = p >= t
        tp = (fire & istrue).sum()
        fp = (fire & ~istrue).sum()
        fn = (~fire & istrue).sum()
        rows.append((c, (istrue).sum(), t, tp / (tp + fn) if tp + fn else 0,
                     tp / (tp + fp) if tp + fp else 0))
    return thr, rows, prob, ti


def main():
    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        raise SystemExit("ROOST_VAULT not set")
    ids, X, y = load_xy(vault)
    classes = sorted(set(y))
    print(f"items={len(y)}  tags={len(classes)}  (dropped: {sorted(DROP_TAGS)})")

    thr, rows, prob, ti = calibrate_thresholds(X, y, classes)

    # production weights: train OvR on ALL data
    o = OneVsRestClassifier(
        LogisticRegression(max_iter=2000, C=1, class_weight="balanced"), n_jobs=-1
    )
    o.fit(X, y)
    # OneVsRest stores one binary estimator per class in classes_ order
    W = np.zeros((len(classes), X.shape[1]))
    b = np.zeros(len(classes))
    ci = {c: i for i, c in enumerate(classes)}
    for est, c in zip(o.estimators_, o.classes_):
        W[ci[c]] = est.coef_[0]
        b[ci[c]] = est.intercept_[0]

    print(f"\n{'tag':<18}{'n':>5}{'thr':>6}{'recall':>8}{'precLB':>8}")
    for c, n, t, rec, prc in sorted(rows, key=lambda r: r[0]):
        print(f"{c:<18}{n:>5}{t:>6.3f}{rec:>8.2f}{prc:>8.2f}")

    fires = prob >= thr
    print(f"\nsystem: avg tags/item {fires.sum(1).mean():.2f}  | 0-tag {100*(fires.sum(1)==0).mean():.0f}%"
          f"  | GT recovered {100*fires[np.arange(len(y)), ti].mean():.0f}%")

    out = os.path.join(vault, ".roost", "cache", "tag-detectors.json")
    json.dump({"tags": classes, "W": W.tolist(), "b": b.tolist(),
               "thresholds": thr.tolist(), "norm": "l2", "version": 2,
               "trainedOn": len(y)}, open(out, "w"))
    print(f"\nExported: {out}  ({len(classes)} detectors, version 2)")


if __name__ == "__main__":
    main()
