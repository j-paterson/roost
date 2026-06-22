#!/usr/bin/env python3
"""Train two base LogReg classifier heads (text-only + vision-on) plus a meta-head
over their out-of-fold softmax predictions, and export three JSON files consumed
by the TypeScript stacked-heads loader (loadStackedHeads / classifyStacked).

Output files written to <vault>/.roost/cache/:
  classifier-head-text.json   — ClassifierHeadData (same shape as classifier-head.json)
  classifier-head-vision.json — ClassifierHeadData (same shape as classifier-head.json)
  meta-head.json              — MetaHeadData  { classes, W (C×2C), b (C), inDim:2C,
                                                norm:"none", version:1 }

Feature order in the meta is **[p_text(C), p_vision(C)]** — concatenate the text
head's OOF softmax probabilities FIRST, then the vision head's.  The TS
classifyStacked() function mirrors this order:
    feat = [...pText, ...pVision]
Swapping the order would silently corrupt every prediction.

Two modes:
  --split dev    Train on the dev fixture only (contamination-safe eval mode).
  --split all    Train on ALL honest collection-labelled items (production mode,
                 recommended for shipping).

Prerequisites:
  embedding-vectors-text.bin  — text-only (no vision) embeddings (produced by Task 7
                                 backfill; run train-stacked-heads.py AFTER that step)
  embedding-vectors.bin       — vision-on embeddings (already exists)
  Both binary caches must be keyed by the same roost_id ordering.

Run:
  ROOST_VAULT=<vault> python scripts/train-stacked-heads.py --split all

Forward pass (mirrors TS classifyStacked exactly):
  # Base heads
  x_norm   = x / ||x||₂
  z[c]     = dot(W[c], x_norm) + b[c]
  p        = softmax(z)            # C probabilities

  # Meta
  feat     = [p_text(C), p_vision(C)]   # length 2C
  z_meta   = W_meta · feat + b_meta     # C logits
  p_meta   = softmax(z_meta)
  category = classes[argmax(p_meta)]
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import LabelEncoder

sys.path.insert(0, str(Path(__file__).parent))
import honest_eval_lib as L

# 19 consolidated canonical categories (taxonomy governance 2026-06-18).
# VERBATIM copy from train-classifier-head.py — do not modify without updating both.
CANONICAL_CATS = {
    "Art", "Content Creation", "Crafts", "Design", "Fashion", "Fitness",
    "Food", "Growth", "Humor", "Lifestyle", "Media", "Money", "Other",
    "Places & Travel", "Products", "Quotes", "Relationships", "Spicy", "Tech",
}


# ── Utilities (copied verbatim from train-classifier-head.py) ─────────────────

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
    Returns (X_norm float32, y list[str], ids list[str], n_skipped dict)."""
    rows, ys, ids = [], [], []
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
        ids.append(rid)
    if not rows:
        raise ValueError(
            "No usable embedding vectors found.  Check embedding cache and honest labels."
        )
    X = l2_normalize(np.array(rows, dtype=np.float32))
    assert np.all(np.isfinite(X)), "Training matrix has non-finite values after normalize"
    return X, ys, ids, skipped


def build_matrix_from_fixture(build_dir, split, cache):
    """Build (X_norm, y_arr, ids) from a fixture split + embedding cache.
    Only positive items in CANONICAL_CATS with usable vectors are included."""
    items = L.load_fixture(str(build_dir), split)
    pos = [ti for ti in items
           if not ti.get("isNegative") and ti.get("groundTruth") in CANONICAL_CATS]
    if not pos:
        raise ValueError(
            f"No positive CANONICAL_CATS items in fixture split '{split}'. "
            "Check fixture file and category names."
        )
    rows, ys, ids = [], [], []
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
        ids.append(rid)
    if not rows:
        raise ValueError(
            f"No usable embedding vectors for fixture split '{split}'."
        )
    X = l2_normalize(np.array(rows, dtype=np.float32))
    assert np.all(np.isfinite(X)), "Training matrix has non-finite values after normalize"
    return X, ys, ids, skipped


