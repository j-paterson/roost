#!/usr/bin/env python3
"""
Phase 5: Cross-encoder reranking evaluation.

Instead of modifying embeddings, use a cross-encoder to re-score (item, collection)
pairs. Cross-encoders see both texts simultaneously and are purpose-built for
relevance scoring — ~10ms/pair vs 24s/pair for LLM prompting.

Approach:
  1. Load test items from strategy-results.json (exact same 169 items)
  2. For each item, take top-K candidates by embedding similarity
  3. Score each (item_summary, collection_description) pair with cross-encoder
  4. Sweep top_k × score_threshold × reject strategies
  5. Report in same format as sweep ranking

Usage:
  ~/ObsidianBookmarks/.roost/venv/bin/python scripts/cross-encoder-sweep.py
  ~/ObsidianBookmarks/.roost/venv/bin/python scripts/cross-encoder-sweep.py --model stsb-roberta-base

Output:
  .roost/cross-encoder-results.json
"""

import argparse
import json
import re
import time
import sys
from pathlib import Path
from collections import defaultdict

import numpy as np
from sentence_transformers import CrossEncoder

VAULT_PATH = Path.home() / "ObsidianBookmarks"
ROOST_DIR = VAULT_PATH / ".roost"
RESULTS_PATH = ROOST_DIR / "strategy-results.json"
CACHE_PATH = ROOST_DIR / "embedding-cache.json"
CONTRASTIVE_PATH = ROOST_DIR / "collection-descriptions-contrastive.json"
OUTPUT_PATH = ROOST_DIR / "cross-encoder-results.json"

# Cross-encoder models to evaluate.
# Key: short alias used with --model flag.
# Value: (HuggingFace model name, score normalization range (min, max))
#   normalization range is used for weighted combination strategy only.
ALL_MODELS = {
    "ms-marco":      ("cross-encoder/ms-marco-MiniLM-L-6-v2", (-10, 10)),
    "stsb-roberta":  ("cross-encoder/stsb-roberta-base",       (0, 1)),
    "nli-deberta":   ("cross-encoder/nli-deberta-v3-small",    (0, 1)),
}

TOP_K_VALUES = [2, 3, 4, 5, 7]
# ms-marco produces scores in ~[-12, 2]; use percentile-based thresholds resolved
# from the actual score distribution at runtime (see run_model).
SCORE_THRESHOLD_PERCENTILES = [0, 25, 50, 60, 70, 80, 90, 95]


def _parse_frontmatter(content):
    """Return dict of frontmatter fields, honoring multi-line quoted values."""
    if not content.startswith("---\n"):
        return {}
    end = content.find("\n---", 4)
    if end < 0:
        return {}
    fm_text = content[4:end]
    fields = {}
    i = 0
    lines = fm_text.split("\n")
    while i < len(lines):
        line = lines[i]
        m = re.match(r'^(\w+):\s*(.*)$', line)
        if not m:
            i += 1
            continue
        key = m.group(1)
        val = m.group(2).strip()
        if val.startswith('"') and not (val.endswith('"') and len(val) > 1):
            parts = [val[1:]]
            i += 1
            while i < len(lines):
                parts.append(lines[i])
                if lines[i].rstrip().endswith('"'):
                    break
                i += 1
            joined = " ".join(parts)
            if joined.endswith('"'):
                joined = joined[:-1]
            fields[key] = joined
        else:
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            fields[key] = val
        i += 1
    return fields


def load_vault_data():
    """Return dict[roost_id -> {title, subtitle, collection}] for every bookmark.

    Matches sweep semantics: roost_category wins over collection when both present.
    """
    data = {}
    for md_file in (VAULT_PATH / "Bookmarks").rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        fm = _parse_frontmatter(content)
        rid = fm.get("roost_id")
        if not rid:
            continue
        coll = fm.get("roost_category") or fm.get("collection")
        if coll in ("undefined", "null", "", None):
            coll = None
        data[rid] = {
            "title": fm.get("title", ""),
            "subtitle": fm.get("subtitle", ""),
            "collection": coll,
        }
    return data


