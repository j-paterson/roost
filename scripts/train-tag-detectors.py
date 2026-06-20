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

FACET TAGS (--facets): Tags supplied via --facets are tone/facet categories
(e.g. Humor, Spicy) that are almost always secondary labels.  Their base-rate on
the deployment distribution is very low, so the base-rate quantile produces a
threshold that barely fires (~1-2%).  For facet tags we instead use a
RECALL-TARGET threshold calibrated on the honest CV fold (ported from
train-facet-detectors.py): the highest threshold t such that recall(t) >= 0.70
on the out-of-fold CV probabilities.  This makes Humor/Spicy fire at a
meaningful rate while keeping non-facet tag thresholds unchanged.

Content Creation is DROPPED: it failed as a learnable distinction in BOTH
architectures (single-label F1 0.12; multi-label detector precision 21%). Its
~20 items are excluded from training; their content gets its topical tags.

Adjustment valves (tune over time):
  PRECISION_LB_TARGET — per-tag precision-LB floor the threshold aims for
  RECALL_FLOOR        — don't raise a threshold past this recall

Exports <vault>/.roost/cache/tag-detectors.json (version 2):
  { tags: string[], W: (T x 768), b: (T), thresholds: (T), norm: "l2", version: 2 }

Run: ROOST_VAULT=<vault> python scripts/train-tag-detectors.py [--facets "Humor,Spicy"]
"""
import argparse
import json
import os
from collections import Counter

import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict

DROP_TAGS = {"Content Creation"}          # abolished (unlearnable in both architectures)
BASE_RATE_MULT = 1.8                       # default: tag fires at ~base_rate * this on deployment
FIRE_RATE_CAP = 0.45                       # no tag fires on more than this fraction of items
DEPLOY_SAMPLE = 6000                       # auto (unseen) items used to calibrate thresholds
SEED = 1729

# Facet threshold calibration (used only for tags listed in --facets).
FACET_RECALL_TARGET = 0.70                 # minimum CV recall for facet tags
FACET_CV_FOLDS = 5                        # folds for facet threshold calibration
LR_KWARGS = dict(max_iter=2000, C=1, class_weight="balanced", solver="lbfgs")

# Per-tag multiplier overrides (adjustment valve). Lower = higher threshold = fires less.
# CURRENTLY EMPTY (uniform): an earlier audit-driven tightening was REVERTED — it traded
# GROUND-TRUTH recall (79%->75%) for a flawed LLM-audit precision. The audit is a proxy and is
# UNRELIABLE for uncensored/explicit categories: the cloud judge refuses to validate
# sexually-explicit content, so "Spicy 0-17% precision" was judge refusal, not detector failure
# (Spicy's real GT-recall is 73%). Any future per-tag tuning must be driven by a RELIABLE signal
# (the human `collection` GT, or a non-refusing/local judge for uncensored content), never the
# refusing cloud audit.
PER_TAG_MULT = {}


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


def cv_proba_binary(X, y_bin):
    """Out-of-fold sigmoid probabilities for a single binary detector via StratifiedKFold."""
    clf = LogisticRegression(**LR_KWARGS)
    skf = StratifiedKFold(n_splits=FACET_CV_FOLDS, shuffle=True, random_state=SEED)
    proba = cross_val_predict(clf, X, y_bin, cv=skf, method="predict_proba")
    return proba[:, 1]   # positive-class probability


def recall_target_threshold(cv_proba_pos, y_bin, target=FACET_RECALL_TARGET):
    """Find the HIGHEST threshold t such that CV recall(t) >= target.
    Scans candidate thresholds ascending (recall decreases as threshold rises);
    keeps the last one where recall >= target.  Ported from train-facet-detectors.py."""
    positives = y_bin.astype(bool)
    n_pos = positives.sum()
    if n_pos == 0:
        return 0.5
    candidates = np.unique(cv_proba_pos)   # ascending
    best_thr = float(candidates[0])        # fallback: lowest thr = max recall
    for thr in candidates:
        rec = (cv_proba_pos[positives] >= thr).sum() / n_pos
        if rec >= target:
            best_thr = float(thr)
    return best_thr


def base_rate_thresholds(W, b, classes, base_counts, deploy_X):
    """Per-tag threshold = the score quantile on the DEPLOYMENT set such that the
    tag fires at ~base_rate(tag) * BASE_RATE_MULT (capped). Robust to score scale
    and to the honest->deploy distribution shift."""
    scores = 1.0 / (1.0 + np.exp(-(deploy_X @ W.T + b)))  # (M, T) sigmoid
    ntot = sum(base_counts.values())
    thr = np.zeros(len(classes))
    for j, c in enumerate(classes):
        mult = PER_TAG_MULT.get(c, BASE_RATE_MULT)
        target = min(base_counts.get(c, 0) / ntot * mult, FIRE_RATE_CAP)
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
    ap = argparse.ArgumentParser(description="Train multi-label tag detectors + calibrate thresholds.")
    ap.add_argument(
        "--facets", default="",
        help="Comma-separated facet/tone tag names (e.g. 'Humor,Spicy'). "
             "These get recall-target thresholds (CV) instead of base-rate thresholds. "
             "Matches settings.facetCategories.",
    )
    args = ap.parse_args()
    facet_set = {f.strip() for f in args.facets.split(",") if f.strip()}

    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        raise SystemExit("ROOST_VAULT not set")
    ids, X, y = load_xy(vault)
    classes = sorted(set(y))
    base = Counter(y)
    print(f"items={len(y)}  tags={len(classes)}  (dropped: {sorted(DROP_TAGS)})")
    if facet_set:
        active_facets = [c for c in classes if c in facet_set]
        unknown = facet_set - set(classes)
        if unknown:
            print(f"WARNING: --facets tags not in training set (ignored): {sorted(unknown)}")
        print(f"Facet tags (recall-target thresholds): {active_facets}")
    else:
        active_facets = []

    W, b = fit_ovr(X, y, classes)                         # production weights
    deploy_X = load_deploy(vault, set(ids))               # deployment distribution

    # Base-rate thresholds for all tags (starting point).
    thr = base_rate_thresholds(W, b, classes, base, deploy_X)

    # For facet tags: override with recall-target threshold calibrated on honest CV fold.
    facet_cv_recalls = {}
    if active_facets:
        print(f"\nCalibrating recall-target thresholds for facets "
              f"(target={FACET_RECALL_TARGET:.0%}, {FACET_CV_FOLDS}-fold CV)…")
        for c in active_facets:
            j = classes.index(c)
            y_bin = (y == c).astype(int)
            n_pos = y_bin.sum()
            print(f"  [{c}] pos={n_pos} neg={len(y_bin)-n_pos}")
            oof_proba = cv_proba_binary(X, y_bin)
            cv_thr = recall_target_threshold(oof_proba, y_bin, FACET_RECALL_TARGET)
            positives = y_bin.astype(bool)
            cv_recall = (oof_proba[positives] >= cv_thr).sum() / max(n_pos, 1)
            facet_cv_recalls[c] = float(cv_recall)
            old_thr = thr[j]
            thr[j] = cv_thr
            print(f"    base-rate thr={old_thr:.4f} -> recall-target thr={cv_thr:.4f}  "
                  f"(CV recall={cv_recall:.1%})")

    recall = cv_recall_at_k(X, y, classes)                # honest recall reference

    scores = 1.0 / (1.0 + np.exp(-(deploy_X @ W.T + b)))
    fires = scores >= thr
    print(f"\n{'tag':<18}{'n':>5}{'thr':>7}{'fire%':>7}{'mode':<20}")
    for j, c in enumerate(classes):
        mode = "recall-target" if c in facet_set else "base-rate"
        extra = f" [CV recall={facet_cv_recalls[c]:.0%}]" if c in facet_cv_recalls else ""
        print(f"{c:<18}{base[c]:>5}{thr[j]:>7.3f}{100*fires[:, j].mean():>6.0f}%  {mode}{extra}")
    print(f"\ndeployment density: avg tags/item {fires.sum(1).mean():.2f}  | "
          f"0-tag {100*(fires.sum(1) == 0).mean():.0f}%  | median {int(np.median(fires.sum(1)))}")
    print(f"honest recall (CV, threshold-free): @1 {recall[1]:.0%}  @2 {recall[2]:.0%}  @3 {recall[3]:.0%}")

    out = os.path.join(vault, ".roost", "cache", "tag-detectors.json")
    payload = {
        "tags": classes,
        "W": W.tolist(),
        "b": b.tolist(),
        "thresholds": thr.tolist(),
        "norm": "l2",
        "version": 2,
        "thresholdMode": "mixed" if active_facets else "base-rate-deployment",
        "thresholdMult": BASE_RATE_MULT,
        "trainedOn": len(y),
    }
    if active_facets:
        payload["facetTags"] = active_facets
        payload["facetRecallTarget"] = FACET_RECALL_TARGET
        payload["facetThresholdMode"] = "recall-target-cv"
    json.dump(payload, open(out, "w"))
    print(f"\nExported: {out}  ({len(classes)} detectors, version 2)")


if __name__ == "__main__":
    main()
