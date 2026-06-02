#!/usr/bin/env python3
"""
Phase 1 (revised): Multi-classifier diagnostic.

The original logreg-only test was flawed — LogReg underfits with 30 classes,
768 features, and ~75 samples/class. This version tests multiple classifiers
to properly answer: "Does the embedding space contain enough information?"

Usage:
    test/.venv/bin/python scripts/logreg-baseline-v2.py
"""

import json
import os
import re
import random
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier, NearestCentroid
from sklearn.svm import SVC
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder, normalize
from sklearn.model_selection import StratifiedKFold, cross_validate

# ── Paths ──

VAULT_PATH = Path.home() / "ObsidianBookmarks"
ROOST_DIR = VAULT_PATH / ".roost"
BOOKMARKS_DIR = VAULT_PATH / "Bookmarks"
STRATEGY_RESULTS = ROOST_DIR / "strategy-results.json"

NEGATIVE_RATIO = 0.25
SEED = 42

# ── Load embedding cache ──

print("Loading embedding cache...")
t0 = time.time()
with open(ROOST_DIR / "embedding-cache.json") as f:
    cache = json.load(f)
print(f"  {len(cache)} items in {time.time() - t0:.1f}s")

# ── Scan vault frontmatter ──

print("Scanning vault frontmatter...")
collection_items: dict[str, list[str]] = {}

for root, dirs, files in os.walk(BOOKMARKS_DIR):
    for fname in files:
        if not fname.endswith(".md"):
            continue
        try:
            content = open(os.path.join(root, fname), encoding="utf-8").read()
        except Exception:
            continue
        fm_match = re.match(r"^---\n([\s\S]*?)\n---", content)
        if not fm_match:
            continue
        fm = fm_match.group(1)
        id_match = re.search(r'roost_id:\s*"?([^"\n]+)"?', fm)
        if not id_match:
            continue
        item_id = id_match.group(1).strip()
        coll_match = re.search(r"^collection:\s*(.+)", fm, re.MULTILINE)
        cat_match = re.search(r"^roost_category:\s*(.+)", fm, re.MULTILINE)
        cat = (cat_match or coll_match)
        if not cat:
            continue
        cat_name = cat.group(1).strip().strip('"')
        if cat_name in ("undefined", "null", ""):
            continue
        collection_items.setdefault(cat_name, []).append(item_id)

for name in list(collection_items):
    collection_items[name] = [
        rid for rid in collection_items[name]
        if rid in cache and cache[rid].get("vec")
    ]
    if len(collection_items[name]) < 3:
        del collection_items[name]

total_labeled = sum(len(ids) for ids in collection_items.values())
print(f"  {len(collection_items)} collections, {total_labeled} labeled items")

# ── Build dataset ──

all_collection_ids = set()
for ids in collection_items.values():
    all_collection_ids.update(ids)

X_pos, y_pos = [], []
for name, ids in collection_items.items():
    for rid in ids:
        X_pos.append(cache[rid]["vec"])
        y_pos.append(name)

unsorted_ids = [rid for rid in cache if rid not in all_collection_ids and cache[rid].get("vec")]
random.seed(SEED)
neg_count = min(round(total_labeled * NEGATIVE_RATIO / (1 - NEGATIVE_RATIO)), len(unsorted_ids), 2000)
neg_sample = random.sample(unsorted_ids, neg_count)
X_neg = [cache[rid]["vec"] for rid in neg_sample]
y_neg = ["No match"] * len(neg_sample)

X_all = np.array(X_pos + X_neg, dtype=np.float32)
y_all = np.array(y_pos + y_neg)

# L2-normalize (cosine similarity becomes dot product on unit vectors)
X_norm = normalize(X_all, norm="l2")

print(f"  {len(X_pos)} positive + {len(X_neg)} negative = {len(X_all)} total, {len(set(y_all))} classes")

le = LabelEncoder()
y_encoded = le.fit_transform(y_all)

# ── Evaluation A: Cross-validation with multiple classifiers ──

print(f"\n{'═' * 90}")
print("EVALUATION A: 5-fold CV — multiple classifiers")
print("═" * 90)