def load_collection_labels(vault_data):
    """Derive id->collection map from vault_data."""
    return {rid: v["collection"] for rid, v in vault_data.items() if v.get("collection")}


def build_item_text(cache_entry, vault_entry):
    """Reconstruct the 5-field embed text used in production.

    Matches src/pipeline/describe-items.ts:251 exactly:
      [entry.vision, entry.summary, entry.category, item.text, item.subtitle]
    where item.text = frontmatter.title and item.subtitle = frontmatter.subtitle.
    """
    parts = []
    for val in [
        cache_entry.get("vision"),
        cache_entry.get("summary"),
        cache_entry.get("category"),
        vault_entry.get("title") if vault_entry else None,
        vault_entry.get("subtitle") if vault_entry else None,
    ]:
        if val:
            parts.append(val)
    return " ".join(parts)


def cosine_sim(a, b):
    a, b = np.array(a), np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))


def compute_centroid(vecs):
    return np.mean(vecs, axis=0)


def score_predictions(test_items, picks):
    """Same scoring logic as the JS sweep script."""
    N = len(test_items)
    tp = wrongCat = missed = falseAssign = trueReject = 0

    for i in range(N):
        gt = test_items[i]["groundTruth"]
        pick = picks[i]
        is_neg = gt == "No match"
        assigned = pick != "No match"

        if is_neg:
            if assigned:
                falseAssign += 1
            else:
                trueReject += 1
        else:
            if pick == gt:
                tp += 1
            elif not assigned:
                missed += 1
            else:
                wrongCat += 1

    total_assigned = tp + wrongCat + falseAssign
    total_positive = tp + wrongCat + missed
    total_negative = trueReject + falseAssign

    precision = tp / total_assigned * 100 if total_assigned > 0 else 100
    recall = tp / total_positive * 100 if total_positive > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    fpr = falseAssign / total_negative * 100 if total_negative > 0 else 0
    accuracy = (tp + trueReject) / N * 100

    return {
        "tp": tp, "wrongCat": wrongCat, "missed": missed,
        "falseAssign": falseAssign, "trueReject": trueReject,
        "precision": precision, "recall": recall, "f1": f1,
        "fpr": fpr, "accuracy": accuracy,
    }


