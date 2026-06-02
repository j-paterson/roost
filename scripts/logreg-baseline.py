#!/usr/bin/env python3
"""
Phase 1: Logistic Regression Diagnostic.

Answers: "Is the bottleneck the embeddings or the classifier?"

Evaluation A — 5-fold stratified CV on all labeled data.
Evaluation B — Train on labeled data minus sweep test set, predict on
               the exact same 169 items from strategy-results.json.

Usage:
    test/.venv/bin/python scripts/logreg-baseline.py
"""

import json
import os
import re
import random
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_validate
from sklearn.preprocessing import LabelEncoder

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

# ── Scan vault frontmatter for collection labels ──

print("Scanning vault frontmatter...")
collection_items: dict[str, list[str]] = {}  # collection_name → [roost_ids]

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

# Filter to items with vectors
for name in list(collection_items):
    collection_items[name] = [
        rid for rid in collection_items[name]
        if rid in cache and cache[rid].get("vec")
    ]
    if len(collection_items[name]) < 3:
        del collection_items[name]

total_labeled = sum(len(ids) for ids in collection_items.values())
print(f"  {len(collection_items)} collections, {total_labeled} labeled items with vectors")

# ── Build all-collection-IDs set ──

all_collection_ids = set()
for ids in collection_items.values():
    all_collection_ids.update(ids)

# ── Build labeled dataset ──

# Positive examples
X_pos = []
y_pos = []
for name, ids in collection_items.items():
    for rid in ids:
        vec = cache[rid]["vec"]
        X_pos.append(vec)
        y_pos.append(name)

# Negative examples
unsorted_ids = [
    rid for rid in cache
    if rid not in all_collection_ids and cache[rid].get("vec")
]
random.seed(SEED)
neg_count = round(total_labeled * NEGATIVE_RATIO / (1 - NEGATIVE_RATIO))
neg_count = min(neg_count, len(unsorted_ids), 2000)
neg_sample = random.sample(unsorted_ids, neg_count)

X_neg = [cache[rid]["vec"] for rid in neg_sample]
y_neg = ["No match"] * len(neg_sample)

X_all = np.array(X_pos + X_neg, dtype=np.float32)
y_all = np.array(y_pos + y_neg)

print(f"  Dataset: {len(X_pos)} positive + {len(X_neg)} negative = {len(X_all)} total")
print(f"  Classes: {len(set(y_all))}")

# ── Evaluation A: 5-fold stratified CV ──

print("\n" + "═" * 80)
print("EVALUATION A: 5-fold stratified cross-validation")
print("═" * 80)

le = LabelEncoder()
y_encoded = le.fit_transform(y_all)

lr = LogisticRegression(max_iter=1000, C=1.0, solver="lbfgs")
cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)

scoring = ["f1_macro", "precision_macro", "recall_macro", "accuracy"]
cv_results = cross_validate(lr, X_all, y_encoded, cv=cv, scoring=scoring)

cv_summary = {}
for metric in scoring:
    key = f"test_{metric}"
    vals = cv_results[key]
    cv_summary[metric] = {"mean": float(np.mean(vals)), "std": float(np.std(vals))}
    print(f"  {metric}: {np.mean(vals):.3f} ± {np.std(vals):.3f}")

# ── Evaluation B: Exact sweep test set ──

print(f"\n{'═' * 80}")
print("EVALUATION B: Exact sweep test set (169 items)")
print("═" * 80)

with open(STRATEGY_RESULTS) as f:
    sweep_data = json.load(f)

test_items = sweep_data["testItems"]
test_ids = {item["id"] for item in test_items}

# Build train set: all labeled items NOT in test set
X_train = []
y_train = []
for name, ids in collection_items.items():
    for rid in ids:
        if rid not in test_ids:
            X_train.append(cache[rid]["vec"])
            y_train.append(name)

# Add negative training examples (exclude test negatives)
test_neg_ids = {item["id"] for item in test_items if item.get("isNegative")}
train_neg = [rid for rid in neg_sample if rid not in test_ids]
for rid in train_neg:
    X_train.append(cache[rid]["vec"])
    y_train.append("No match")

X_train = np.array(X_train, dtype=np.float32)
y_train = np.array(y_train)

# Build test set from sweep items
X_test = []
y_test = []
test_order = []  # preserve order for per-item analysis
for item in test_items:
    rid = item["id"]
    if rid not in cache or not cache[rid].get("vec"):
        continue
    X_test.append(cache[rid]["vec"])
    y_test.append(item["groundTruth"])
    test_order.append(item)

X_test = np.array(X_test, dtype=np.float32)
y_test = np.array(y_test)

