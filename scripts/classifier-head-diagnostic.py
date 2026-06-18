#!/usr/bin/env python3
"""Classifier head diagnostic (M0) on v2 embeddings.

Trains LogReg / kNN / centroid-cosine directly on v2 cached embeddings using
one fixture split as the training set and the other as the held-out test set.
Both splits are honest (human `collection` labels only) and already disjoint by
construction (the fixture builder asserts this).

Question: is embedding geometry the cap on the 4,320-item cross-platform fixture?
  - If classifier top-1 >> centroid top-1 → geometry is separable; classifiers add
    value over nearest-centroid.
  - If classifier ≈ centroid top-1 → geometry is the bottleneck (M6 fine-tune or
    better input text via M7 is the next lever).

Key design choices (vs old approach):
  - TRAIN on one fixture split (default: dev), TEST on the other (default: holdout).
    Both splits are honest human-collection labels; already disjoint.
  - NO strict-exclusion pool of non-fixture items — that pool is empty because all
    honest-labeled items are inside the fixture.  Using such a pool is the root cause
    of the crash (empty X_all → np.array([]) is 1-D → l2_normalize axis=1 fails).
  - NO O(N^2) LOO — replaced by a single train/test split (fast, standard diagnostic).
  - GT is ALWAYS the fixture's groundTruth field (human collection, aliases applied
    by the fixture builder) — never roost_category.
  - Filter both splits to the 19 CANONICAL_CATS.
  - Guard empty arrays before any matrix operation.

Run:
  ROOST_VAULT=<vault> python scripts/classifier-head-diagnostic.py [options]

Options:
  --train-split  dev|holdout|large  (default: dev)
  --test-split   dev|holdout|large  (default: holdout)
"""
import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import LabelEncoder

sys.path.insert(0, str(Path(__file__).parent))
import honest_eval_lib as L

# 19 consolidated canonical categories (taxonomy governance 2026-06-18).
CANONICAL_CATS = {
    "Art", "Content Creation", "Crafts", "Design", "Fashion", "Fitness",
    "Food", "Growth", "Humor", "Lifestyle", "Media", "Money", "Other",
    "Places & Travel", "Products", "Quotes", "Relationships", "Spicy", "Tech",
}