def run_model(model_alias, model_name, score_range, test_items, all_pairs, pair_indices):
    """Load a cross-encoder, score all pairs, sweep configs, return (families, score_dist, elapsed)."""
    score_min, score_max = score_range

    print(f"\n{'='*70}")
    print(f"MODEL: {model_alias}  ({model_name})")
    print(f"{'='*70}")
    print(f"  Loading...")
    model = CrossEncoder(model_name)

    print(f"  Scoring {len(all_pairs)} pairs...")
    t0 = time.time()
    raw_scores = model.predict(all_pairs, show_progress_bar=True)
    elapsed = time.time() - t0
    print(f"  Scored in {elapsed:.1f}s ({len(all_pairs)/elapsed:.0f} pairs/s)")

    # NLI models return shape (N, 3) = [contradiction, neutral, entailment].
    # Collapse to a scalar: use entailment probability (index 2).
    raw_scores = np.array(raw_scores)
    if raw_scores.ndim == 2:
        print(f"  NLI output shape {raw_scores.shape} — using entailment score (col 2)")
        scores = raw_scores[:, 2]
    else:
        scores = raw_scores

    # Attach scores back to candidates (work on a deep copy so models don't interfere)
    import copy
    items = copy.deepcopy(test_items)
    for idx, (i, j) in enumerate(pair_indices):
        items[i]["candidates"][j]["ce_score"] = float(scores[idx])

    all_scores = [float(s) for s in scores]
    score_dist = {
        "min": min(all_scores),
        "max": max(all_scores),
        "mean": float(np.mean(all_scores)),
        "median": float(np.median(all_scores)),
    }
    print(f"  Score dist: min={score_dist['min']:.3f} max={score_dist['max']:.3f} "
          f"mean={score_dist['mean']:.3f} median={score_dist['median']:.3f}")

    # Resolve percentile thresholds against the actual score distribution so the
    # sweep is meaningful across models with very different output ranges.
    sorted_scores = sorted(all_scores)
    def pct(p):
        if not sorted_scores:
            return 0.0
        idx = min(len(sorted_scores) - 1, int(p / 100 * len(sorted_scores)))
        return sorted_scores[idx]
    score_thresholds = [(p, pct(p)) for p in SCORE_THRESHOLD_PERCENTILES]
    print(f"  Thresholds (percentile→value): " + ", ".join(f"p{p}={v:.2f}" for p, v in score_thresholds))

    # === PURE ARGMAX TEST ===
    # Does the CE's argmax within top-K beat the embedding's argmax (top-1)?
    # No threshold, no rejection — isolates ranking signal.
    # Baseline: embedding top-1 recall = 58.8% on positives.
    print(f"\n  Pure CE argmax (no threshold, positives only):")
    pos_items = [it for it in items if it["groundTruth"] != "No match"]
    n_pos = len(pos_items)
    for K in sorted(TOP_K_VALUES):
        ce_correct = 0
        for item in pos_items:
            cands = item["candidates"][:K]
            best = max(cands, key=lambda c: c["ce_score"])
            if best["name"] == item["groundTruth"]:
                ce_correct += 1
        pct_ce = ce_correct / n_pos * 100 if n_pos else 0
        delta = pct_ce - 58.8
        marker = " ← BEATS embedding" if pct_ce > 58.8 else ""
        print(f"    K={K}: {ce_correct}/{n_pos} = {pct_ce:.1f}% ({'+' if delta>=0 else ''}{delta:.1f}pp vs top-1){marker}")

    all_configs = []

    # Strategy 1: Cross-encoder only (pick highest CE score above threshold)
    for top_k in TOP_K_VALUES:
        for pct_label, thresh in score_thresholds:
            picks = []
            for item in items:
                cands = item["candidates"][:top_k]
                best = max(cands, key=lambda c: c["ce_score"])
                if best["ce_score"] >= thresh:
                    picks.append(best["name"])
                else:
                    picks.append("No match")

            s = score_predictions(items, picks)
            all_configs.append({
                "family": "Cross-encoder only",
                "params": {"top_k": top_k, "score_threshold": thresh, "percentile": pct_label},
                "label": f"K={top_k} ce≥p{pct_label}({thresh:.1f})",
                **s,
            })

    # Strategy 2: Embedding pre-filter + cross-encoder
    for sim_floor in [0.68, 0.70, 0.72]:
        for top_k in TOP_K_VALUES:
            for pct_label, thresh in score_thresholds:
                picks = []
                for item in items:
                    cands = item["candidates"][:top_k]
                    if cands[0]["sim"] < sim_floor:
                        picks.append("No match")
                        continue
                    best = max(cands, key=lambda c: c["ce_score"])
                    if best["ce_score"] >= thresh:
                        picks.append(best["name"])
                    else:
                        picks.append("No match")

                s = score_predictions(items, picks)
                all_configs.append({
                    "family": "Hybrid embed+CE",
                    "params": {"sim_floor": sim_floor, "top_k": top_k, "score_threshold": thresh, "percentile": pct_label},
                    "label": f"sim≥{sim_floor} K={top_k} ce≥p{pct_label}",
                    **s,
                })

    # Strategy 3: Weighted combination of embedding sim and CE score
    for top_k in [3, 5]:
        for ce_weight in [0.3, 0.5, 0.7]:
            for combined_thresh in [0.3, 0.4, 0.5, 0.6]:
                picks = []
                for item in items:
                    cands = item["candidates"][:top_k]
                    score_span = score_max - score_min
                    for c in cands:
                        c["ce_norm"] = max(0.0, min(1.0, (c["ce_score"] - score_min) / (score_span + 1e-8)))
                    best = max(cands, key=lambda c: (1 - ce_weight) * c["sim"] + ce_weight * c["ce_norm"])
                    combined = (1 - ce_weight) * best["sim"] + ce_weight * best["ce_norm"]
                    if combined >= combined_thresh:
                        picks.append(best["name"])
                    else:
                        picks.append("No match")

                s = score_predictions(items, picks)
                all_configs.append({
                    "family": "Weighted embed+CE",
                    "params": {"top_k": top_k, "ce_weight": ce_weight, "combined_threshold": combined_thresh},
                    "label": f"K={top_k} w={ce_weight} t≥{combined_thresh}",
                    **s,
                })

    families = defaultdict(list)
    for cfg in all_configs:
        families[cfg["family"]].append(cfg)

    return dict(families), score_dist, elapsed