classifiers = {
    "NearestCentroid": (NearestCentroid(metric="euclidean"), X_norm),  # euclidean on L2-norm ≈ cosine
    "KNN k=5 (cosine)": (KNeighborsClassifier(n_neighbors=5, metric="cosine"), X_norm),
    "KNN k=10 (cosine)": (KNeighborsClassifier(n_neighbors=10, metric="cosine"), X_norm),
    "KNN k=20 (cosine)": (KNeighborsClassifier(n_neighbors=20, metric="cosine"), X_norm),
    "LogReg C=0.01 balanced": (LogisticRegression(max_iter=2000, C=0.01, solver="lbfgs", class_weight="balanced"), X_norm),
    "LogReg C=0.1 balanced": (LogisticRegression(max_iter=2000, C=0.1, solver="lbfgs", class_weight="balanced"), X_norm),
    "LogReg C=1.0 balanced": (LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", class_weight="balanced"), X_norm),
    "LogReg C=10 balanced": (LogisticRegression(max_iter=2000, C=10.0, solver="lbfgs", class_weight="balanced"), X_norm),
    "SVM RBF balanced": (SVC(kernel="rbf", class_weight="balanced"), X_norm),
    "RandomForest 200": (RandomForestClassifier(n_estimators=200, random_state=SEED, class_weight="balanced"), X_norm),
}

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
scoring = ["f1_macro", "precision_macro", "recall_macro", "accuracy"]

cv_results_all = {}

print(f"\n{'Classifier':<30} {'F1 macro':>12} {'Precision':>12} {'Recall':>12} {'Accuracy':>12}")
print("─" * 78)

for name, (clf, X_data) in classifiers.items():
    try:
        results = cross_validate(clf, X_data, y_encoded, cv=cv, scoring=scoring)
        f1 = np.mean(results["test_f1_macro"])
        prec = np.mean(results["test_precision_macro"])
        rec = np.mean(results["test_recall_macro"])
        acc = np.mean(results["test_accuracy"])
        f1_std = np.std(results["test_f1_macro"])
        cv_results_all[name] = {
            "f1_macro": float(f1), "f1_std": float(f1_std),
            "precision": float(prec), "recall": float(rec), "accuracy": float(acc),
        }
        print(f"{name:<30} {f1:.3f}±{f1_std:.3f} {prec:>10.3f}  {rec:>10.3f}  {acc:>10.3f}")
    except Exception as e:
        print(f"{name:<30} ERROR: {e}")

# ── Evaluation B: Exact sweep test set ──

print(f"\n{'═' * 90}")
print("EVALUATION B: Exact sweep test set (169 items)")
print("═" * 90)

with open(STRATEGY_RESULTS) as f:
    sweep_data = json.load(f)

test_items = sweep_data["testItems"]
test_ids = {item["id"] for item in test_items}

# Build train/test split
X_train, y_train = [], []
for name, ids in collection_items.items():
    for rid in ids:
        if rid not in test_ids:
            X_train.append(cache[rid]["vec"])
            y_train.append(name)
train_neg = [rid for rid in neg_sample if rid not in test_ids]
for rid in train_neg:
    X_train.append(cache[rid]["vec"])
    y_train.append("No match")

X_test, y_test, test_order = [], [], []
for item in test_items:
    rid = item["id"]
    if rid not in cache or not cache[rid].get("vec"):
        continue
    X_test.append(cache[rid]["vec"])
    y_test.append(item["groundTruth"])
    test_order.append(item)

X_train = normalize(np.array(X_train, dtype=np.float32), norm="l2")
X_test = normalize(np.array(X_test, dtype=np.float32), norm="l2")
y_train = np.array(y_train)
y_test = np.array(y_test)

print(f"  Train: {len(X_train)}, Test: {len(X_test)}")

def score_picks(y_true, picks):
    """Replicate sweep's score() function."""
    tp = wrong_cat = missed = false_assign = true_reject = 0
    for gt, pick in zip(y_true, picks):
        is_neg = gt == "No match"
        assigned = pick != "No match"
        if is_neg:
            if assigned: false_assign += 1
            else: true_reject += 1
        else:
            if pick == gt: tp += 1
            elif not assigned: missed += 1
            else: wrong_cat += 1
    total = len(y_true)
    total_assigned = tp + wrong_cat + false_assign
    total_pos = tp + wrong_cat + missed
    total_neg = true_reject + false_assign
    precision = tp / total_assigned * 100 if total_assigned > 0 else 100.0
    recall = tp / total_pos * 100 if total_pos > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    fpr = false_assign / total_neg * 100 if total_neg > 0 else 0.0
    accuracy = (tp + true_reject) / total * 100
    return {"tp": tp, "wrongCat": wrong_cat, "missed": missed,
            "falseAssign": false_assign, "trueReject": true_reject,
            "precision": precision, "recall": recall, "f1": f1, "fpr": fpr, "accuracy": accuracy}

# Test each classifier on the sweep test set with probability-based rejection
eval_b_classifiers = {
    "NearestCentroid": NearestCentroid(metric="euclidean"),  # L2-norm + euclidean ≈ cosine
    "KNN k=5": KNeighborsClassifier(n_neighbors=5, metric="cosine"),
    "KNN k=10": KNeighborsClassifier(n_neighbors=10, metric="cosine"),
    "LogReg C=1 bal": LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", class_weight="balanced"),
    "LogReg C=10 bal": LogisticRegression(max_iter=2000, C=10.0, solver="lbfgs", class_weight="balanced"),
    "SVM RBF bal": SVC(kernel="rbf", class_weight="balanced", probability=True),
    "RF 200 bal": RandomForestClassifier(n_estimators=200, random_state=SEED, class_weight="balanced"),
}

# For classifiers with predict_proba, sweep rejection thresholds
# For NearestCentroid (no proba), just use raw predictions
reject_thresholds = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]

