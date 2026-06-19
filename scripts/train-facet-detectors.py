#!/usr/bin/env python3
"""Lane F1 — train facet-tag detectors with RECALL-TARGET thresholds.

Phase-A finding: facet tags (Humor, Spicy, ...) are almost always SECONDARY tags
— they describe HOW something is presented, not WHAT it is.  The base-rate
deployment threshold in train-tag-detectors.py is tuned to control density on the
auto-item distribution; since these facet tags are rare in that distribution, the
quantile threshold ends up very high and barely fires.  A recall-target threshold
(set on the HONEST dev fold) is the right operating point for facets.

Approach:
  - Train one independent balanced-LogReg binary detector per facet tag over
    the v2 (L2-normalised) embeddings — identical to train-tag-detectors.py.
  - Calibrate each detector's threshold by RECALL TARGET on a held-out
    cross-validation fold, not by deployment base-rate.  This ensures the
    detector recovers ≥RECALL_TARGET of the facet items it sees, at the cost
    of some precision that the single-label GT cannot honestly grade anyway
    (since facet items are usually labelled by their PRIMARY topic in GT).
  - Export to <vault>/.roost/cache/facet-detectors.json in the same v2 format
    as tag-detectors.json:
        { tags: string[], W: (F x 768), b: (F), thresholds: (F), norm: "l2",
          version: 2, thresholdMode: "recall-target-cv", recallTarget: float }
  - Report per-facet CV recall (honest), fire-rate on a deployment sample, and
    a clear disclaimer about precision (single-label GT cannot grade facets).

FORWARD PASS (must match eval-tag-detectors.py / the TS plugin exactly):
    x_l2norm  = x / ||x||
    z_t       = W[t] · x_l2norm + b[t]   (per tag t)
    sigma_t   = 1 / (1 + exp(-z_t))
    fires     = sigma_t >= thresholds[t]

CAVEATS:
  - RECALL is honest (5-fold CV, held-out fold only).
  - PRECISION is NOT honest from single-label GT.  Single-label GT labels a
    Humor item as "Food" (e.g. funny recipe video); a Humor detector firing on
    that item is CORRECT but counted as FP.  True precision requires an LLM or
    human audit of "are ALL fired tags correct?" — that is the audit-tag-precision
    workflow, not this script.  precLB printed here is a pessimistic lower bound.
  - Fire-rate on the deployment sample measures raw density; it does NOT grade
    precision (unlabelled deployment items have no GT).

Adjustment valves:
  RECALL_TARGET      — minimum per-tag recall at the chosen threshold (CV)
  FIRE_RATE_CAP      — hard cap: threshold is never lowered past this fire-rate
  FACET_TAGS         — extend to add more facet tags (same format)
  DEPLOY_SAMPLE      — number of auto items used to measure fire-rate

Run: ROOST_VAULT=<vault> python scripts/train-facet-detectors.py
"""

import json
import os
import sys
from collections import Counter

import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict

# ── Configuration ─────────────────────────────────────────────────────────────

FACET_TAGS = ["Humor", "Spicy"]   # extend as more facets are validated
RECALL_TARGET = 0.70              # target recall on held-out CV fold per facet
FIRE_RATE_CAP = 0.60              # no facet fires on more than this fraction at deploy
DEPLOY_SAMPLE = 6000              # auto (unseen) items used to measure fire-rate
CV_FOLDS = 5                      # CV folds; rare tags get every example covered
SEED = 1729
LR_KWARGS = dict(max_iter=2000, C=1, class_weight="balanced", solver="lbfgs")


# ── Data loading ──────────────────────────────────────────────────────────────

def load_xy_all(vault):
    """Return (ids, X_l2norm, y_str) for all honest-labelled items (no tag filter).
    X is L2-normalised float64."""
    cache = L.load_cache(
        bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin")
    )
    labels, _ = L.load_honest_labels(vault)
    ids, X, y = [], [], []
    for iid, cat in labels.items():
        v = cache.get(iid)
        if v is None:
            continue
        v = np.asarray(v, np.float64)
        n = np.linalg.norm(v)
        if n == 0 or not np.isfinite(v).all():
            continue
        ids.append(iid)
        X.append(v / n)
        y.append(cat)
    return ids, np.array(X), np.array(y)