def report_model(model_alias, model_name, families, score_dist, results, test_items):
    """Print per-model summary table."""
    col_w = 10
    name_w = 28
    cfg_w = 42

    print(f"\n{'='*130}")
    print(f"RESULTS: {model_alias} ({model_name})")
    print(f"  Score dist: min={score_dist['min']:.3f} max={score_dist['max']:.3f} "
          f"mean={score_dist['mean']:.3f} median={score_dist['median']:.3f}")
    print(f"{'='*130}")

    best_per_family = []
    for family, configs in families.items():
        configs.sort(key=lambda c: (-c["f1"], -c["accuracy"]))
        best = configs[0]
        worst = configs[-1]
        best_per_family.append(best)
        print(f"\n  {family} ({len(configs)} configs):")
        print(f"    Best:  {best['label']:40s} F1={best['f1']:.1f} prec={best['precision']:.0f}% rec={best['recall']:.0f}% FPR={best['fpr']:.0f}%")
        print(f"    Worst: {worst['label']:40s} F1={worst['f1']:.1f} prec={worst['precision']:.0f}% rec={worst['recall']:.0f}% FPR={worst['fpr']:.0f}%")
        print(f"    Range: {best['f1'] - worst['f1']:.1f} F1 spread")

    best_per_family.sort(key=lambda c: (-c["f1"], -c["accuracy"]))

    header = (
        "Strategy".ljust(name_w) + "Config".ljust(cfg_w) +
        "TP".rjust(col_w) + "WrongC".rjust(col_w) + "FalseA".rjust(col_w) +
        "Missed".rjust(col_w) + "TrueRj".rjust(col_w) +
        "Prec".rjust(col_w) + "Recall".rjust(col_w) + "F1".rjust(col_w) + "FPR".rjust(col_w)
    )
    print(f"\n{header}")
    print("-" * len(header))
    for b in best_per_family:
        print(
            b["family"][:name_w-2].ljust(name_w) + b["label"].ljust(cfg_w) +
            str(b["tp"]).rjust(col_w) + str(b["wrongCat"]).rjust(col_w) +
            str(b["falseAssign"]).rjust(col_w) + str(b["missed"]).rjust(col_w) +
            str(b["trueReject"]).rjust(col_w) +
            f"{b['precision']:.0f}%".rjust(col_w) + f"{b['recall']:.0f}%".rjust(col_w) +
            f"{b['f1']:.1f}".rjust(col_w) + f"{b['fpr']:.0f}%".rjust(col_w)
        )
    print("-" * len(header))
    print("Baselines from embedding sweep:")
    print(f"  Two-pass NOT (gemma4) sim≥0.72 score≥3:     F1=56.8  prec=57%  rec=56%  FPR=36%")
    print(f"  Embedding-only sim≥0.75:                     F1=51.6  prec=50%  rec=53%  FPR=36%")
    print(f"  Unsorted centroid ratio≥1.02:                F1=55.2  prec=53%  rec=58%  FPR=34%")
    print(f"  Embedding ceiling: top-1={results['embeddingCeiling']['top1Positive']}/{results['embeddingCeiling']['totalPositive']} ({results['embeddingCeiling']['top1Positive']/results['embeddingCeiling']['totalPositive']*100:.0f}%)")

    return best_per_family


