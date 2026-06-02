#!/usr/bin/env python3
"""
Phase 4: Fine-tune nomic-embed-text on collection labels using contrastive learning.

Approach:
  1. Load embedding cache (text fields) + vault frontmatter (collection labels)
  2. Build contrastive training pairs: same-collection = positive,
     high-similarity different-collection = hard negative
  3. Fine-tune nomic-ai/nomic-embed-text-v1.5 with MultipleNegativesRankingLoss
  4. Re-embed all items with fine-tuned model → new cache file
  5. Re-run sweep to compare

Usage:
  <vault>/.roost/venv/bin/python scripts/finetune-embeddings.py --vault-root <vault> [--train-only] [--embed-only] [--baseline]
  # or set ROOST_VAULT env var instead of --vault-root

Flags:
  --baseline   Load HF base model (no fine-tuning), re-embed all items, evaluate, and print
               results alongside Ollama baseline. Saves to embedding-cache-hf-baseline.json.

Outputs:
  .roost/nomic-finetuned/               — fine-tuned model weights
  .roost/embedding-cache-finetuned.json — re-embedded vectors (fine-tuned)
  .roost/embedding-cache-hf-baseline.json — re-embedded vectors (HF base model, no fine-tuning)
"""

import json
import os
import sys
import random
import time
from pathlib import Path
from collections import defaultdict

import numpy as np
import torch
from sentence_transformers import SentenceTransformer, InputExample, losses
from torch.utils.data import DataLoader

TRAIN_ONLY = "--train-only" in sys.argv
EMBED_ONLY = "--embed-only" in sys.argv
BASELINE_ONLY = "--baseline" in sys.argv
NO_PREFIX = "--no-prefix" in sys.argv

PREFIX = "" if NO_PREFIX else "search_document: "
SUFFIX = "-noprefix" if NO_PREFIX else ""

def _resolve_vault_root():
    """Vault root from --vault-root flag (next argv) or ROOST_VAULT env. Required."""
    if "--vault-root" in sys.argv:
        i = sys.argv.index("--vault-root")
        if i + 1 < len(sys.argv):
            raw = sys.argv[i + 1]
        else:
            print("--vault-root requires a path argument", file=sys.stderr)
            sys.exit(2)
    else:
        raw = os.environ.get("ROOST_VAULT")
    if not raw:
        print("vault root required: pass --vault-root <path> or set ROOST_VAULT", file=sys.stderr)
        sys.exit(2)
    p = Path(raw).expanduser().resolve()
    if not p.exists():
        print(f"vault root does not exist: {p}", file=sys.stderr)
        sys.exit(2)
    return p


VAULT_PATH = _resolve_vault_root()
ROOST_DIR = VAULT_PATH / ".roost"
CACHE_DIR = ROOST_DIR / "cache"
BUILD_DIR = ROOST_DIR / "build"
CACHE_PATH = CACHE_DIR / "embedding-cache.json"
MODEL_OUT = BUILD_DIR / f"nomic-finetuned{SUFFIX}"
FINETUNED_CACHE = BUILD_DIR / f"embedding-cache-finetuned{SUFFIX}.json"
RESULTS_PATH = BUILD_DIR / "strategy-results.json"
HF_BASELINE_CACHE = BUILD_DIR / f"embedding-cache-hf-baseline{SUFFIX}.json"

SEED = 42
MAX_PAIRS_PER_COLLECTION = 500
EPOCHS = 3
BATCH_SIZE = 8
BASE_MODEL = "nomic-ai/nomic-embed-text-v1.5"

random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)


def load_collection_labels():
    """Scan vault frontmatter for collection assignments."""
    bookmarks_dir = VAULT_PATH / "Bookmarks"
    labels = {}  # id → collection name

    for md_file in bookmarks_dir.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue

        # Parse frontmatter
        if not content.startswith("---\n"):
            continue
        end = content.find("\n---", 4)
        if end < 0:
            continue
        fm = content[4:end]

        roost_id = None
        collection = None
        for line in fm.split("\n"):
            if line.startswith("roost_id:"):
                roost_id = line.split(":", 1)[1].strip().strip('"')
            elif line.startswith("collection:") or line.startswith("roost_category:"):
                val = line.split(":", 1)[1].strip().strip('"')
                if val and val not in ("undefined", "null"):
                    collection = val

        if roost_id and collection:
            labels[roost_id] = collection

    return labels