col_w = 8
name_w = 22
cfg_w = 12

print(f"\n{'Classifier':<{name_w}} {'Thresh':<{cfg_w}} {'TP':>{col_w}} {'WrongC':>{col_w}} {'FalseA':>{col_w}} {'Missed':>{col_w}} {'TrueRj':>{col_w}} {'Prec':>{col_w}} {'Recall':>{col_w}} {'F1':>{col_w}} {'FPR':>{col_w}}")
print("─" * (name_w + cfg_w + col_w * 9))

eval_b_results = {}

for clf_name, clf in eval_b_classifiers.items():
    clf.fit(X_train, y_train)
    has_proba = hasattr(clf, "predict_proba")

    best_f1 = 0
    best_result = None

    if has_proba:
        proba = clf.predict_proba(X_test)
        classes = clf.classes_
        for thresh in reject_thresholds:
            picks = []
            for i in range(len(y_test)):
                max_p = proba[i].max()
                pred = classes[proba[i].argmax()]
                picks.append("No match" if max_p < thresh else pred)
            r = score_picks(y_test, picks)
            r["threshold"] = thresh
            if r["f1"] > best_f1:
                best_f1 = r["f1"]
                best_result = r
    else:
        # No proba — just raw predictions
        preds = clf.predict(X_test)
        picks = list(preds)
        r = score_picks(y_test, picks)
        r["threshold"] = "N/A"
        best_f1 = r["f1"]
        best_result = r

    eval_b_results[clf_name] = best_result
    b = best_result
    print(f"{clf_name:<{name_w}} {str(b['threshold']):<{cfg_w}} {b['tp']:>{col_w}} {b['wrongCat']:>{col_w}} {b['falseAssign']:>{col_w}} {b['missed']:>{col_w}} {b['trueReject']:>{col_w}} {b['precision']:>{col_w - 1}.0f}% {b['recall']:>{col_w - 1}.0f}% {b['f1']:>{col_w - 1}.1f} {b['fpr']:>{col_w - 1}.0f}%")

# ── Comparison ──

print(f"\n{'═' * 90}")
print("COMPARISON: Best classifier vs sweep strategies")
print("═" * 90)

# Find best classifier result
best_clf_name = max(eval_b_results, key=lambda k: eval_b_results[k]["f1"])
best_clf = eval_b_results[best_clf_name]

