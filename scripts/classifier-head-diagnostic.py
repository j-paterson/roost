#!/usr/bin/env python3
"""Classifier head diagnostic (M0) on v2 embeddings.

Trains LogReg/kNN/MLP directly on v2 cached embeddings and evaluates on the
honest eval fixture (eval-fixture-{split}.json) against the 19 consolidated
categories. LOO: for each test item, retrain without it, then predict.

Purpose: is embedding geometry the cap on the 4,320-item cross-platform fixture?
  - If classifier top-1 >> embedding-top-1 baseline → geometry is separable;
    classifiers add value over nearest-centroid. Future: cross-encoder or better
    LLM ranker justified.
  - If classifier ≈ embedding-top-1 → geometry is the bottleneck (M6 fine-tune
    or better input text via M7 is the next lever).

Run:
  ROOST_VAULT=<vault> python scripts/classifier-head-diagnostic.py [--split dev|holdout|large]
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
from sklearn.neural_network import MLPClassifier
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
    n = np.linalg.norm(X, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return X / n


def centroid_baseline(X_train, y_train, X_test, classes):
    """Reproduce the LOO centroid baseline (cosine) from llm-rerank-sweep.py.

    X_train/X_test are L2-normalized, so cosine == dot product. Returns
    a (N_test, N_classes_seen) matrix and the list of classes actually
    present in X_train (classes with no training items are dropped).
    """
    by_class = defaultdict(list)
    for x, y in zip(X_train, y_train):
        by_class[y].append(x)
    present = [c for c in classes if by_class[c]]
    centroids = [l2_normalize(np.mean(by_class[c], axis=0, keepdims=True))[0]
                 for c in present]
    C = np.stack(centroids)
    sims = X_test @ C.T
    return sims, present


def eval_classifier(name, X_train, y_train, X_test, y_test,
                    fit_fn, topk_list=(1, 3, 5, 7)):
    """Train once on X_train, score X_test. Report top-k accuracies.
    Encodes string labels to ints for classifiers that can't handle strings
    in their validation score pathway (MLPClassifier in sklearn 1.6)."""
    le = LabelEncoder()
    y_train_int = le.fit_transform(y_train)
    clf = fit_fn()
    clf.fit(X_train, y_train_int)
    scores = clf.predict_proba(X_test)
    clf_classes = [str(c) for c in le.inverse_transform(clf.classes_)]

    results = {}
    for k in topk_list:
        topk_idx = np.argsort(-scores, axis=1)[:, :k]
        topk_labels = [[clf_classes[j] for j in row] for row in topk_idx]
        hits = sum(1 for preds, gt in zip(topk_labels, y_test) if gt in preds)
        results[f"top{k}"] = hits
    results["predictions"] = [clf_classes[int(np.argmax(row))] for row in scores]
    return results


def main():
    ap = argparse.ArgumentParser(
        description="Classifier head diagnostic (M0) — embedding geometry cap test."
    )
    ap.add_argument("--split", default="large", choices=["dev", "holdout", "large"],
                    help="Fixture split to use as test set (default: large = dev ∪ holdout).")
    args = ap.parse_args()

    vault_env = os.environ.get("ROOST_VAULT")
    if vault_env:
        VAULT = Path(vault_env)
    else:
        VAULT = Path.home() / "ObsidianBookmarks"
    ROOST = VAULT / ".roost"
    BUILD_DIR = ROOST / "build"
    BIN_CACHE = ROOST / "cache" / "embedding-vectors.bin"
    OUT_PATH = ROOST / "classifier-head-results.json"

    print("Classifier head diagnostic (M0) on v2 embeddings")
    print("=" * 70)
    print(f"Vault:   {VAULT}")
    print(f"Split:   {args.split}")
    print(f"Cache:   {BIN_CACHE}")

    t0 = time.time()
    # Load v2 binary cache (same path as honest-eval.py uses).
    cache = L.load_cache(bin_path=str(BIN_CACHE))
    # Load honest labels (collection: only, not roost_category; aliases applied).
    labels, _ = L.load_honest_labels(str(VAULT))
    # Restrict training labels to the 19 canonical categories.
    labels = {k: v for k, v in labels.items() if v in CANONICAL_CATS}
    print(f"Loaded cache ({len(cache)} items), labels ({len(labels)} items) "
          f"in {time.time() - t0:.1f}s")

    # Load test items from the honest fixture (dev/holdout/large).
    # Positives only for classification; negatives (isNegative=True) are OOD items,
    # not relevant to the LogReg/kNN geometry question.
    fixture_items = L.load_fixture(str(BUILD_DIR), args.split)
    positive = [ti for ti in fixture_items if not ti.get("isNegative")]
    # Filter to canonical categories only (fixture may include pre-consolidation labels).
    positive = [ti for ti in positive if ti.get("groundTruth") in CANONICAL_CATS]
    test_ids = [ti["id"] for ti in positive]
    test_gts = {ti["id"]: ti["groundTruth"] for ti in positive}
    test_id_set = set(test_ids)

    # Contamination guard: no fixture item (dev ∪ holdout) may be in the training pool.
    # Load the full (large) fixture id set regardless of the split argument.
    all_fixture_ids = {t["id"] for t in L.load_fixture(str(BUILD_DIR), "large")}
    L.assert_disjoint([t["id"] for t in L.load_fixture(str(BUILD_DIR), "dev")],
                      [t["id"] for t in L.load_fixture(str(BUILD_DIR), "holdout")])

    # Training pool = all labeled items WITH a cached vector, EXCLUDING the ENTIRE
    # large fixture (dev ∪ holdout) to prevent contamination — not just the current
    # split's test items. LOO below re-adds test items minus-self within this pool.
    # Filters any vector that contains NaN / inf or is all-zero.
    train_ids_all = []
    X_all = []
    y_all = []
    skipped_nan = 0
    skipped_zero = 0
    for iid, coll in labels.items():
        if iid in all_fixture_ids:
            continue  # strict exclusion of all fixture items from training pool
        v = cache.get(iid)
        if v is None:
            continue
        # v is already an np.ndarray from load_cache
        v = np.asarray(v, dtype=np.float32)
        if not np.all(np.isfinite(v)):
            skipped_nan += 1
            continue
        if float(np.linalg.norm(v)) == 0.0:
            skipped_zero += 1
            continue
        train_ids_all.append(iid)
        X_all.append(v)
        y_all.append(coll)
    if skipped_nan or skipped_zero:
        print(f"  skipped {skipped_nan} NaN/inf vectors, {skipped_zero} zero vectors")
    X_all = l2_normalize(np.array(X_all, dtype=np.float32))
    y_all = np.array(y_all)
    assert np.all(np.isfinite(X_all)), "X_all has non-finite values after normalize"
    # Verify no fixture leak in the pool we just built.
    L.assert_no_fixture_leak(train_ids_all, all_fixture_ids)

    # Build test matrix — ground truth comes from the honest fixture (not vault frontmatter).
    X_test_rows = []
    y_test_ordered = []
    test_ids_with_vec = []
    for tid in test_ids:
        v = cache.get(tid)
        if v is None:
            continue
        v = np.asarray(v, dtype=np.float32)
        if not np.all(np.isfinite(v)) or float(np.linalg.norm(v)) == 0.0:
            print(f"  skipping degenerate test vector: {tid}")
            continue
        X_test_rows.append(v)
        y_test_ordered.append(test_gts[tid])
        test_ids_with_vec.append(tid)
    X_test = l2_normalize(np.array(X_test_rows, dtype=np.float32))
    y_test_ordered = np.array(y_test_ordered)
    assert np.all(np.isfinite(X_test)), "X_test has non-finite values after normalize"
    N = len(test_ids_with_vec)
    print(f"Test items: {N}/{len(test_ids)} with cached vectors (split={args.split})")

    # Global class order = every canonical category that appears in the data.
    classes = sorted(set(y_all.tolist()) | set(y_test_ordered.tolist()))
    print(f"Classes: {len(classes)}")
    print(f"Training pool size (fixture excluded): {len(train_ids_all)}")
    print()

    # Strict-holdout training set = the training pool as-is (fixture already excluded).
    # LOO adds back individual test items for the LOO passes below.
    X_tr_strict = X_all
    y_tr_strict = y_all
    print(f"Strict holdout training set: {len(X_tr_strict)} items (fixture fully excluded)")

    all_results = {}

    # ── Baseline 1: Centroid cosine (no LOO) — should roughly match v2 top-1 ──
    print("\n[1] Centroid cosine (strict holdout)")
    sims, cls_present = centroid_baseline(X_tr_strict, y_tr_strict, X_test, classes)
    topk_idx = np.argsort(-sims, axis=1)
    hits_strict = {}
    for k in (1, 3, 5, 7):
        hits = sum(1 for i in range(N)
                   if y_test_ordered[i] in [cls_present[j] for j in topk_idx[i, :k]])
        hits_strict[f"top{k}"] = hits
        print(f"  top-{k}: {hits}/{N} ({hits/N*100:.1f}%)")
    all_results["centroid_strict"] = {
        "predictions": [cls_present[int(topk_idx[i, 0])] for i in range(N)],
        **hits_strict,
    }

    # ── Baseline 2: Centroid cosine with LOO ──
    # For each test item i, train pool = (strict pool) ∪ (all test items except i).
    # This gives each item the benefit of the others' labels while keeping i out.
    # Precompute label array for fast LOO slicing.
    _test_y_arr = np.array([test_gts[t] for t in test_ids_with_vec])
    print("\n[2] Centroid cosine with LOO (n-1 test items added back)")
    hits_at = {1: 0, 3: 0, 5: 0, 7: 0}
    predictions_loo = []
    for i, tid in enumerate(test_ids_with_vec):
        # All test rows except i.
        mask = np.ones(N, dtype=bool); mask[i] = False
        X_loo = np.vstack([X_tr_strict, X_test[mask]])
        y_loo = np.concatenate([y_tr_strict, _test_y_arr[mask]])
        sims_i, cls_i = centroid_baseline(X_loo, y_loo, X_test[i:i + 1], classes)
        row = sims_i[0]
        idx_sorted = np.argsort(-row)
        predictions_loo.append(cls_i[int(idx_sorted[0])])
        for k in (1, 3, 5, 7):
            if y_test_ordered[i] in [cls_i[j] for j in idx_sorted[:k]]:
                hits_at[k] += 1
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {hits_at[k]}/{N} ({hits_at[k]/N*100:.1f}%)")
    all_results["centroid_loo"] = {
        "predictions": predictions_loo,
        **{f"top{k}": v for k, v in hits_at.items()},
    }

    # ── Classifier 1: LogReg, strict holdout ──
    print("\n[3] LogReg (strict holdout)")
    t = time.time()
    res = eval_classifier(
        "logreg_strict",
        X_tr_strict, y_tr_strict, X_test, y_test_ordered,
        fit_fn=lambda: LogisticRegression(
            max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1),
    )
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {res[f'top{k}']}/{N} ({res[f'top{k}']/N*100:.1f}%)")
    print(f"  fit time: {time.time() - t:.1f}s")
    all_results["logreg_strict"] = res

    # ── Classifier 2: LogReg, LOO ──
    # For each test item i, train pool = (strict pool) ∪ (all test items except i).
    print(f"\n[4] LogReg with LOO ({N} retrainings)")
    t = time.time()
    hits_at = {1: 0, 3: 0, 5: 0, 7: 0}
    predictions_loo_lr = []
    for i, tid in enumerate(test_ids_with_vec):
        mask = np.ones(N, dtype=bool); mask[i] = False
        X_loo = np.vstack([X_tr_strict, X_test[mask]])
        y_loo = np.concatenate([y_tr_strict, _test_y_arr[mask]])
        clf = LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1)
        clf.fit(X_loo, y_loo)
        # Restrict to classes the classifier actually saw (LOO may drop a singleton class)
        cls = list(clf.classes_)
        proba = clf.predict_proba(X_test[i:i + 1])[0]
        order = np.argsort(-proba)
        ordered_classes = [cls[j] for j in order]
        predictions_loo_lr.append(ordered_classes[0])
        gt = y_test_ordered[i]
        for k in (1, 3, 5, 7):
            if gt in ordered_classes[:k]:
                hits_at[k] += 1
        if (i + 1) % 20 == 0:
            print(f"  {i+1}/{N}  top-1 so far: {hits_at[1]}/{i+1}")
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {hits_at[k]}/{N} ({hits_at[k]/N*100:.1f}%)")
    print(f"  total time: {time.time() - t:.1f}s")
    all_results["logreg_loo"] = {
        "predictions": predictions_loo_lr,
        **{f"top{k}": v for k, v in hits_at.items()},
    }

    # ── Classifier 3: LogReg with class_weight=balanced (strict holdout) ──
    print("\n[5] LogReg class_weight=balanced (strict holdout)")
    t = time.time()
    res = eval_classifier(
        "logreg_balanced_strict",
        X_tr_strict, y_tr_strict, X_test, y_test_ordered,
        fit_fn=lambda: LogisticRegression(
            max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1,
            class_weight="balanced"),
    )
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {res[f'top{k}']}/{N} ({res[f'top{k}']/N*100:.1f}%)")
    print(f"  fit time: {time.time() - t:.1f}s")
    all_results["logreg_balanced_strict"] = res

    # ── Classifier 4: LogReg stronger regularization C=0.1 ──
    print("\n[6] LogReg C=0.1 (strict holdout)")
    t = time.time()
    res = eval_classifier(
        "logreg_c0p1_strict",
        X_tr_strict, y_tr_strict, X_test, y_test_ordered,
        fit_fn=lambda: LogisticRegression(
            max_iter=2000, C=0.1, solver="lbfgs", n_jobs=-1),
    )
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {res[f'top{k}']}/{N} ({res[f'top{k}']/N*100:.1f}%)")
    print(f"  fit time: {time.time() - t:.1f}s")
    all_results["logreg_c0p1_strict"] = res

    # ── Classifier 5: LogReg C=10 (weaker regularization) ──
    print("\n[7] LogReg C=10 (strict holdout)")
    t = time.time()
    res = eval_classifier(
        "logreg_c10_strict",
        X_tr_strict, y_tr_strict, X_test, y_test_ordered,
        fit_fn=lambda: LogisticRegression(
            max_iter=5000, C=10.0, solver="lbfgs", n_jobs=-1),
    )
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {res[f'top{k}']}/{N} ({res[f'top{k}']/N*100:.1f}%)")
    print(f"  fit time: {time.time() - t:.1f}s")
    all_results["logreg_c10_strict"] = res

    # ── Classifier 6: kNN k=5 on cosine (strict holdout) — parallel to centroid ──
    print("\n[8] kNN k=5 cosine (strict holdout)")
    t = time.time()
    res = eval_classifier(
        "knn5_strict",
        X_tr_strict, y_tr_strict, X_test, y_test_ordered,
        fit_fn=lambda: KNeighborsClassifier(
            n_neighbors=5, metric="cosine", weights="distance", n_jobs=-1),
    )
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {res[f'top{k}']}/{N} ({res[f'top{k}']/N*100:.1f}%)")
    print(f"  fit time: {time.time() - t:.1f}s")
    all_results["knn5_strict"] = res

    # ── Classifier 7: MLP [256, 128] strict holdout ──
    print("\n[9] MLP [256, 128] (strict holdout, no LOO)")
    t = time.time()
    res = eval_classifier(
        "mlp_strict",
        X_tr_strict, y_tr_strict, X_test, y_test_ordered,
        fit_fn=lambda: MLPClassifier(
            hidden_layer_sizes=(256, 128),
            max_iter=400,
            early_stopping=True,
            random_state=0,
            alpha=1e-4,
        ),
    )
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {res[f'top{k}']}/{N} ({res[f'top{k}']/N*100:.1f}%)")
    print(f"  fit time: {time.time() - t:.1f}s")
    all_results["mlp_strict"] = res

    # ── Per-class breakdown on the best classifier ──
    best_preds = all_results["logreg_loo"]["predictions"]
    wrong_items = []
    for i, (tid, pred, gt) in enumerate(zip(test_ids_with_vec, best_preds, y_test_ordered)):
        if pred != gt:
            wrong_items.append({"id": tid, "gt": str(gt), "pred": pred})

    print(f"\nLogReg LOO wrong items: {len(wrong_items)}")
    gt_counter = Counter(w["gt"] for w in wrong_items)
    print("  by GT category:")
    for cat, n in gt_counter.most_common():
        print(f"    {cat}: {n}")

    print(f"\n{'='*70}")
    print(f"SUMMARY (top-1 / top-7)  split={args.split}  N={N}")
    print(f"{'='*70}")
    print(f"  (M0 goal: is LogReg/kNN top-1 >> centroid top-1?)")
    def fmt(key, label):
        r = all_results[key]
        t1 = r.get("top1", 0); t7 = r.get("top7", 0)
        return (f"  {label:<42} {t1:>4}/{N} ({t1/N*100:>5.1f}%)  "
                f"top-7 {t7:>4}/{N} ({t7/N*100:>5.1f}%)")
    if "centroid_loo" in all_results:
        print(fmt("centroid_loo", "Centroid cosine (LOO):"))
    if "centroid_strict" in all_results:
        print(fmt("centroid_strict", "Centroid cosine (strict holdout):"))
    print(fmt("logreg_strict", "LogReg C=1 (strict holdout):"))
    print(fmt("logreg_loo", "LogReg C=1 (LOO):"))
    print(fmt("logreg_balanced_strict", "LogReg balanced (strict):"))
    print(fmt("logreg_c0p1_strict", "LogReg C=0.1 (strict):"))
    print(fmt("logreg_c10_strict", "LogReg C=10 (strict):"))
    print(fmt("knn5_strict", "kNN k=5 cosine (strict):"))
    print(fmt("mlp_strict", "MLP [256,128] (strict):"))

    out_meta = {
        "split": args.split,
        "N": N,
        "categories": sorted(classes),
        "training_pool_size": len(train_ids_all),
        **all_results,
    }
    with open(OUT_PATH, "w") as fh:
        json.dump(out_meta, fh, default=str, indent=2)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == "__main__":
    main()