def main():
    parser = argparse.ArgumentParser(description="Phase 5: Cross-encoder reranking evaluation")
    parser.add_argument(
        "--model",
        choices=list(ALL_MODELS.keys()),
        default=None,
        help=f"Run a single model alias instead of all. Choices: {', '.join(ALL_MODELS.keys())}",
    )
    args = parser.parse_args()

    models_to_run = (
        {args.model: ALL_MODELS[args.model]}
        if args.model
        else ALL_MODELS
    )

    print("Phase 5: Cross-Encoder Reranking\n")
    print(f"Models to evaluate: {', '.join(models_to_run.keys())}\n")

    # Load data
    print("Loading data...")
    cache = json.load(open(CACHE_PATH))
    results = json.load(open(RESULTS_PATH))
    contrastive_descs = json.load(open(CONTRASTIVE_PATH))
    vault_data = load_vault_data()
    labels = load_collection_labels(vault_data)
    print(f"  {len(vault_data)} vault entries, {len(labels)} labeled")

    test_items_raw = results["testItems"]
    test_ids = set(ti["id"] for ti in test_items_raw)
    print(f"  {len(cache)} items in cache")
    print(f"  {len(test_items_raw)} test items ({results['positiveCount']} pos, {results['negativeCount']} neg)")
    print(f"  {len(contrastive_descs)} collection descriptions")

    # Build collection centroids (excluding test items, with leave-one-out)
    collection_vecs = defaultdict(list)
    collection_ids = defaultdict(list)
    for item_id, coll in labels.items():
        if item_id in cache and cache[item_id].get("vec"):
            collection_vecs[coll].append(np.array(cache[item_id]["vec"]))
            collection_ids[coll].append(item_id)

    centroids = {}
    for coll, vecs in collection_vecs.items():
        if len(vecs) >= 1:
            centroids[coll] = np.mean(vecs, axis=0)

    collections = list(centroids.keys())
    print(f"  {len(collections)} collections with centroids")

    # Build test items with candidates (shared across all models)
    max_k = max(TOP_K_VALUES)
    test_items = []
    for ti in test_items_raw:
        item_id = ti["id"]
        gt = ti["groundTruth"]
        if item_id not in cache or not cache[item_id].get("vec"):
            continue

        vec = np.array(cache[item_id]["vec"])
        item_text = build_item_text(cache[item_id], vault_data.get(item_id, {}))

        sims = []
        for coll in collections:
            centroid = centroids[coll]
            if gt == coll and len(collection_vecs[coll]) > 1:
                n = len(collection_vecs[coll])
                centroid = (centroid * n - vec) / (n - 1)
            sim = cosine_sim(vec, centroid)
            desc = contrastive_descs.get(coll, "")
            sims.append({"name": coll, "sim": sim, "description": desc if isinstance(desc, str) else ""})

        sims.sort(key=lambda x: -x["sim"])
        candidates = sims[:max_k]

        test_items.append({
            "id": item_id,
            "groundTruth": gt,
            "text": item_text,
            "candidates": candidates,
        })

    print(f"  {len(test_items)} test items with candidates")

    # Build pair list once (shared across models)
    all_pairs = []
    pair_indices = []
    for i, item in enumerate(test_items):
        for j, cand in enumerate(item["candidates"]):
            passage = cand["description"] or cand["name"]
            all_pairs.append((item["text"], passage))
            pair_indices.append((i, j))
    print(f"  {len(all_pairs)} pairs per model\n")

    # Baseline sanity check: GT-in-top-K for the actual candidate pool.
    # This is the TRUE reranker ceiling — a perfect reranker can't exceed it.
    print(f"{'='*70}")
    print(f"CANDIDATE POOL COVERAGE (cached embeddings, sweep-matching LOO)")
    print(f"{'='*70}")
    pos_count = sum(1 for item in test_items if item["groundTruth"] != "No match")
    for K in sorted(TOP_K_VALUES):
        hits = sum(
            1 for item in test_items
            if item["groundTruth"] != "No match"
            and any(c["name"] == item["groundTruth"] for c in item["candidates"][:K])
        )
        print(f"  GT in top-{K}: {hits}/{pos_count} ({hits/pos_count*100:.1f}%)")
    print(f"  Embedding argmax (top-1) = reranker's baseline to beat: 58.8%")
    print()

    # Run each model
    all_model_results = {}
    for alias, (model_name, score_range) in models_to_run.items():
        families, score_dist, elapsed = run_model(
            alias, model_name, score_range, test_items, all_pairs, pair_indices
        )
        best_per_family = report_model(alias, model_name, families, score_dist, results, test_items)
        all_model_results[alias] = {
            "modelName": model_name,
            "scoringTime": elapsed,
            "pairsScored": len(all_pairs),
            "scoreDistribution": score_dist,
            "families": {
                family: [
                    {k: v for k, v in c.items() if k != "family"}
                    for c in configs
                ]
                for family, configs in families.items()
            },
            "bestPerFamily": [{k: v for k, v in b.items()} for b in best_per_family],
        }

    # Final cross-model comparison (only when running all models)
    if len(models_to_run) > 1:
        print(f"\n{'='*130}")
        print("CROSS-MODEL COMPARISON (best F1 per model)")
        print(f"{'='*130}")
        col_w = 10
        name_w = 20
        cfg_w = 44
        header = (
            "Model".ljust(name_w) + "BestConfig".ljust(cfg_w) +
            "TP".rjust(col_w) + "WrongC".rjust(col_w) + "FalseA".rjust(col_w) +
            "Missed".rjust(col_w) + "TrueRj".rjust(col_w) +
            "Prec".rjust(col_w) + "Recall".rjust(col_w) + "F1".rjust(col_w) + "FPR".rjust(col_w)
        )
        print(header)
        print("-" * len(header))

        comparison_rows = []
        for alias, data in all_model_results.items():
            best = sorted(data["bestPerFamily"], key=lambda c: (-c["f1"], -c["accuracy"]))[0]
            comparison_rows.append((alias, best))

        comparison_rows.sort(key=lambda x: (-x[1]["f1"], -x[1]["accuracy"]))
        for alias, b in comparison_rows:
            print(
                alias[:name_w-2].ljust(name_w) + b["label"].ljust(cfg_w) +
                str(b["tp"]).rjust(col_w) + str(b["wrongCat"]).rjust(col_w) +
                str(b["falseAssign"]).rjust(col_w) + str(b["missed"]).rjust(col_w) +
                str(b["trueReject"]).rjust(col_w) +
                f"{b['precision']:.0f}%".rjust(col_w) + f"{b['recall']:.0f}%".rjust(col_w) +
                f"{b['f1']:.1f}".rjust(col_w) + f"{b['fpr']:.0f}%".rjust(col_w)
            )
        print("-" * len(header))
        print("Baselines from embedding sweep:")
        print(f"  Two-pass NOT (gemma4) sim≥0.72 score≥3:     F1=56.8  prec=57%  rec=56%  FPR=36%")
        print(f"  Embedding-only sim≥0.75:                     F1=51.6  prec=50%  rec=53%  FPR=36%")
        print(f"  Unsorted centroid ratio≥1.02:                F1=55.2  prec=53%  rec=58%  FPR=34%")
        print(f"  Embedding ceiling: top-1={results['embeddingCeiling']['top1Positive']}/{results['embeddingCeiling']['totalPositive']} ({results['embeddingCeiling']['top1Positive']/results['embeddingCeiling']['totalPositive']*100:.0f}%)")

    # Save JSON
    output = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "modelsRun": list(models_to_run.keys()),
        "testSize": len(test_items),
        "positiveCount": results["positiveCount"],
        "negativeCount": results["negativeCount"],
        "models": all_model_results,
    }
    json.dump(output, open(OUTPUT_PATH, "w"), indent=2)
    print(f"\nSaved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
