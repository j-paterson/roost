#!/usr/bin/env python3
"""Classifier head diagnostic on Phase F v2 embeddings.

Trains a logreg (and optionally a small MLP) directly on the v2 cached
embeddings and evaluates on the same 119 positive test items used by
llm-rerank-sweep.py. LOO: for each test item, retrain the classifier
without it, then predict.

Purpose: separate "embedding quality" from "LLM ranker quality" as the
bottleneck on this task.
  - If classifier ≥ 88/119 (current LLM ensemble SOTA) → LLM rerank is
    not adding much value beyond linear separability on v2 embeddings.
    Future effort should go to better training data / relabeling / a
    cross-encoder, not fancier rerankers.
  - If classifier ≪ 88   → LLM is genuinely helping with ambiguous
    cases the linear classifier can't untangle. Cross-encoder + better
    LLM ranker work is justified.

Runs on the SAME 119-item invariant as every other sweep. Pulls labels
via the same load_labels() logic as llm-rerank-sweep.py so the training
pool is identical (collection: frontmatter on vault .md files).
"""
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import LabelEncoder

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
CACHE_PATH = ROOST / "embedding-cache.json"
RESULTS_PATH = ROOST / "strategy-results.json"
OUT_PATH = ROOST / "classifier-head-results.json"