def train_logreg(X, y, balanced=False):
    """Fit multinomial LogReg C=1 (M0 winner) on pre-normalised X.
    balanced=True upweights rare classes (class_weight='balanced').
    Returns (clf, classes list[str])."""
    clf = LogisticRegression(
        max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1,
        class_weight="balanced" if balanced else None,
    )
    clf.fit(X, y)
    classes = [str(c) for c in clf.classes_]
    return clf, classes


def export_weights(clf, classes, dim, out_path, trained_on):
    """Export weights to classifier-head-{text,vision}.json in ClassifierHeadData format.
    W is stored as a Python list-of-lists (C x dim float32 → float64 for JSON).
    b is a list (C floats).
    Identical to train-classifier-head.py's export_weights.
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


def export_meta_weights(clf, classes, out_path):
    """Export meta-head weights to meta-head.json.

    Schema (MetaHeadData):
      {
        "classes": [str, ...],    # C sorted class names
        "W": [[float, ...], ...], # C x 2C weight matrix  (inDim = 2*C)
        "b": [float, ...],        # C floats
        "inDim": int,             # 2 * C
        "norm": "none",           # no normalisation — input is already softmax probs
        "version": 1
      }

    The meta input vector is:
        feat = [p_text(C), p_vision(C)]     # length 2C
    This matches the TS classifyStacked: feat = [...pText, ...pVision]
    """
    C = len(classes)
    in_dim = 2 * C
    W = clf.coef_.tolist()        # shape (C, 2C)
    b = clf.intercept_.tolist()   # shape (C,)

    # Validate shape before writing
    assert len(W) == C, f"meta W has {len(W)} rows, expected {C}"
    for i, row in enumerate(W):
        assert len(row) == in_dim, (
            f"meta W[{i}] has {len(row)} cols, expected {in_dim} (2*C)"
        )

    payload = {
        "classes": classes,
        "W": W,
        "b": b,
        "inDim": in_dim,
        "norm": "none",
        "version": 1,
    }
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return out_path


# ── OOF softmax helper ────────────────────────────────────────────────────────

def oof_softmax_proba(X, y_enc, classes, n_splits=5, balanced=False):
    """Produce out-of-fold softmax probability matrix via StratifiedKFold.

    The meta-head is trained on this matrix so it never sees an item's own
    base prediction (which would let it memorise training data).

    Parameters
    ----------
    X       : (N, dim) float32 — pre-L2-normalised embeddings
    y_enc   : (N,) int        — label-encoded class indices
    classes : list[str]       — class names aligned with y_enc
    n_splits: int             — number of CV folds (default 5)
    balanced: bool            — use class_weight='balanced' in each fold

    Returns
    -------
    P_oof : (N, C) float64   — softmax probabilities, aligned with `classes`
    """
    C = len(classes)
    N = len(X)
    P_oof = np.zeros((N, C), dtype=np.float64)

    le = LabelEncoder()
    le.classes_ = np.array(classes)  # use the fixed class order

    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
    for fold_idx, (train_idx, val_idx) in enumerate(skf.split(X, y_enc)):
        X_tr, X_val = X[train_idx], X[val_idx]
        y_tr = [classes[i] for i in y_enc[train_idx]]
        clf_fold = LogisticRegression(
            max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1,
            class_weight="balanced" if balanced else None,
        )
        clf_fold.fit(X_tr, y_tr)

        # Map fold probabilities back to the global class order
        fold_classes = list(clf_fold.classes_)
        fold_proba = clf_fold.predict_proba(X_val)  # (|val|, |fold_classes|)
        for global_c, cls in enumerate(classes):
            if cls in fold_classes:
                fc = fold_classes.index(cls)
                P_oof[val_idx, global_c] = fold_proba[:, fc]
            # else: probability stays 0.0 (class absent from this fold's training set)

    return P_oof


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=(
            "Train two base LogReg heads (text-only + vision-on) plus a meta-head "
            "over their out-of-fold softmax predictions.  Exports three JSONs consumed "
            "by the TypeScript stacked-heads loader."
        )
    )
    ap.add_argument(
        "--split",
        required=True,
        choices=["dev", "all"],
        help=(
            "dev = train on dev fixture only (contamination-safe eval mode); "
            "all = train on ALL honest collection-labelled items (production mode)."
        ),
    )
    ap.add_argument(
        "--balanced", action="store_true",
        help="class_weight='balanced' — upweight rare classes to curb majority-class over-prediction",
    )
    ap.add_argument(
        "--n-folds", type=int, default=5,
        help="Number of StratifiedKFold folds for OOF meta-feature generation (default 5)",
    )
    ap.add_argument(
        "--out-text", default=None,
        help="Output path for classifier-head-text.json (default .roost/cache/classifier-head-text.json)",
    )
    ap.add_argument(
        "--out-vision", default=None,
        help="Output path for classifier-head-vision.json (default .roost/cache/classifier-head-vision.json)",
    )
    ap.add_argument(
        "--out-meta", default=None,
        help="Output path for meta-head.json (default .roost/cache/meta-head.json)",
    )
    ap.add_argument(
        "--bin-vision", default=None,
        help="Input vision-on embedding bin (default .roost/cache/embedding-vectors.bin). "
             "Its sibling embedding-meta.json supplies the dim.",
    )
    ap.add_argument(
        "--bin-text", default=None,
        help="Input text-only embedding bin (default .roost/cache/embedding-vectors-text.bin). "
             "Its sibling embedding-meta.json supplies the dim.",
    )
    args = ap.parse_args()

    vault_env = os.environ.get("ROOST_VAULT")
    if vault_env:
        VAULT = Path(vault_env)
    else:
        VAULT = Path.home() / "ObsidianBookmarks"
    ROOST = VAULT / ".roost"
    BUILD_DIR = ROOST / "build"
    BIN_TEXT = Path(args.bin_text) if args.bin_text else ROOST / "cache" / "embedding-vectors-text.bin"   # text-only (Task 7 backfill)
    BIN_VISION = Path(args.bin_vision) if args.bin_vision else ROOST / "cache" / "embedding-vectors.bin"   # vision-on (existing)
    OUT_TEXT = Path(args.out_text) if args.out_text else ROOST / "cache" / "classifier-head-text.json"
    OUT_VISION = Path(args.out_vision) if args.out_vision else ROOST / "cache" / "classifier-head-vision.json"
    OUT_META = Path(args.out_meta) if args.out_meta else ROOST / "cache" / "meta-head.json"

    print("train-stacked-heads.py")
    print("=" * 60)
    print(f"Vault:         {VAULT}")
    print(f"Mode:          --split {args.split}")
    print(f"Text cache:    {BIN_TEXT}")
    print(f"Vision cache:  {BIN_VISION}")
    print(f"Out text:      {OUT_TEXT}")
    print(f"Out vision:    {OUT_VISION}")
    print(f"Out meta:      {OUT_META}")
    print(f"OOF folds:     {args.n_folds}")
    print()

    t0 = time.time()

    # ── Contamination tripwire (verbatim from train-classifier-head.py) ──────
    L.assert_gt_not_roost_category("collection")

    # ── Load BOTH embedding caches ───────────────────────────────────────────
    print("Loading text-only embedding cache (embedding-vectors-text.bin)...")
    cache_text = L.load_cache(bin_path=str(BIN_TEXT))
    print(f"  {len(cache_text)} items  ({time.time()-t0:.1f}s)")

    print("Loading vision-on embedding cache (embedding-vectors.bin)...")
    cache_vision = L.load_cache(bin_path=str(BIN_VISION))
    print(f"  {len(cache_vision)} items  ({time.time()-t0:.1f}s)")

    dim = 768  # v2 embedding dimension (confirmed by embedding-meta.json)

    # ── Build training matrices ───────────────────────────────────────────────
    print()
    if args.split == "dev":
        # Contamination guard: assert dev ∩ holdout = ∅ before using either split.
        dev_ids_all = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "dev")]
        hld_ids_all = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "holdout")]
        L.assert_disjoint(dev_ids_all, hld_ids_all)

        X_text, y_text, ids_text, sk_text = build_matrix_from_fixture(BUILD_DIR, "dev", cache_text)
        X_vision, y_vision, ids_vision, sk_vision = build_matrix_from_fixture(BUILD_DIR, "dev", cache_vision)
        split_label = "dev fixture"
    else:  # all
        labels, _negatives = L.load_honest_labels(str(VAULT))
        X_text, y_text, ids_text, sk_text = build_matrix_from_labels(labels, cache_text)
        X_vision, y_vision, ids_vision, sk_vision = build_matrix_from_labels(labels, cache_vision)
        split_label = "all honest labels"

    print(f"Text matrix ({split_label}):   {len(X_text)} items")
    print(f"  skipped: {sk_text}")
    print(f"Vision matrix ({split_label}): {len(X_vision)} items")
    print(f"  skipped: {sk_vision}")

    # ── Align id order ───────────────────────────────────────────────────────
    # Both caches must cover the same items.  Build the intersection so that
    # X_text[i] and X_vision[i] always correspond to the same roost_id.
    ids_text_set = {rid: i for i, rid in enumerate(ids_text)}
    ids_vision_set = {rid: i for i, rid in enumerate(ids_vision)}
    common_ids = [rid for rid in ids_text if rid in ids_vision_set]

    if len(common_ids) < len(ids_text):
        n_text_only = len(ids_text) - len(common_ids)
        print(f"  WARNING: {n_text_only} ids present in text cache but missing from vision cache — skipped")
    if len(common_ids) < len(ids_vision):
        n_vis_only = len(ids_vision) - len(common_ids)
        print(f"  WARNING: {n_vis_only} ids present in vision cache but missing from text cache — skipped")

    if not common_ids:
        raise ValueError(
            "No common ids between text and vision caches.  "
            "Ensure both caches were built from the same vault."
        )

    # Build aligned matrices (common id order)
    ti_rows = [ids_text_set[rid] for rid in common_ids]
    vi_rows = [ids_vision_set[rid] for rid in common_ids]
    X_text_al = X_text[ti_rows]
    X_vision_al = X_vision[vi_rows]
    y_al = [y_text[i] for i in ti_rows]  # labels from text (should match vision labels)

    # Sanity-check: labels must agree between the two caches for each id.
    y_vision_al = [y_vision[i] for i in vi_rows]
    mismatches = [(common_ids[i], y_al[i], y_vision_al[i])
                  for i in range(len(y_al)) if y_al[i] != y_vision_al[i]]
    if mismatches:
        print(f"  WARNING: {len(mismatches)} label mismatches between text/vision matrices "
              f"(first 3: {mismatches[:3]}) — using text labels")

    N = len(common_ids)
    classes_present = sorted(set(y_al))
    print(f"\nAligned training set: {N} items   Classes: {len(classes_present)}")
    if len(classes_present) < len(CANONICAL_CATS):
        missing = sorted(CANONICAL_CATS - set(classes_present))
        print(f"  WARNING: {len(missing)} canonical categories absent from training data: {missing}")

    # Fixed classes list (sorted — matches sklearn's behaviour for LogReg)
    classes = sorted(classes_present)

    # Integer labels aligned with classes list (for StratifiedKFold)
    cls_to_idx = {c: i for i, c in enumerate(classes)}
    y_enc = np.array([cls_to_idx[c] for c in y_al], dtype=np.int32)

    # ── Train full base heads ─────────────────────────────────────────────────
    print(f"\nTraining text base head (LogReg C=1, multinomial, lbfgs)...")
    t1 = time.time()
    clf_text, classes_text = train_logreg(X_text_al, y_al, balanced=args.balanced)
    print(f"  Done in {time.time()-t1:.1f}s  —  {len(classes_text)} output classes")

    print(f"Training vision base head (LogReg C=1, multinomial, lbfgs)...")
    t1 = time.time()
    clf_vision, classes_vision = train_logreg(X_vision_al, y_al, balanced=args.balanced)
    print(f"  Done in {time.time()-t1:.1f}s  —  {len(classes_vision)} output classes")

    # Quick in-sample accuracy (informational only — not a real eval metric).
    y_pred_text = clf_text.predict(X_text_al)
    y_pred_vision = clf_vision.predict(X_vision_al)
    acc_text = float(np.mean(y_pred_text == np.array(y_al)))
    acc_vision = float(np.mean(y_pred_vision == np.array(y_al)))
    print(f"  Text head in-sample accuracy:   {acc_text*100:.1f}%  (informational only)")
    print(f"  Vision head in-sample accuracy: {acc_vision*100:.1f}%  (informational only)")

    # ── Out-of-fold softmax probabilities for the meta ────────────────────────
    print(f"\nGenerating {args.n_folds}-fold OOF softmax probabilities for meta-head input...")
    print(f"  Feature order: [p_text(C={len(classes)}), p_vision(C={len(classes)})]  (MUST match TS classifyStacked)")
    t1 = time.time()

    P_text_oof = oof_softmax_proba(X_text_al, y_enc, classes, n_splits=args.n_folds, balanced=args.balanced)
    print(f"  Text OOF done  ({time.time()-t1:.1f}s total)")

    P_vision_oof = oof_softmax_proba(X_vision_al, y_enc, classes, n_splits=args.n_folds, balanced=args.balanced)
    print(f"  Vision OOF done  ({time.time()-t1:.1f}s total)")

    # Concatenate: text probs FIRST, then vision probs.
    # This is the defining contract — TS classifyStacked does the same:
    #   feat = [...pText, ...pVision]
    feat_meta = np.hstack([P_text_oof, P_vision_oof])  # shape (N, 2C)
    assert feat_meta.shape == (N, 2 * len(classes)), (
        f"Meta feature matrix shape {feat_meta.shape} != ({N}, {2*len(classes)})"
    )
    print(f"  Meta feature matrix: {feat_meta.shape}  (N × 2C)")

    # ── Train meta-head ───────────────────────────────────────────────────────
    print(f"\nTraining meta-head (LogReg C=1, multinomial, lbfgs, max_iter=2000)...")
    t1 = time.time()
    clf_meta = LogisticRegression(
        max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1,
        class_weight="balanced" if args.balanced else None,
    )
    clf_meta.fit(feat_meta, y_al)
    print(f"  Done in {time.time()-t1:.1f}s  —  {len(clf_meta.classes_)} output classes")

    y_pred_meta = clf_meta.predict(feat_meta)
    acc_meta = float(np.mean(y_pred_meta == np.array(y_al)))
    print(f"  Meta in-sample accuracy (OOF inputs): {acc_meta*100:.1f}%  (informational only)")

    # ── Verify class alignment across all three heads ─────────────────────────
    # All three must expose the same sorted class list so the TS compatibility
    # check (stackedHeadsClassesMatch) works.
    assert list(clf_text.classes_) == classes, (
        f"Text head classes {list(clf_text.classes_)} != expected {classes}"
    )
    assert list(clf_vision.classes_) == classes, (
        f"Vision head classes {list(clf_vision.classes_)} != expected {classes}"
    )
    assert list(clf_meta.classes_) == classes, (
        f"Meta head classes {list(clf_meta.classes_)} != expected {classes}"
    )
    print(f"\nClass alignment verified: all three heads agree on {len(classes)} classes.")

    # ── Export ────────────────────────────────────────────────────────────────
    out_text = export_weights(clf_text, classes, dim, OUT_TEXT, trained_on=N)
    print(f"\nExported text head:   {out_text}")
    print(f"  classes={len(classes)}  W shape=({len(classes)}, {dim})  trainedOn={N}  norm=l2  version=1")

    out_vision = export_weights(clf_vision, classes, dim, OUT_VISION, trained_on=N)
    print(f"Exported vision head: {out_vision}")
    print(f"  classes={len(classes)}  W shape=({len(classes)}, {dim})  trainedOn={N}  norm=l2  version=1")

    out_meta = export_meta_weights(clf_meta, classes, OUT_META)
    print(f"Exported meta head:   {out_meta}")
    print(f"  classes={len(classes)}  W shape=({len(classes)}, {2*len(classes)})  inDim={2*len(classes)}  norm=none  version=1")

    print(f"\nTotal time: {time.time()-t0:.1f}s")
    print()
    print("NOTE: Load the exported JSONs via TS loadStackedHeads() and verify with")
    print("      stackedHeadsClassesMatch(heads, liveCategories) before using classifyStacked().")


if __name__ == "__main__":
    main()
