#!/usr/bin/env python3
"""Train a multinomial LogReg classifier head on v2 L2-normalised embeddings and
export weights to <vault>/.roost/cache/classifier-head.json.

Two modes:
  --split dev      Train on the dev fixture only (contamination-safe eval mode).
                   Use this to produce weights for eval-classifier-head-predictions.py.
  --split all      Train on ALL honest collection-labelled items (production mode).
                   Use this for the shipped classifier-head.json.

Reuses honest_eval_lib (label loading + embedding cache).  Does NOT duplicate
any logic from classifier-head-diagnostic.py — the l2_normalize helper is
reproduced here because it is trivial and diagnostic.py is not a library.

Run:
  ROOST_VAULT=<vault> python scripts/train-classifier-head.py --split dev
  ROOST_VAULT=<vault> python scripts/train-classifier-head.py --split all

Output format (classifier-head.json):
  {
    "classes": [str, ...],          # C sorted class names
    "W": [[float, ...], ...],       # C x 768 float32 weight matrix
    "b": [float, ...],              # C float32 bias vector
    "dim": 768,
    "norm": "l2",
    "trainedOn": int,               # number of training items
    "version": 1
  }

Forward pass (faithful to TS):
  z = W . x_l2norm + b   (C-vector)
  probs = softmax(z)
  category = classes[argmax(probs)]
  confidence = max(probs)
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

sys.path.insert(0, str(Path(__file__).parent))
import honest_eval_lib as L

# 19 consolidated canonical categories (taxonomy governance 2026-06-18).
CANONICAL_CATS = {
    "Art", "Content Creation", "Crafts", "Design", "Fashion", "Fitness",
    "Food", "Growth", "Humor", "Lifestyle", "Media", "Money", "Other",
    "Places & Travel", "Products", "Quotes", "Relationships", "Spicy", "Tech",
}


def l2_normalize(X):
    """Row-wise L2 normalization.  X must be 2-D (N, D)."""
    if X.ndim != 2 or X.shape[0] == 0:
        raise ValueError(
            f"l2_normalize: expected 2-D array with at least one row, got shape {X.shape}"
        )
    n = np.linalg.norm(X, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return X / n


def build_matrix_from_labels(labels, cache):
    """Build (X_norm, y_arr) from a {roost_id: category} dict + embedding cache.
    Only items in CANONICAL_CATS with usable vectors are included.
    Returns (X_norm float32, y list[str], n_skipped dict)."""
    rows, ys = [], []
    skipped = {"missing": 0, "nan": 0, "zero": 0, "non_canon": 0}
    for rid, cat in labels.items():
        if cat not in CANONICAL_CATS:
            skipped["non_canon"] += 1
            continue
        v = cache.get(rid)
        if v is None:
            skipped["missing"] += 1
            continue
        v = np.asarray(v, dtype=np.float32)
        if not np.all(np.isfinite(v)):
            skipped["nan"] += 1
            continue
        if float(np.linalg.norm(v)) == 0.0:
            skipped["zero"] += 1
            continue
        rows.append(v)
        ys.append(cat)
    if not rows:
        raise ValueError(
            "No usable embedding vectors found.  Check embedding cache and honest labels."
        )
    X = l2_normalize(np.array(rows, dtype=np.float32))
    assert np.all(np.isfinite(X)), "Training matrix has non-finite values after normalize"
    return X, ys, skipped


def build_matrix_from_fixture(build_dir, split, cache):
    """Build (X_norm, y_arr) from a fixture split + embedding cache.
    Only positive items in CANONICAL_CATS with usable vectors are included."""
    items = L.load_fixture(str(build_dir), split)
    pos = [ti for ti in items
           if not ti.get("isNegative") and ti.get("groundTruth") in CANONICAL_CATS]
    if not pos:
        raise ValueError(
            f"No positive CANONICAL_CATS items in fixture split '{split}'. "
            "Check fixture file and category names."
        )
    rows, ys = [], []
    skipped = {"missing": 0, "nan": 0, "zero": 0}
    for ti in pos:
        rid = ti["id"]
        v = cache.get(rid)
        if v is None:
            skipped["missing"] += 1
            continue
        v = np.asarray(v, dtype=np.float32)
        if not np.all(np.isfinite(v)):
            skipped["nan"] += 1
            continue
        if float(np.linalg.norm(v)) == 0.0:
            skipped["zero"] += 1
            continue
        rows.append(v)
        ys.append(ti["groundTruth"])
    if not rows:
        raise ValueError(
            f"No usable embedding vectors for fixture split '{split}'."
        )
    X = l2_normalize(np.array(rows, dtype=np.float32))
    assert np.all(np.isfinite(X)), "Training matrix has non-finite values after normalize"
    return X, ys, skipped


def train_logreg(X, y):
    """Fit multinomial LogReg C=1 (M0 winner) on pre-normalised X.
    Returns (clf, classes list[str])."""
    clf = LogisticRegression(
        max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1
    )
    clf.fit(X, y)
    # clf.classes_ is sorted by sklearn; cast to str for safety
    classes = [str(c) for c in clf.classes_]
    return clf, classes


def export_weights(clf, classes, dim, out_path, trained_on):
    """Export weights to classifier-head.json in the documented format.
    W is stored as a Python list-of-lists (C x dim float32 → float64 for JSON).
    b is a list (C floats).
    """
    W = clf.coef_.tolist()        # (C, dim) ndarray → list[list[float]]
    b = clf.intercept_.tolist()   # (C,) ndarray → list[float]

    payload = {
        "classes": classes,
        "W": W,
        "b": b,
        "dim": dim,
        "norm": "l2",
        "trainedOn": trained_on,
        "version": 1,
    }
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return out_path


def main():
    ap = argparse.ArgumentParser(
        description=(
            "Train a multinomial LogReg classifier head on v2 L2-normalised embeddings "
            "and export to classifier-head.json."
        )
    )
    ap.add_argument(
        "--split",
        required=True,
        choices=["dev", "all"],
        help=(
            "dev  = train on dev fixture only (contamination-safe eval mode); "
            "all  = train on ALL honest collection-labelled items (production mode)."
        ),
    )
    args = ap.parse_args()

    vault_env = os.environ.get("ROOST_VAULT")
    if vault_env:
        VAULT = Path(vault_env)
    else:
        VAULT = Path.home() / "ObsidianBookmarks"
    ROOST = VAULT / ".roost"
    BUILD_DIR = ROOST / "build"
    BIN_CACHE = ROOST / "cache" / "embedding-vectors.bin"
    OUT_PATH = ROOST / "cache" / "classifier-head.json"

    print("train-classifier-head.py")
    print("=" * 60)
    print(f"Vault:     {VAULT}")
    print(f"Mode:      --split {args.split}")
    print(f"Cache:     {BIN_CACHE}")
    print(f"Output:    {OUT_PATH}")

    t0 = time.time()

    # ── Load embedding cache ─────────────────────────────────────────────────
    cache = L.load_cache(bin_path=str(BIN_CACHE))
    print(f"Loaded embedding cache: {len(cache)} items  ({time.time()-t0:.1f}s)")

    dim = 768  # v2 embedding dimension (confirmed by embedding-meta.json)

    # ── Build training matrix ─────────────────────────────────────────────────
    L.assert_gt_not_roost_category("collection")  # tripwire

    if args.split == "dev":
        # Contamination guard: assert dev ∩ holdout = ∅ before using either split.
        dev_ids_all = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "dev")]
        hld_ids_all = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "holdout")]
        L.assert_disjoint(dev_ids_all, hld_ids_all)

        X, y, skipped = build_matrix_from_fixture(BUILD_DIR, "dev", cache)
        print(
            f"Fixture dev: {len(X)} training items  "
            f"(skipped: {skipped['missing']} missing, "
            f"{skipped['nan']} nan/inf, {skipped['zero']} zero-norm)"
        )
    else:  # all
        # Production mode: train on every honest collection-labelled item.
        labels, _negatives = L.load_honest_labels(str(VAULT))
        X, y, skipped = build_matrix_from_labels(labels, cache)
        print(
            f"All honest labels: {len(X)} training items  "
            f"(skipped: {skipped['missing']} missing, "
            f"{skipped['nan']} nan/inf, {skipped['zero']} zero-norm, "
            f"{skipped['non_canon']} non-canonical)"
        )

    classes_present = sorted(set(y))
    print(f"Train size: {len(X)}    Classes: {len(classes_present)}")
    if len(classes_present) < len(CANONICAL_CATS):
        missing = sorted(CANONICAL_CATS - set(classes_present))
        print(f"  WARNING: {len(missing)} canonical categories absent from training data: {missing}")

    # ── Train ─────────────────────────────────────────────────────────────────
    print(f"\nTraining LogReg C=1 (multinomial, lbfgs, max_iter=2000)...")
    t1 = time.time()
    clf, classes = train_logreg(X, y)
    print(f"  Done in {time.time()-t1:.1f}s  —  {len(classes)} output classes")

    # Sanity: quick in-sample accuracy (training set, not a real eval metric).
    y_pred = clf.predict(X)
    in_sample_acc = float(np.mean(y_pred == np.array(y)))
    print(f"  In-sample accuracy: {in_sample_acc*100:.1f}%  (informational only)")

    # ── Export ────────────────────────────────────────────────────────────────
    out_path = export_weights(clf, classes, dim, OUT_PATH, trained_on=len(X))
    print(f"\nExported: {out_path}")
    print(f"  classes={len(classes)}  W shape=({len(classes)}, {dim})  trainedOn={len(X)}")
    print(f"  version=1  norm=l2")
    print(f"\nTotal time: {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