def load_labels():
    """Same logic as llm-rerank-sweep.py::load_labels()."""
    labels = {}
    for md in (VAULT / "Bookmarks").rglob("*.md"):
        try:
            content = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if not content.startswith("---\n"):
            continue
        end = content.find("\n---", 4)
        if end < 0:
            continue
        fm = content[4:end]
        id_match = re.search(r'^roost_id:\s*"?([^"\n]+)"?', fm, re.MULTILINE)
        if not id_match:
            continue
        rid = id_match.group(1).strip()
        coll_match = re.search(r'^collection:\s*(.+)', fm, re.MULTILINE)
        cat_match = re.search(r'^roost_category:\s*(.+)', fm, re.MULTILINE)
        cat = cat_match.group(1) if cat_match else (coll_match.group(1) if coll_match else None)
        if not cat:
            continue
        cat = cat.strip().strip('"')
        if cat and cat not in ("undefined", "null"):
            labels[rid] = cat
    return labels


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
    print("Classifier head diagnostic on v2 embeddings")
    print("=" * 70)
    print(f"Cache:   {CACHE_PATH}")

    t0 = time.time()
    cache = json.load(open(CACHE_PATH))
    results_json = json.load(open(RESULTS_PATH))
    labels = load_labels()
    print(f"Loaded cache ({len(cache)} items), labels ({len(labels)} items) "
          f"in {time.time() - t0:.1f}s")

    positive = [ti for ti in results_json["testItems"] if not ti["isNegative"]]
    test_ids = [ti["id"] for ti in positive]
    test_gts = {ti["id"]: ti["groundTruth"] for ti in positive}
    test_id_set = set(test_ids)

    # Training pool = all labeled items WITH a cached vector, EXCLUDING test items.
    # For strict holdout eval; LOO below re-adds test items minus-self.
    # Filters any vector that contains NaN / inf or is all-zero.
    train_ids_all = []
    X_all = []
    y_all = []
    skipped_nan = 0
    skipped_zero = 0
    for iid, coll in labels.items():
        entry = cache.get(iid)
        if not entry or not entry.get("vec"):
            continue
        v = np.asarray(entry["vec"], dtype=np.float32)
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

    # Build test matrix — use ground-truth from strategy-results.json (post-Phase-4 fixes)
    # NOT from vault frontmatter (which is also post-Phase-4 but may diverge).
    # For the 119 items, these are identical after Phase 4 patched strategy-results.
    X_test_rows = []
    y_test_ordered = []
    test_ids_with_vec = []
    for tid in test_ids:
        entry = cache.get(tid)
        if not entry or not entry.get("vec"):
            continue
        v = np.asarray(entry["vec"], dtype=np.float32)
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
    print(f"Test items: {N}/119 with cached vectors")

    # Global class order = every collection that appears in training pool
    classes = sorted(set(y_all.tolist()) | set(y_test_ordered.tolist()))
    print(f"Classes: {len(classes)}")
    print(f"Training pool size: {len(train_ids_all)} (all labeled items in cache)")
    print()

    # Strict-holdout training set (remove all test items, train once)
    holdout_mask = np.array([tid not in test_id_set for tid in train_ids_all])
    X_tr_strict = X_all[holdout_mask]
    y_tr_strict = y_all[holdout_mask]
    print(f"Strict holdout training set: {len(X_tr_strict)} items")

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
    # For each test item, if its GT class has ≥ 2 items in the TRAINING POOL
    # (which already excludes test items — so LOO is only relevant if the test
    # item itself is ALSO in the labeled pool via vault frontmatter). In our
    # setup, all test items ARE in the labeled pool. So LOO here means: for
    # each test item, train pool = labeled pool \ {that test item}. This
    # re-adds the OTHER 118 test items to training, matching sweep behavior.
    print("\n[2] Centroid cosine with LOO (sweep-matching)")
    hits_at = {1: 0, 3: 0, 5: 0, 7: 0}
    predictions_loo = []
    for i, tid in enumerate(test_ids_with_vec):
        mask = np.array([j_id != tid for j_id in train_ids_all])
        X_loo = X_all[mask]
        y_loo = y_all[mask]
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
    print("\n[4] LogReg with LOO (119 retrainings)")
    t = time.time()
    hits_at = {1: 0, 3: 0, 5: 0, 7: 0}
    predictions_loo_lr = []
    for i, tid in enumerate(test_ids_with_vec):
        mask = np.array([j_id != tid for j_id in train_ids_all])
        clf = LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", n_jobs=-1)
        clf.fit(X_all[mask], y_all[mask])
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
    print("  by GT collection:")
    for coll, n in gt_counter.most_common():
        print(f"    {coll}: {n}")

    # Compare classifier predictions to LLM ensemble picks if available
    llm_path = ROOST / "llm-rerank-results.json"
    if llm_path.exists():
        llm = json.load(open(llm_path))
        # Use the deployed Phase 4 cells (post-label-fix)
        t1_cell = llm.get("gemma4:e4b/T1_letter/phase4-t1k5-fixed", {})
        t2_cell = llm.get("gemma4:e4b/T2_json/phase4-t2k7-fixed", {})
        if t1_cell and t2_cell:
            t1_picks = {p["id"]: p["picked_coll"] for p in t1_cell["picks"]}
            t2_picks = {p["id"]: p["picked_coll"] for p in t2_cell["picks"]}
            # Apply Phase 3 tiebreak: lower index in top-7 wins on disagree
            t1_topk = {p["id"]: p["topk"] for p in t1_cell["picks"]}
            t2_topk = {p["id"]: p["topk"] for p in t2_cell["picks"]}
            ensemble_correct = 0
            classifier_correct = 0
            both_correct = 0
            only_classifier = 0
            only_ensemble = 0
            neither = 0
            for i, tid in enumerate(test_ids_with_vec):
                gt = str(y_test_ordered[i])
                clf_pred = best_preds[i]
                a = t1_picks.get(tid)
                b = t2_picks.get(tid)
                topk_a = t1_topk.get(tid, [])
                topk_b = t2_topk.get(tid, [])
                if a is None and b is None:
                    ens = None
                elif a == b:
                    ens = a
                elif a is None:
                    ens = b
                elif b is None:
                    ens = a
                else:
                    ai = topk_b.index(a) if a in topk_b else 99
                    bi = topk_b.index(b) if b in topk_b else 99
                    ens = a if ai < bi else b
                ens_ok = ens == gt
                clf_ok = clf_pred == gt
                if ens_ok: ensemble_correct += 1
                if clf_ok: classifier_correct += 1
                if ens_ok and clf_ok: both_correct += 1
                elif clf_ok: only_classifier += 1
                elif ens_ok: only_ensemble += 1
                else: neither += 1
            print("\nClassifier vs LLM ensemble:")
            print(f"  both correct:        {both_correct}")
            print(f"  only classifier:     {only_classifier}")
            print(f"  only ensemble:       {only_ensemble}")
            print(f"  neither:             {neither}")
            print(f"  classifier total:    {classifier_correct}")
            print(f"  ensemble total:      {ensemble_correct}")
            print(f"  union ceiling:       {both_correct + only_classifier + only_ensemble}")
            all_results["comparison"] = {
                "both": both_correct,
                "only_classifier": only_classifier,
                "only_ensemble": only_ensemble,
                "neither": neither,
                "classifier_total": classifier_correct,
                "ensemble_total": ensemble_correct,
            }

    print(f"\n{'='*70}")
    print("SUMMARY (top-1 / top-7)")
    print(f"{'='*70}")
    print(f"  LLM ensemble SOTA (deployed):         88/119 (73.9%)  top-7 n/a")
    def fmt(key, label):
        r = all_results[key]
        t1 = r.get("top1", 0); t7 = r.get("top7", 0)
        return (f"  {label:<40} {t1:>3}/{N} ({t1/N*100:>5.1f}%)  "
                f"top-7 {t7:>3}/{N} ({t7/N*100:>5.1f}%)")
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

    json.dump(all_results, open(OUT_PATH, "w"), default=str, indent=2)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == "__main__":
    main()