def build_embed_text(entry):
    """Reconstruct the text that was originally embedded (same as describe-items.ts)."""
    parts = []
    for field in ["vision", "summary", "category"]:
        val = entry.get(field)
        if val:
            parts.append(val)
    return " ".join(parts)


def build_training_data(cache, labels, test_ids):
    """Build contrastive training pairs from labeled data, excluding test items."""
    # Group items by collection
    collection_items = defaultdict(list)
    for item_id, coll in labels.items():
        if item_id in test_ids:
            continue
        if item_id not in cache or "vec" not in cache[item_id]:
            continue
        text = build_embed_text(cache[item_id])
        if len(text) < 10:
            continue
        collection_items[coll].append((item_id, text))

    collections = [c for c, items in collection_items.items() if len(items) >= 3]
    print(f"  {len(collections)} collections with 3+ training items")
    print(f"  {sum(len(collection_items[c]) for c in collections)} total training items")

    # Pre-compute centroids for hard negative mining
    centroids = {}
    for coll in collections:
        vecs = [np.array(cache[iid]["vec"]) for iid, _ in collection_items[coll]]
        centroids[coll] = np.mean(vecs, axis=0)

    # For each collection, find the 5 nearest other collections (hard negative sources)
    nearest_colls = {}
    for coll in collections:
        sims = []
        c_norm = centroids[coll] / (np.linalg.norm(centroids[coll]) + 1e-8)
        for other in collections:
            if other == coll:
                continue
            o_norm = centroids[other] / (np.linalg.norm(centroids[other]) + 1e-8)
            sims.append((other, float(np.dot(c_norm, o_norm))))
        sims.sort(key=lambda x: -x[1])
        nearest_colls[coll] = [s[0] for s in sims[:5]]

    # Build training examples: (anchor, positive) pairs
    # MultipleNegativesRankingLoss uses in-batch negatives, so we just need
    # anchor-positive pairs. Hard negatives come from other pairs in the batch.
    examples = []
    for coll in collections:
        items = collection_items[coll]
        if len(items) < 2:
            continue

        # Generate pairs within this collection
        pair_count = 0
        shuffled = items.copy()
        random.shuffle(shuffled)

        for i in range(len(shuffled)):
            for j in range(i + 1, len(shuffled)):
                if pair_count >= MAX_PAIRS_PER_COLLECTION:
                    break
                examples.append(InputExample(
                    texts=[f"{PREFIX}{shuffled[i][1]}", f"{PREFIX}{shuffled[j][1]}"]
                ))
                pair_count += 1
            if pair_count >= MAX_PAIRS_PER_COLLECTION:
                break

    random.shuffle(examples)
    print(f"  {len(examples)} training pairs")
    return examples


def train_model(examples):
    """Fine-tune the embedding model."""
    print(f"\nLoading base model: {BASE_MODEL}")
    model = SentenceTransformer(BASE_MODEL, trust_remote_code=True)

    # Use MPS if available (Apple Silicon)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"  Device: {device}")
    model = model.to(device)

    train_dataloader = DataLoader(examples, shuffle=True, batch_size=BATCH_SIZE)
    train_loss = losses.MultipleNegativesRankingLoss(model=model)

    print(f"  Training: {len(examples)} pairs, {EPOCHS} epochs, batch_size={BATCH_SIZE}")
    print(f"  Steps per epoch: {len(train_dataloader)}")

    warmup_steps = int(len(train_dataloader) * EPOCHS * 0.1)
    model.fit(
        train_objectives=[(train_dataloader, train_loss)],
        epochs=EPOCHS,
        warmup_steps=warmup_steps,
        output_path=str(MODEL_OUT),
        show_progress_bar=True,
    )

    print(f"  Model saved to: {MODEL_OUT}")
    return model