def load_deploy(vault, trained_ids):
    """Return L2-normalised embeddings for up to DEPLOY_SAMPLE auto (unseen) items."""
    import random
    random.seed(SEED)
    cache = L.load_cache(
        bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin")
    )
    unseen = [i for i in cache.keys() if i not in trained_ids]
    random.shuffle(unseen)
    rows = []
    for iid in unseen[:DEPLOY_SAMPLE]:
        v = np.asarray(cache[iid], np.float64)
        n = np.linalg.norm(v)
        if n > 0 and np.isfinite(v).all():
            rows.append(v / n)
    return np.array(rows)


# ── Per-facet binary classifier ───────────────────────────────────────────────

def train_binary(X, y_bin):
    """Fit a balanced LogReg on the full (X, y_bin) array.  Returns (coef, intercept)."""
    clf = LogisticRegression(**LR_KWARGS)
    clf.fit(X, y_bin)
    return clf.coef_[0], clf.intercept_[0]


def cv_proba(X, y_bin):
    """Return out-of-fold sigmoid probabilities via StratifiedKFold.
    Raises if the positive class is absent from any fold (too rare; handled below)."""
    clf = LogisticRegression(**LR_KWARGS)
    skf = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=SEED)
    proba = cross_val_predict(clf, X, y_bin, cv=skf, method="predict_proba")
    return proba[:, 1]   # positive-class probability


def recall_target_threshold(cv_proba_pos, y_bin, target=RECALL_TARGET):
    """Find the HIGHEST threshold t such that recall(t) >= target on the CV proba.
    Scans candidate thresholds from HIGH to LOW (descending).  Recall is monotone
    non-decreasing as the threshold falls, so the highest t with recall >= target
    is the operating point.  Falls back to the lowest observed probability (max
    recall) if even the lowest threshold can't reach the target."""
    positives = y_bin.astype(bool)
    n_pos = positives.sum()
    if n_pos == 0:
        return 0.5

    candidates = np.unique(cv_proba_pos)  # ascending
    # Fallback: use the lowest threshold (maximises recall regardless of target).
    best_thr = float(candidates[0])
    # Scan ascending: at each candidate, if recall >= target keep it as the new best.
    # Because recall is non-decreasing as threshold falls, scanning ascending gives us
    # all thresholds where recall drops; the LAST one where recall >= target is the best.
    for thr in candidates:          # ascending → recall decreases as thr rises
        rec = (cv_proba_pos[positives] >= thr).sum() / n_pos
        if rec >= target:
            best_thr = float(thr)   # this higher threshold still achieves recall target
    return best_thr


# ── Forward pass (canonical — must match eval-tag-detectors.py and the TS plugin) ──

