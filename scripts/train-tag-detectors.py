#!/usr/bin/env python3
"""Phase A — train multi-label tag detectors + calibrate per-tag thresholds.

One independent one-vs-rest balanced-LogReg detector per tag over the v2
embeddings (the OvR generalisation of the single-label head). Each tag gets its
OWN calibrated threshold so a note is tagged with every tag whose detector fires.

Why per-tag thresholds on the DEPLOYMENT distribution: the balanced detectors'
raw probabilities are mis-scaled AND the deployment set (auto items) is OOD vs
the curated honest labels, so honest-CV-calibrated thresholds over-fire badly at
deploy time (measured: 6.9 tags/item). Instead we set each tag's threshold by its
BASE RATE on the deployment distribution: tag C fires on ~base_rate(C) * MULT of
deployment items. This controls density (≈1.8 tags/item) regardless of score
scale. The LLM audit measured ~62.5% true precision at this density (vs a
pessimistic 45% single-label LB).

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
from collections import Counter

import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.model_selection import StratifiedKFold

DROP_TAGS = {"Content Creation"}          # abolished (unlearnable in both architectures)
BASE_RATE_MULT = 1.8                       # tag fires at ~base_rate * this on the deployment set
FIRE_RATE_CAP = 0.45                       # no tag fires on more than this fraction of items
DEPLOY_SAMPLE = 6000                       # auto (unseen) items used to calibrate thresholds
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


def fit_ovr(X, y, classes):
    o = OneVsRestClassifier(
        LogisticRegression(max_iter=2000, C=1, class_weight="balanced"), n_jobs=-1
    )
    o.fit(X, y)
    ci = {c: i for i, c in enumerate(classes)}
    W = np.zeros((len(classes), X.shape[1]))
    b = np.zeros(len(classes))
    for est, c in zip(o.estimators_, o.classes_):
        W[ci[c]] = est.coef_[0]
        b[ci[c]] = est.intercept_[0]
    return W, b


def base_rate_thresholds(W, b, classes, base_counts, deploy_X):
    """Per-tag threshold = the score quantile on the DEPLOYMENT set such that the
    tag fires at ~base_rate(tag) * BASE_RATE_MULT (capped). Robust to score scale
    and to the honest->deploy distribution shift."""
    scores = 1.0 / (1.0 + np.exp(-(deploy_X @ W.T + b)))  # (M, T) sigmoid
    ntot = sum(base_counts.values())
    thr = np.zeros(len(classes))
    for j, c in enumerate(classes):
        target = min(base_counts.get(c, 0) / ntot * BASE_RATE_MULT, FIRE_RATE_CAP)
        thr[j] = np.quantile(scores[:, j], 1 - target) if target > 0 else 1.0
    return thr


def cv_recall_at_k(X, y, classes, ks=(1, 2, 3)):
    """Honest (threshold-free) recall@k via CV — the recall reference, since the
    production weights see all honest labels and can't be scored on them directly."""
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
    order = np.argsort(-prob, axis=1)
    ti = np.array([ci[c] for c in y])
    return {k: float(np.mean([ti[i] in order[i, :k] for i in range(len(y))])) for k in ks}


def load_deploy(vault, trained_ids):
    """A sample of auto (unseen) item embeddings — the deployment distribution."""
    import random
    random.seed(SEED)
    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    unseen = [i for i in cache.keys() if i not in trained_ids]
    random.shuffle(unseen)
    rows = []
    for iid in unseen[:DEPLOY_SAMPLE]:
        v = np.asarray(cache[iid], np.float64)
        n = np.linalg.norm(v)
        if n > 0 and np.isfinite(v).all():
            rows.append(v / n)
    return np.array(rows)


def main():
    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        raise SystemExit("ROOST_VAULT not set")
    ids, X, y = load_xy(vault)
    classes = sorted(set(y))
    base = Counter(y)
    print(f"items={len(y)}  tags={len(classes)}  (dropped: {sorted(DROP_TAGS)})")

    W, b = fit_ovr(X, y, classes)                         # production weights
    deploy_X = load_deploy(vault, set(ids))               # deployment distribution
    thr = base_rate_thresholds(W, b, classes, base, deploy_X)
    recall = cv_recall_at_k(X, y, classes)                # honest recall reference

    scores = 1.0 / (1.0 + np.exp(-(deploy_X @ W.T + b)))
    fires = scores >= thr
    print(f"\n{'tag':<18}{'n':>5}{'thr':>7}{'fire%':>7}")
    for j, c in enumerate(classes):
        print(f"{c:<18}{base[c]:>5}{thr[j]:>7.3f}{100*fires[:, j].mean():>6.0f}%")
    print(f"\ndeployment density: avg tags/item {fires.sum(1).mean():.2f}  | "
          f"0-tag {100*(fires.sum(1) == 0).mean():.0f}%  | median {int(np.median(fires.sum(1)))}")
    print(f"honest recall (CV, threshold-free): @1 {recall[1]:.0%}  @2 {recall[2]:.0%}  @3 {recall[3]:.0%}")

    out = os.path.join(vault, ".roost", "cache", "tag-detectors.json")
    json.dump({"tags": classes, "W": W.tolist(), "b": b.tolist(),
               "thresholds": thr.tolist(), "norm": "l2", "version": 2,
               "thresholdMode": "base-rate-deployment", "thresholdMult": BASE_RATE_MULT,
               "trainedOn": len(y)}, open(out, "w"))
    print(f"\nExported: {out}  ({len(classes)} detectors, version 2)")


if __name__ == "__main__":
    main()