def embed_all_items(model, cache):
    """Re-embed all items with the fine-tuned model."""
    print(f"\nRe-embedding {len(cache)} items...")

    # Build text list preserving order
    item_ids = list(cache.keys())
    texts = []
    valid_ids = []
    for item_id in item_ids:
        text = build_embed_text(cache[item_id])
        if len(text) >= 10:
            texts.append(f"{PREFIX}{text}")
            valid_ids.append(item_id)

    print(f"  {len(valid_ids)} items with text (skipped {len(item_ids) - len(valid_ids)})")

    # Encode in batches
    t0 = time.time()
    embeddings = model.encode(
        texts,
        batch_size=16,
        show_progress_bar=True,
        normalize_embeddings=True,
    )
    elapsed = time.time() - t0
    print(f"  Encoded in {elapsed:.1f}s ({len(valid_ids)/elapsed:.0f} items/s)")

    # Build new cache: copy all original fields, replace vec for re-embedded items
    valid_set = set(valid_ids)
    new_cache = {}
    for item_id in item_ids:
        new_cache[item_id] = dict(cache[item_id])

    for i, item_id in enumerate(valid_ids):
        new_cache[item_id]["vec"] = embeddings[i].tolist()

    return new_cache


def evaluate_ceiling(new_cache, labels, test_ids, label="fine-tuned"):
    """Quick check: top-1 embedding ceiling with the given cache."""
    # Load test items from strategy-results.json
    results = json.load(open(RESULTS_PATH))
    test_items = results["testItems"]

    # Build collection centroids from labels (excluding test items)
    collection_vecs = defaultdict(list)
    for item_id, coll in labels.items():
        if item_id in test_ids:
            continue
        if item_id in new_cache and new_cache[item_id].get("vec"):
            collection_vecs[coll].append(np.array(new_cache[item_id]["vec"]))

    centroids = {}
    for coll, vecs in collection_vecs.items():
        if len(vecs) >= 1:
            centroids[coll] = np.mean(vecs, axis=0)

    # Evaluate test items
    top1_correct = 0
    top7_correct = 0
    positive_count = 0

    for ti in test_items:
        if ti["isNegative"]:
            continue
        positive_count += 1

        item_id = ti["id"]
        gt = ti["groundTruth"]
        if item_id not in new_cache or not new_cache[item_id].get("vec"):
            continue

        vec = np.array(new_cache[item_id]["vec"])
        vec_norm = vec / (np.linalg.norm(vec) + 1e-8)

        # Compute leave-one-out centroid for GT collection
        sims = []
        for coll, centroid in centroids.items():
            if coll == gt and coll in collection_vecs:
                # Leave-one-out
                n = len(collection_vecs[coll])
                if n > 1:
                    loo_centroid = (centroid * n - vec) / (n - 1)
                else:
                    loo_centroid = centroid
                c_norm = loo_centroid / (np.linalg.norm(loo_centroid) + 1e-8)
            else:
                c_norm = centroid / (np.linalg.norm(centroid) + 1e-8)
            sims.append((coll, float(np.dot(vec_norm, c_norm))))

        sims.sort(key=lambda x: -x[1])
        if sims and sims[0][0] == gt:
            top1_correct += 1
        if any(s[0] == gt for s in sims[:7]):
            top7_correct += 1

    print(f"\n  Embedding ceiling ({label}) — {positive_count} positive items:")
    print(f"    Top-1 = ground truth: {top1_correct}/{positive_count} ({top1_correct/positive_count*100:.0f}%)")
    print(f"    GT in top-7:          {top7_correct}/{positive_count} ({top7_correct/positive_count*100:.0f}%)")

    return top1_correct, positive_count


def run_hf_baseline(cache, labels, test_ids):
    """Load HF base model (no fine-tuning), re-embed all items, evaluate, save cache."""
    print(f"\nLoading HF base model: {BASE_MODEL}")
    model = SentenceTransformer(BASE_MODEL, trust_remote_code=True)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"  Device: {device}")
    model = model.to(device)

    baseline_cache = embed_all_items(model, cache)

    print(f"\nSaving HF baseline cache to {HF_BASELINE_CACHE}")
    json.dump(baseline_cache, open(HF_BASELINE_CACHE, "w"))
    print(f"  {len(baseline_cache)} items saved")

    top1, total = evaluate_ceiling(baseline_cache, labels, test_ids, label="HF base model")
    return top1, total