print(f"  Train: {len(X_train)} ({len(X_train) - len(train_neg)} pos + {len(train_neg)} neg)")
print(f"  Test:  {len(X_test)} ({sum(1 for y in y_test if y != 'No match')} pos + {sum(1 for y in y_test if y == 'No match')} neg)")

# Train
lr_b = LogisticRegression(max_iter=1000, C=1.0, solver="lbfgs")
lr_b.fit(X_train, y_train)

# Predict with probability thresholds
proba = lr_b.predict_proba(X_test)
classes = lr_b.classes_

def score_at_threshold(proba, classes, y_true, reject_thresh):
    """Replicate sweep's score() function."""
    tp = 0
    wrong_cat = 0
    missed = 0
    false_assign = 0
    true_reject = 0

    picks = []
    for i in range(len(y_true)):
        max_prob = proba[i].max()
        pred_class = classes[proba[i].argmax()]

        if max_prob < reject_thresh:
            pick = "No match"
        else:
            pick = pred_class
        picks.append(pick)

        gt = y_true[i]
        is_neg = gt == "No match"
        assigned = pick != "No match"

        if is_neg:
            if assigned:
                false_assign += 1
            else:
                true_reject += 1
        else:
            if pick == gt:
                tp += 1
            elif not assigned:
                missed += 1
            else:
                wrong_cat += 1

    total = len(y_true)
    total_assigned = tp + wrong_cat + false_assign
    total_positive = tp + wrong_cat + missed
    total_negative = true_reject + false_assign

    precision = tp / total_assigned * 100 if total_assigned > 0 else 100.0
    recall = tp / total_positive * 100 if total_positive > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    fpr = false_assign / total_negative * 100 if total_negative > 0 else 0.0
    accuracy = (tp + true_reject) / total * 100

    return {
        "threshold": reject_thresh,
        "tp": tp, "wrongCat": wrong_cat, "missed": missed,
        "falseAssign": false_assign, "trueReject": true_reject,
        "precision": precision, "recall": recall, "f1": f1,
        "fpr": fpr, "accuracy": accuracy, "picks": picks,
    }

# Sweep reject thresholds
thresholds = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
threshold_results = []

print(f"\n{'Threshold':>10} {'TP':>6} {'WrongC':>8} {'FalseA':>8} {'Missed':>8} {'TrueRj':>8} {'Prec':>8} {'Recall':>8} {'F1':>8} {'FPR':>8}")
print("─" * 98)

best_f1 = 0
best_result = None
for thresh in thresholds:
    r = score_at_threshold(proba, classes, y_test, thresh)
    threshold_results.append(r)
    print(f"  {thresh:>7.1f}   {r['tp']:>4}   {r['wrongCat']:>6}   {r['falseAssign']:>6}   {r['missed']:>6}   {r['trueReject']:>6}   {r['precision']:>5.0f}%   {r['recall']:>5.0f}%   {r['f1']:>5.1f}   {r['fpr']:>5.0f}%")
    if r["f1"] > best_f1:
        best_f1 = r["f1"]
        best_result = r

# ── Comparison with sweep strategies ──

print(f"\n{'═' * 80}")
print("COMPARISON WITH SWEEP STRATEGIES")
print("═" * 80)

col_w = 10
name_w = 30
cfg_w = 30
print(f"{'Strategy':<{name_w}} {'Config':<{cfg_w}} {'TP':>{col_w}} {'WrongC':>{col_w}} {'FalseA':>{col_w}} {'Missed':>{col_w}} {'TrueRj':>{col_w}} {'Prec':>{col_w}} {'Recall':>{col_w}} {'F1':>{col_w}} {'FPR':>{col_w}}")
print("─" * (name_w + cfg_w + col_w * 9))

# Sweep best per family
for fam in sweep_data["families"]:
    name = fam["family"][:name_w - 2]
    cfg = fam["bestConfig"][:cfg_w - 2]
    # Find best config
    best_cfg = max(fam["configs"], key=lambda c: c["f1"])
    print(f"{name:<{name_w}} {cfg:<{cfg_w}} {best_cfg['tp']:>{col_w}} {best_cfg['wrongCat']:>{col_w}} {best_cfg['falseAssign']:>{col_w}} {best_cfg['missed']:>{col_w}} {best_cfg['trueReject']:>{col_w}} {best_cfg['precision']:>{col_w - 1}.0f}% {best_cfg['recall']:>{col_w - 1}.0f}% {best_cfg['f1']:>{col_w - 1}.1f} {best_cfg['fpr']:>{col_w - 1}.0f}%")