def l2_normalize(X):
    """Row-wise L2 normalization.  X must be 2-D (N, D); crashes gracefully when
    N == 0 so callers see a clear message rather than a cryptic axis error."""
    if X.ndim != 2 or X.shape[0] == 0:
        raise ValueError(
            f"l2_normalize: expected 2-D array with at least one row, got shape {X.shape}"
        )
    n = np.linalg.norm(X, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return X / n


def _load_split(build_dir, split):
    """Load fixture items for a given split, filter to CANONICAL_CATS positives,
    and return (ids, gts) lists.  Raises ValueError when the result is empty."""
    items = L.load_fixture(str(build_dir), split)
    pos = [ti for ti in items
           if not ti.get("isNegative") and ti.get("groundTruth") in CANONICAL_CATS]
    if not pos:
        raise ValueError(
            f"No positive items in {split} split after filtering to CANONICAL_CATS. "
            "Check fixture file and category names."
        )
    ids = [ti["id"] for ti in pos]
    gts = {ti["id"]: ti["groundTruth"] for ti in pos}
    return ids, gts


def _build_matrix(ids, gts, cache, split_name):
    """Resolve embeddings for a list of ids.  Returns (X_norm, y_arr, valid_ids).
    Skips items with missing / degenerate vectors and prints a summary."""
    rows, labels_out, valid_ids = [], [], []
    skipped = {"missing": 0, "nan": 0, "zero": 0}
    for iid in ids:
        v = cache.get(iid)
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
        labels_out.append(gts[iid])
        valid_ids.append(iid)
    s = skipped
    if any(s.values()):
        print(f"  [{split_name}] skipped: {s['missing']} missing, "
              f"{s['nan']} NaN/inf, {s['zero']} zero-norm vectors")
    if not rows:
        raise ValueError(
            f"No usable embedding vectors found for {split_name} split. "
            "Check embedding cache path and fixture ids."
        )
    X = l2_normalize(np.array(rows, dtype=np.float32))
    assert np.all(np.isfinite(X)), f"{split_name} matrix has non-finite values after normalize"
    return X, np.array(labels_out), valid_ids


def centroid_top1(X_train, y_train, X_test, classes):
    """Compute centroid-cosine top-1 predictions for X_test.

    X_train and X_test must be L2-normalised (so cosine == dot product).
    Returns (predictions_list, scores_matrix, present_classes) where scores_matrix
    has shape (N_test, N_present) and present_classes is the ordered list of
    categories that had at least one training example."""
    by_class = defaultdict(list)
    for x, y in zip(X_train, y_train):
        by_class[y].append(x)
    present = [c for c in classes if by_class[c]]
    if not present:
        raise ValueError("centroid_top1: no classes have training examples")
    centroids = [l2_normalize(np.mean(by_class[c], axis=0, keepdims=True))[0]
                 for c in present]
    C = np.stack(centroids)          # (N_present, D)
    sims = X_test @ C.T              # (N_test, N_present) — cosine sims
    top_idx = np.argmax(sims, axis=1)
    predictions = [present[int(i)] for i in top_idx]
    return predictions, sims, present


def eval_classifier(X_train, y_train, X_test, fit_fn, le=None):
    """Train fit_fn() on X_train/y_train (int-encoded via LabelEncoder) and return
    (predictions_list, proba_matrix, classes_list) for X_test.

    Accepts an optional pre-fit LabelEncoder (le) so that classes in the test set
    that were not seen during training still resolve cleanly."""
    if le is None:
        le = LabelEncoder()
        le.fit(y_train)
    y_train_int = le.transform(y_train)
    clf = fit_fn()
    clf.fit(X_train, y_train_int)
    proba = clf.predict_proba(X_test)            # (N_test, N_train_classes)
    clf_classes = [str(c) for c in le.inverse_transform(clf.classes_)]
    predictions = [clf_classes[int(np.argmax(row))] for row in proba]
    return predictions, proba, clf_classes


def accuracy(predictions, y_test):
    return sum(p == g for p, g in zip(predictions, y_test)) / len(y_test)


def main():
    ap = argparse.ArgumentParser(
        description="Classifier head diagnostic (M0) — train/test on fixture splits."
    )
    ap.add_argument("--train-split", default="dev",
                    choices=["dev", "holdout", "large"],
                    help="Fixture split used for TRAINING (default: dev).")
    ap.add_argument("--test-split", default="holdout",
                    choices=["dev", "holdout", "large"],
                    help="Fixture split used for TESTING (default: holdout).")
    args = ap.parse_args()

    if args.train_split == args.test_split:
        print(f"WARNING: train-split and test-split are both '{args.train_split}'. "
              "Results will overfit (same data). Use different splits for a valid diagnostic.",
              file=sys.stderr)

    vault_env = os.environ.get("ROOST_VAULT")
    if vault_env:
        VAULT = Path(vault_env)
    else:
        VAULT = Path.home() / "ObsidianBookmarks"
    ROOST = VAULT / ".roost"
    BUILD_DIR = ROOST / "build"
    BIN_CACHE = ROOST / "cache" / "embedding-vectors.bin"
    OUT_PATH = ROOST / "classifier-head-results.json"

    print("Classifier head diagnostic (M0) — train/test on fixture splits")
    print("=" * 70)
    print(f"Vault:        {VAULT}")
    print(f"Train split:  {args.train_split}")
    print(f"Test split:   {args.test_split}")
    print(f"Cache:        {BIN_CACHE}")
    print(f"Categories:   {len(CANONICAL_CATS)} canonical")

    t0 = time.time()

    # ── Load embedding cache ──────────────────────────────────────────────────
    cache = L.load_cache(bin_path=str(BIN_CACHE))
    print(f"Loaded embedding cache: {len(cache)} items  ({time.time()-t0:.1f}s)")

    # ── Contamination guard: assert dev ∩ holdout = ∅ ────────────────────────
    dev_ids_all = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "dev")]
    hld_ids_all = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "holdout")]
    L.assert_disjoint(dev_ids_all, hld_ids_all)

    # ── Load train and test splits ────────────────────────────────────────────
    # GT comes from the fixture's groundTruth field (human collection, aliases applied
    # by the fixture builder).  We never touch roost_category.
    L.assert_gt_not_roost_category("collection")   # tripwire
    train_ids, train_gts = _load_split(BUILD_DIR, args.train_split)
    test_ids, test_gts = _load_split(BUILD_DIR, args.test_split)

    # When splits differ, assert no ID overlap between train and test.
    if args.train_split != args.test_split:
        overlap = set(train_ids) & set(test_ids)
        if overlap:
            raise AssertionError(
                f"{len(overlap)} ids appear in both {args.train_split} and "
                f"{args.test_split} fixture splits — fixture may be corrupted."
            )

    print(f"Train items (fixture {args.train_split}, CANONICAL only): {len(train_ids)}")
    print(f"Test  items (fixture {args.test_split}, CANONICAL only): {len(test_ids)}")

    # ── Build embedding matrices ──────────────────────────────────────────────
    X_train, y_train, train_valid = _build_matrix(train_ids, train_gts, cache,
                                                   args.train_split)
    X_test,  y_test,  test_valid  = _build_matrix(test_ids,  test_gts,  cache,
                                                   args.test_split)
    N_train, N_test = len(train_valid), len(test_valid)
    print(f"Vectors resolved — train: {N_train}/{len(train_ids)}, "
          f"test: {N_test}/{len(test_ids)}")

    # Classes present in the training data (used to align LabelEncoder).
    train_classes = sorted(set(y_train.tolist()))
    all_classes   = sorted(set(y_train.tolist()) | set(y_test.tolist()))
    missing_in_train = set(y_test.tolist()) - set(y_train.tolist())
    if missing_in_train:
        print(f"  WARNING: {len(missing_in_train)} test categories absent from train: "
              f"{sorted(missing_in_train)}")

    # Shared LabelEncoder (fit on training classes only; test-only cats will be
    # unknown to the classifier but the centroid baseline handles them if any vectors exist).
    le = LabelEncoder()
    le.fit(y_train)

    print(f"\nTrain classes: {len(train_classes)}   All classes: {len(all_classes)}")
    print()

    all_results = {}

    # ── [1] Centroid cosine baseline ─────────────────────────────────────────
    print("[1] Centroid cosine (train → test)")
    t = time.time()
    cent_preds, sims, cent_classes = centroid_top1(X_train, y_train, X_test, all_classes)
    acc_cent = accuracy(cent_preds, y_test)
    print(f"  top-1: {sum(p==g for p,g in zip(cent_preds,y_test))}/{N_test} "
          f"({acc_cent*100:.1f}%)  [{time.time()-t:.1f}s]")
    all_results["centroid_cosine"] = {
        "top1": int(sum(p == g for p, g in zip(cent_preds, y_test))),
        "N": N_test,
        "accuracy": round(acc_cent, 4),
        "predictions": cent_preds,
    }

    # ── [2] LogReg C=1 ───────────────────────────────────────────────────────
    print("\n[2] LogReg C=1 (train → test)")
    t = time.time()
    lr_preds, _, _ = eval_classifier(
        X_train, y_train, X_test, le=le,
        fit_fn=lambda: LogisticRegression(
            max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1),
    )
    acc_lr = accuracy(lr_preds, y_test)
    print(f"  top-1: {sum(p==g for p,g in zip(lr_preds,y_test))}/{N_test} "
          f"({acc_lr*100:.1f}%)  [{time.time()-t:.1f}s]")
    all_results["logreg_c1"] = {
        "top1": int(sum(p == g for p, g in zip(lr_preds, y_test))),
        "N": N_test,
        "accuracy": round(acc_lr, 4),
        "predictions": lr_preds,
    }

    # ── [3] LogReg class_weight=balanced ─────────────────────────────────────
    print("\n[3] LogReg C=1 balanced (train → test)")
    t = time.time()
    lr_bal_preds, _, _ = eval_classifier(
        X_train, y_train, X_test, le=le,
        fit_fn=lambda: LogisticRegression(
            max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1,
            class_weight="balanced"),
    )
    acc_lr_bal = accuracy(lr_bal_preds, y_test)
    print(f"  top-1: {sum(p==g for p,g in zip(lr_bal_preds,y_test))}/{N_test} "
          f"({acc_lr_bal*100:.1f}%)  [{time.time()-t:.1f}s]")
    all_results["logreg_balanced"] = {
        "top1": int(sum(p == g for p, g in zip(lr_bal_preds, y_test))),
        "N": N_test,
        "accuracy": round(acc_lr_bal, 4),
        "predictions": lr_bal_preds,
    }

    # ── [4] kNN k=5 cosine ───────────────────────────────────────────────────
    print("\n[4] kNN k=5 cosine (train → test)")
    t = time.time()
    knn_preds, _, _ = eval_classifier(
        X_train, y_train, X_test, le=le,
        fit_fn=lambda: KNeighborsClassifier(
            n_neighbors=5, metric="cosine", weights="distance", n_jobs=-1),
    )
    acc_knn = accuracy(knn_preds, y_test)
    print(f"  top-1: {sum(p==g for p,g in zip(knn_preds,y_test))}/{N_test} "
          f"({acc_knn*100:.1f}%)  [{time.time()-t:.1f}s]")
    all_results["knn5_cosine"] = {
        "top1": int(sum(p == g for p, g in zip(knn_preds, y_test))),
        "N": N_test,
        "accuracy": round(acc_knn, 4),
        "predictions": knn_preds,
    }

    # ── Per-class breakdown (best classifier by top-1) ───────────────────────
    best_key = max(
        ["centroid_cosine", "logreg_c1", "logreg_balanced", "knn5_cosine"],
        key=lambda k: all_results[k]["accuracy"],
    )
    best_preds = all_results[best_key]["predictions"]
    wrong_items = [
        {"id": tid, "gt": str(gt), "pred": pred}
        for tid, pred, gt in zip(test_valid, best_preds, y_test)
        if pred != gt
    ]
    print(f"\nBest model: {best_key}  —  wrong items: {len(wrong_items)}/{N_test}")
    gt_counter = Counter(w["gt"] for w in wrong_items)
    print("  errors by GT category:")
    for cat, n_err in gt_counter.most_common():
        total_in_cat = sum(1 for g in y_test if g == cat)
        print(f"    {cat:<22} {n_err:>3} / {total_in_cat:>3} errors")

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'='*70}")
    print(f"SUMMARY  train={args.train_split}  test={args.test_split}  N_test={N_test}")
    print(f"{'='*70}")
    print(f"  (M0 question: do classifiers beat the centroid-cosine baseline?)")
    print(f"  {'Method':<42} {'top-1':>8}  {'acc':>7}")
    print(f"  {'-'*60}")
    for key, label in [
        ("centroid_cosine",  "Centroid cosine (production-style):"),
        ("logreg_c1",        "LogReg C=1:"),
        ("logreg_balanced",  "LogReg C=1 balanced:"),
        ("knn5_cosine",      "kNN k=5 cosine:"),
    ]:
        r = all_results[key]
        marker = " <-- best" if key == best_key else ""
        print(f"  {label:<42} {r['top1']:>4}/{N_test}  "
              f"{r['accuracy']*100:>5.1f}%{marker}")

    # ── Save results ──────────────────────────────────────────────────────────
    out_meta = {
        "train_split": args.train_split,
        "test_split": args.test_split,
        "N_train": N_train,
        "N_test": N_test,
        "categories": sorted(all_classes),
        **{k: {kk: vv for kk, vv in v.items() if kk != "predictions"}
           for k, v in all_results.items()},
        "wrong_items": wrong_items[:200],  # cap to avoid huge JSON
    }
    with open(OUT_PATH, "w") as fh:
        json.dump(out_meta, fh, default=str, indent=2)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == "__main__":
    main()