sweep_best_f1 = max(max(c["f1"] for c in fam["configs"]) for fam in sweep_data["families"])

# Print sweep strategies for comparison
print(f"\n{'Strategy':<{name_w}} {'Config':<20} {'F1':>8} {'Prec':>8} {'Recall':>8} {'FPR':>8}")
print("─" * 70)
for fam in sweep_data["families"]:
    best_cfg = max(fam["configs"], key=lambda c: c["f1"])
    print(f"{fam['family'][:name_w-2]:<{name_w}} {fam['bestConfig'][:18]:<20} {best_cfg['f1']:>6.1f} {best_cfg['precision']:>6.0f}% {best_cfg['recall']:>6.0f}% {best_cfg['fpr']:>6.0f}%")
print("─" * 70)
for clf_name, r in sorted(eval_b_results.items(), key=lambda x: -x[1]["f1"]):
    print(f"{clf_name:<{name_w}} {'reject<' + str(r['threshold']):<20} {r['f1']:>6.1f} {r['precision']:>6.0f}% {r['recall']:>6.0f}% {r['fpr']:>6.0f}%")

# ── Diagnosis ──

print(f"\n{'═' * 90}")
print("DIAGNOSIS")
print("═" * 90)

print(f"\n  Best sweep strategy F1:    {sweep_best_f1:.1f} (Two-pass NOT gemma4)")
print(f"  Best classifier F1:        {best_clf['f1']:.1f} ({best_clf_name})")
delta = best_clf["f1"] - sweep_best_f1
print(f"  Delta:                     {delta:+.1f}")

embedding_ceiling = sweep_data.get("embeddingCeiling", {})
top1_pct = embedding_ceiling.get("top1Positive", 0) / max(embedding_ceiling.get("totalPositive", 1), 1) * 100
topk_pct = embedding_ceiling.get("topKPositive", 0) / max(embedding_ceiling.get("totalPositive", 1), 1) * 100
print(f"  Embedding ceiling (top-1): {top1_pct:.0f}%")
print(f"  Embedding ceiling (top-7): {topk_pct:.0f}%")

if best_clf["f1"] > 65:
    verdict = "CLASSIFIER"
    explanation = "Classifiers significantly outperform LLM strategies. The embedding space is separable — the production pipeline needs a better classifier, not better embeddings."
    recommendation = "Phase 5 (cross-encoder) or deploy the best classifier directly."
elif best_clf["f1"] > sweep_best_f1 + 5:
    verdict = "CLASSIFIER (moderate)"
    explanation = f"Best classifier beats best LLM strategy by {delta:.0f}pp. The embedding space has more signal than the current pipeline extracts."
    recommendation = "Phase 2+3, then Phase 5 (cross-encoder reranking)."
elif best_clf["f1"] > sweep_best_f1 - 5:
    verdict = "BOTH"
    explanation = "Classifiers and LLM strategies perform similarly. Both the embedding space and the classification method contribute to the ceiling."
    recommendation = "Phase 2+3, then decide between Phase 4 (fine-tuning) and Phase 5 (cross-encoder)."
else:
    verdict = "EMBEDDINGS"
    explanation = "Even sophisticated classifiers can't outperform simple LLM prompting. The embedding space lacks discriminative power."
    recommendation = "Phase 2+3 (free improvements), then Phase 4 (embedding fine-tuning) as priority."

print(f"\n  Verdict: {verdict}")
print(f"  {explanation}")
print(f"  Recommended: {recommendation}")

# ── Save JSON ──

output = {
    "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "cv_results": cv_results_all,
    "eval_b_results": {k: {kk: vv for kk, vv in v.items()} for k, v in eval_b_results.items()},
    "best_classifier": best_clf_name,
    "best_classifier_f1": best_clf["f1"],
    "sweep_best_f1": sweep_best_f1,
    "delta": delta,
    "verdict": verdict,
    "recommendation": recommendation,
}

out_path = ROOST_DIR / "logreg-results.json"
with open(out_path, "w") as f:
    json.dump(output, f, indent=2, default=str)
print(f"\nSaved to {out_path}")