def main():
    prefix_mode = "NO PREFIX" if NO_PREFIX else f"prefix='{PREFIX.strip()}'"
    print(f"Phase 4: Embedding Fine-Tuning ({prefix_mode})\n")

    # Load data
    print("Loading data...")
    cache = json.load(open(CACHE_PATH))
    labels = load_collection_labels()
    print(f"  {len(cache)} items in embedding cache")
    print(f"  {len(labels)} labeled items across {len(set(labels.values()))} collections")

    # Load test IDs to exclude from training
    results = json.load(open(RESULTS_PATH))
    test_ids = set(ti["id"] for ti in results["testItems"])
    print(f"  {len(test_ids)} test items excluded from training")

    # Ollama baseline from strategy-results.json
    ollama_top1 = results["embeddingCeiling"]["top1Positive"]
    ollama_total = results["embeddingCeiling"]["totalPositive"]
    ollama_pct = ollama_top1 / ollama_total * 100

    # --baseline flag: just run HF base model evaluation then exit
    if BASELINE_ONLY:
        print("\n-- Baseline mode: HF base model (no fine-tuning) --")
        hf_top1, hf_total = run_hf_baseline(cache, labels, test_ids)
        hf_pct = hf_top1 / hf_total * 100

        print("\n" + "=" * 50)
        print("COMPARISON: Ollama baseline vs HF base model")
        print("=" * 50)
        print(f"  Ollama baseline (nomic-embed-text via API): {ollama_top1}/{ollama_total} ({ollama_pct:.0f}%)")
        print(f"  HF base model  (nomic-embed-text-v1.5 HF):  {hf_top1}/{hf_total} ({hf_pct:.0f}%)")
        diff = hf_pct - ollama_pct
        direction = "+" if diff >= 0 else ""
        print(f"  Difference (HF - Ollama):                   {direction}{diff:.1f}pp")
        print("=" * 50)
        return

    # Normal run: ensure HF baseline cache exists first
    if not HF_BASELINE_CACHE.exists():
        print("\nHF baseline cache not found — generating it before fine-tuning...")
        hf_top1, hf_total = run_hf_baseline(cache, labels, test_ids)
    else:
        print(f"\nHF baseline cache found at {HF_BASELINE_CACHE} — loading for comparison")
        hf_baseline_cache = json.load(open(HF_BASELINE_CACHE))
        hf_top1, hf_total = evaluate_ceiling(hf_baseline_cache, labels, test_ids, label="HF base model")

    hf_pct = hf_top1 / hf_total * 100

    if not EMBED_ONLY:
        # Build training data
        print("\nBuilding training pairs...")
        examples = build_training_data(cache, labels, test_ids)

        # Train
        model = train_model(examples)
    else:
        print(f"\nLoading fine-tuned model from {MODEL_OUT}")
        model = SentenceTransformer(str(MODEL_OUT), trust_remote_code=True)

    if not TRAIN_ONLY:
        # Re-embed all items
        new_cache = embed_all_items(model, cache)

        # Save
        print(f"\nSaving fine-tuned cache to {FINETUNED_CACHE}")
        json.dump(new_cache, open(FINETUNED_CACHE, "w"))
        print(f"  {len(new_cache)} items saved")

        # Evaluate fine-tuned
        ft_top1, ft_total = evaluate_ceiling(new_cache, labels, test_ids, label="fine-tuned")
        ft_pct = ft_top1 / ft_total * 100

        # 3-way comparison
        print("\n" + "=" * 60)
        print("3-WAY COMPARISON")
        print("=" * 60)
        print(f"  Ollama baseline  (nomic via local API): {ollama_top1}/{ollama_total} ({ollama_pct:.0f}%)")
        print(f"  HF base model    (nomic-embed-text-v1.5 HF): {hf_top1}/{hf_total} ({hf_pct:.0f}%)")
        print(f"  HF fine-tuned    (after contrastive training): {ft_top1}/{ft_total} ({ft_pct:.0f}%)")
        gain = ft_pct - hf_pct
        direction = "+" if gain >= 0 else ""
        print(f"  Fine-tune gain vs HF base: {direction}{gain:.1f}pp")
        print("=" * 60)
    else:
        print("\n  --train-only: skipping re-embedding")


if __name__ == "__main__":
    main()