# Logreg row
print("─" * (name_w + cfg_w + col_w * 9))
b = best_result
cfg_str = f"reject<{b['threshold']}"
print(f"{'LogReg (this script)':<{name_w}} {cfg_str:<{cfg_w}} {b['tp']:>{col_w}} {b['wrongCat']:>{col_w}} {b['falseAssign']:>{col_w}} {b['missed']:>{col_w}} {b['trueReject']:>{col_w}} {b['precision']:>{col_w - 1}.0f}% {b['recall']:>{col_w - 1}.0f}% {b['f1']:>{col_w - 1}.1f} {b['fpr']:>{col_w - 1}.0f}%")

# ── Per-collection analysis ──

print(f"\n{'═' * 80}")
print("PER-COLLECTION PERFORMANCE (at best threshold)")
print("═" * 80)

# Retrain for per-collection stats
pred_labels = [best_result["picks"][i] for i in range(len(y_test))]
per_collection = {}
for i, gt in enumerate(y_test):
    if gt == "No match":
        continue
    if gt not in per_collection:
        per_collection[gt] = {"correct": 0, "total": 0, "wrong": [], "missed": 0}
    per_collection[gt]["total"] += 1
    if pred_labels[i] == gt:
        per_collection[gt]["correct"] += 1
    elif pred_labels[i] == "No match":
        per_collection[gt]["missed"] += 1
    else:
        per_collection[gt]["wrong"].append(pred_labels[i])

print(f"\n{'Collection':<30} {'Correct':>8} {'Total':>8} {'Acc':>8} {'Missed':>8} {'Confused with':}")
print("─" * 100)
for name in sorted(per_collection, key=lambda n: per_collection[n]["correct"] / max(per_collection[n]["total"], 1)):
    pc = per_collection[name]
    acc = pc["correct"] / pc["total"] * 100 if pc["total"] > 0 else 0
    confused = ", ".join(pc["wrong"][:3]) if pc["wrong"] else "-"
    print(f"{name[:29]:<30} {pc['correct']:>8} {pc['total']:>8} {acc:>6.0f}% {pc['missed']:>8}   {confused}")

# ── Diagnosis ──

print(f"\n{'═' * 80}")
print("DIAGNOSIS")
print("═" * 80)

sweep_best_f1 = max(
    max(c["f1"] for c in fam["configs"])
    for fam in sweep_data["families"]
)

delta = best_f1 - sweep_best_f1
print(f"  Best sweep F1:  {sweep_best_f1:.1f}")
print(f"  Best logreg F1: {best_f1:.1f} (at reject threshold {best_result['threshold']})")
print(f"  Delta:          {delta:+.1f}")

if best_f1 > 62:
    print(f"\n  → EMBEDDINGS ARE SEPARABLE. Classifier is the bottleneck.")
    print(f"    Recommended: Phase 2+3, then Phase 5 (cross-encoder reranking)")
elif best_f1 > 56:
    print(f"\n  → MARGINAL IMPROVEMENT. Both embeddings and classifier contribute.")
    print(f"    Recommended: Phase 2+3, then evaluate whether Phase 4 or 5")
else:
    print(f"\n  → EMBEDDINGS ARE THE BOTTLENECK. Even a linear classifier can't separate.")
    print(f"    Recommended: Phase 2+3, then Phase 4 (embedding fine-tuning)")

# ── Save JSON ──

output = {
    "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "cv": cv_summary,
    "sweep_eval": {
        "best_f1": best_f1,
        "best_threshold": best_result["threshold"],
        "precision": best_result["precision"],
        "recall": best_result["recall"],
        "fpr": best_result["fpr"],
        "tp": best_result["tp"],
        "wrongCat": best_result["wrongCat"],
        "missed": best_result["missed"],
        "falseAssign": best_result["falseAssign"],
        "trueReject": best_result["trueReject"],
        "by_threshold": [
            {k: v for k, v in r.items() if k != "picks"}
            for r in threshold_results
        ],
    },
    "per_collection": [
        {"name": name, "correct": pc["correct"], "total": pc["total"],
         "accuracy": pc["correct"] / pc["total"] * 100 if pc["total"] > 0 else 0,
         "confused_with": pc["wrong"][:5]}
        for name, pc in sorted(per_collection.items())
    ],
    "diagnosis": {
        "sweep_best_f1": sweep_best_f1,
        "logreg_best_f1": best_f1,
        "delta": delta,
        "bottleneck": "classifier" if best_f1 > 62 else "both" if best_f1 > 56 else "embeddings",
    },
    "train_size": len(X_train),
    "test_size": len(X_test),
}

out_path = ROOST_DIR / "logreg-results.json"
with open(out_path, "w") as f:
    json.dump(output, f, indent=2)
print(f"\nSaved to {out_path}")