def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def apply_detectors(X, W, b, thr):
    """X: (N, 768) L2-normalised.  Returns sigmoid scores (N, F) and fires bool."""
    z = X @ W.T + b          # (N, F)
    scores = sigmoid(z)       # (N, F)
    fires = scores >= thr     # (N, F)
    return scores, fires


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        raise SystemExit("ROOST_VAULT not set — run: ROOST_VAULT=<path> python scripts/train-facet-detectors.py")

    print("Loading honest labels + embeddings …")
    ids, X, y = load_xy_all(vault)
    counts = Counter(y)
    print(f"  total honest items: {len(y)}  |  unique tags: {len(set(y))}")

    # Filter to facets that actually exist in the label set.
    active_facets = [f for f in FACET_TAGS if f in counts]
    missing = [f for f in FACET_TAGS if f not in counts]
    if missing:
        print(f"  WARNING: facet(s) absent from honest labels (skipped): {missing}")
    if not active_facets:
        raise SystemExit("No facet tags found in honest labels — nothing to train.")
    print(f"  facets to train: {active_facets}")
    for f in active_facets:
        print(f"    {f}: {counts[f]} positive examples ({100*counts[f]/len(y):.1f}% base rate)")

    # Load deployment sample (fire-rate reference).
    print(f"\nLoading deployment sample (up to {DEPLOY_SAMPLE} auto items) …")
    deploy_X = load_deploy(vault, set(ids))
    print(f"  deployment items loaded: {len(deploy_X)}")

    W_rows, b_vals, thr_vals = [], [], []
    cv_recalls, cv_preclbs = {}, {}

    print(f"\n{'='*60}")
    print(f"Training facet detectors  (recall target = {RECALL_TARGET:.0%})")
    print(f"{'='*60}")

    for facet in active_facets:
        y_bin = (y == facet).astype(int)
        n_pos = y_bin.sum()
        n_neg = len(y_bin) - n_pos
        print(f"\n[{facet}]  pos={n_pos}  neg={n_neg}")

        # Out-of-fold CV probabilities for threshold calibration (honest).
        print(f"  Running {CV_FOLDS}-fold CV for threshold calibration …")
        try:
            oof_proba = cv_proba(X, y_bin)
        except Exception as e:
            print(f"  ERROR in CV: {e} — skipping {facet}")
            continue

        thr = recall_target_threshold(oof_proba, y_bin, RECALL_TARGET)
        oof_fires = oof_proba >= thr
        rec = (oof_fires & y_bin.astype(bool)).sum() / max(n_pos, 1)
        prec_lb = (oof_fires & y_bin.astype(bool)).sum() / max(oof_fires.sum(), 1)
        cv_recalls[facet] = float(rec)
        cv_preclbs[facet] = float(prec_lb)
        print(f"  CV threshold (recall-target): {thr:.4f}")
        print(f"  CV recall   (honest):         {rec:.2%}")
        print(f"  CV precLB   (pessimistic*):   {prec_lb:.2%}  *single-label GT undercounts")

        # Train on ALL honest labels (production weights).
        print(f"  Fitting production detector on full training set …")
        coef, intercept = train_binary(X, y_bin)
        W_rows.append(coef)
        b_vals.append(float(intercept))
        thr_vals.append(thr)

    if not W_rows:
        raise SystemExit("No facet detectors trained — aborting export.")

    W_arr = np.array(W_rows)      # (F, 768)
    b_arr = np.array(b_vals)      # (F,)
    thr_arr = np.array(thr_vals)  # (F,)

    # Fire-rate on deployment sample.
    print(f"\n{'='*60}")
    print(f"Deployment fire-rate  (deploy N={len(deploy_X)})")
    print(f"{'='*60}")
    if len(deploy_X) > 0:
        scores_d, fires_d = apply_detectors(deploy_X, W_arr, b_arr, thr_arr)
        print(f"\n{'facet':<14}{'recall(CV)':>11}{'precLB(CV)':>11}{'fire%@deploy':>14}  (note)")
        for i, facet in enumerate(active_facets):
            fire_rate = fires_d[:, i].mean()
            cap_warn = " <- near cap" if fire_rate > FIRE_RATE_CAP * 0.9 else ""
            print(
                f"{facet:<14}"
                f"{cv_recalls[facet]:>10.1%}"
                f"{cv_preclbs[facet]:>11.1%}"
                f"{fire_rate:>13.1%}"
                f"{cap_warn}"
            )
        avg_facets = fires_d.sum(1).mean()
        print(f"\n  avg facet tags/deploy item: {avg_facets:.2f}")
        print(f"  items with >=1 facet tag:   {100*(fires_d.sum(1) >= 1).mean():.1f}%")
    else:
        print("  (no deployment items found; fire-rate unavailable)")

    # ── Precision caveat ──────────────────────────────────────────────────────
    print(f"""
PRECISION NOTE:
  The precLB above is computed from single-label GT.  Facet tags (Humor, Spicy)
  are almost always SECONDARY: a funny recipe video is labelled "Food" in GT but
  a Humor detector firing on it is CORRECT.  Single-label GT counts that as FP,
  so precLB severely understates true precision.

  True precision requires the LLM audit workflow (audit-tag-precision):
    - Sample ~50 items where each facet fired.
    - Ask the LLM: "Is this item genuinely Humorous/Spicy?"
    - Report LLM-precision alongside recall-CV.

  Do NOT use precLB here as the headline precision for facet tags.
""")

    # ── Export ────────────────────────────────────────────────────────────────
    out_dir = os.path.join(vault, ".roost", "cache")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "facet-detectors.json")
    payload = {
        "tags": active_facets,
        "W": W_arr.tolist(),
        "b": b_arr.tolist(),
        "thresholds": thr_arr.tolist(),
        "norm": "l2",
        "version": 2,
        "thresholdMode": "recall-target-cv",
        "recallTarget": RECALL_TARGET,
        "cvFolds": CV_FOLDS,
        "trainedOn": int(len(y)),
        "deployFireRates": (
            {active_facets[i]: float(fires_d[:, i].mean()) for i in range(len(active_facets))}
            if len(deploy_X) > 0 else {}
        ),
    }
    with open(out_path, "w") as fh:
        json.dump(payload, fh)
    print(f"Exported: {out_path}  ({len(active_facets)} facet detectors, version 2)")
    print(f"  forward pass: x_l2norm -> z = W·x + b -> sigmoid(z) >= thresholds[t]")


if __name__ == "__main__":
    main()
