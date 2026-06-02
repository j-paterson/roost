#!/usr/bin/env python3
"""Phase F v2: Fine-tune nomic-embed-text with explicitly mined hard negatives.

Differences from scripts/finetune-embeddings.py:
  1. Uses 5-field production text (vision + summary + category + title + subtitle)
     via vault frontmatter — matches what describe-items.ts actually embeds.
  2. Mines hard negatives explicitly: for each anchor, the nearest labeled item
     in a DIFFERENT collection (by current cached embedding similarity).
  3. Uses MultipleNegativesRankingLoss with explicit hard-neg column — 2 samples
     per example (vs TripletLoss's 3), better at scale. v1 used TripletLoss and
     regressed -35pp.
  4. max_seq_length = 512 — covers 97.2% of items losslessly. v1 used 256
     (82.5% coverage) to dodge OOM; that truncation likely caused the collapse.
  5. Re-embeds only labeled + test subset (~2.4K items), not the full 18K vault.

Usage:
  <vault>/.roost/venv/bin/python scripts/finetune-hard-neg.py --vault-root <vault>
  # or set ROOST_VAULT env var instead of --vault-root

Flags:
  --vault-root  Vault root directory (or set ROOST_VAULT env). Required.
  --smoke       Run a minimal 32-example, 1-epoch job to verify no OOM before full run.

Outputs:
  <vault>/.roost/nomic-finetuned-hardneg/         — fine-tuned model weights
  <vault>/.roost/embedding-cache-hardneg.json     — re-embedded vectors (labeled+test subset)
"""
import argparse
import json
import os
import random
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

# Safety valve: let MPS allocator go past its conservative default watermark.
# Must be set BEFORE importing torch. We still have ~8GB free system RAM +
# reclaimable pages, so spilling slightly over the default limit is safe.
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

import numpy as np
import torch
from sentence_transformers import InputExample, SentenceTransformer, losses
from torch.utils.data import DataLoader

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


VAULT = _resolve_vault_root()
ROOST = VAULT / ".roost"
CACHE_DIR = ROOST / "cache"
BUILD_DIR = ROOST / "build"
CACHE_PATH = CACHE_DIR / "embedding-cache.json"
VECTORS_BIN_PATH = CACHE_DIR / "embedding-vectors.bin"
VEC_DIM = 768
RESULTS_PATH = BUILD_DIR / "strategy-results.json"
MODEL_OUT = BUILD_DIR / "nomic-finetuned-hardneg"
OUT_CACHE = BUILD_DIR / "embedding-cache-hardneg.json"
BUILD_DIR.mkdir(parents=True, exist_ok=True)

BASE_MODEL = "nomic-ai/nomic-embed-text-v1.5"
MAX_TRIPLETS_PER_COLLECTION = 200
EPOCHS = 2
# batch=4 at seq=384. Initial seq=512 attempts OOM'd at the MPS high-watermark
# limit (the cached allocator grew to ~22GB over a few hundred steps). Dropping
# to seq=384 cuts attention cost by (384/512)² = 56%, and we set
# PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 above to disable the conservative limit.
BATCH_SIZE = 4
# Production text distribution: p50=78, p90=372, p95=467, p99=616 tokens.
# 384 covers 90.8% losslessly — good balance between coverage and memory.
# (256 covered 82.5%, 512 covered 97.2% but OOM'd at batch>=2.)
MAX_SEQ_LENGTH = 384
SEED = 42

random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)


def load_vectors_bin(bin_path, vec_dim=VEC_DIM):
    """Load embedding-vectors.bin (TS plugin format): JSON key array + Float32 payload."""
    if not bin_path.exists():
        return {}
    with open(bin_path, "rb") as f:
        data = f.read()
    nl = data.find(b"\n")
    if nl < 0:
        return {}
    keys = json.loads(data[:nl].decode("utf-8"))
    expected = len(keys) * vec_dim * 4
    payload = data[nl + 1: nl + 1 + expected]
    if len(payload) != expected:
        return {}
    floats = np.frombuffer(payload, dtype=np.float32)
    return {keys[i]: floats[i * vec_dim:(i + 1) * vec_dim] for i in range(len(keys))}


def merge_vectors_from_bin(cache, bin_path):
    """Patch cache entries with vectors from the bin sidecar file."""
    vecs = load_vectors_bin(bin_path)
    if not vecs:
        return 0
    n = 0
    for key, vec in vecs.items():
        if key in cache:
            cache[key]["vec"] = vec.tolist() if hasattr(vec, "tolist") else list(vec)
            n += 1
    return n


def parse_frontmatter(content):
    """Return dict of simple frontmatter fields, handling multi-line quoted values."""
    if not content.startswith("---\n"):
        return {}
    end = content.find("\n---", 4)
    if end < 0:
        return {}
    fm_text = content[4:end]

    fields = {}
    lines = fm_text.split("\n")
    i = 0
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
    """Scan vault Bookmarks dir; return {roost_id: {title, subtitle, collection}}.

    Collection: prefer roost_category over collection (matches sweep semantics).
    """
    data = {}
    for md_file in (VAULT / "Bookmarks").rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        fm = parse_frontmatter(content)
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


def build_embed_text(cache_entry, vault_entry):
    """Reconstruct the 5-field production embed text."""
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault-root", default=None,
                        help="Vault root (required; consumed at module load — listed here so argparse accepts it)")
    parser.add_argument("--smoke", action="store_true",
                        help="Minimal run (32 triplets, 1 epoch) to verify OOM is resolved")
    args = parser.parse_args()

    print("Phase F v2 — hard negatives + MNRL + max_seq=512" + (" [SMOKE]" if args.smoke else ""))
    print("=" * 60)

    print("\nLoading cache + vault data...")
    cache = json.load(open(CACHE_PATH))
    print(f"  {len(cache)} cache entries")
    merged = merge_vectors_from_bin(cache, VECTORS_BIN_PATH)
    print(f"  merged {merged} vectors from {VECTORS_BIN_PATH.name}")
    vault_data = load_vault_data()
    print(f"  {len(vault_data)} vault entries")

    labels = {iid: v["collection"] for iid, v in vault_data.items() if v.get("collection")}
    print(f"  {len(labels)} labeled items across {len(set(labels.values()))} collections")

    test_ids = set(ti["id"] for ti in json.load(open(RESULTS_PATH))["testItems"])
    print(f"  {len(test_ids)} test items (held out of training)")

    # Group labeled items by collection, excluding test items and items without cache vec
    coll_items = defaultdict(list)  # coll -> [(id, text, vec)]
    for iid, coll in labels.items():
        if iid in test_ids:
            continue
        entry = cache.get(iid)
        if not entry or not entry.get("vec"):
            continue
        text = build_embed_text(entry, vault_data.get(iid, {}))
        if len(text) < 10:
            continue
        coll_items[coll].append((iid, text, np.array(entry["vec"])))

    valid_colls = [c for c, items in coll_items.items() if len(items) >= 2]
    total_train_items = sum(len(coll_items[c]) for c in valid_colls)
    print(f"  {len(valid_colls)} collections with ≥2 trainable items")
    print(f"  {total_train_items} total trainable items (test items excluded)")

    # Build global pool for hard negative search. Filter out zero-norm vectors
    # (corrupt cache entries) which would produce NaN sims.
    print("\nBuilding hard-negative search pool...")
    pool = []  # (id, coll, text, vec)
    skipped_zero_norm = 0
    for coll in valid_colls:
        for iid, text, vec in coll_items[coll]:
            if np.linalg.norm(vec) < 1e-6:
                skipped_zero_norm += 1
                continue
            pool.append((iid, coll, text, vec))
    pool_vecs = np.array([v for _, _, _, v in pool])
    pool_norms = pool_vecs / np.linalg.norm(pool_vecs, axis=1, keepdims=True)
    pool_colls = np.array([c for _, c, _, _ in pool])
    pool_texts = [t for _, _, t, _ in pool]
    print(f"  {len(pool)} items in pool (skipped {skipped_zero_norm} zero-norm)")

    # Build triplets
    print("\nMining hard negatives + building triplets...")
    examples = []
    per_coll_counts = {}
    t0 = time.time()
    for coll in valid_colls:
        items = coll_items[coll][:]
        random.shuffle(items)
        count = 0
        same_coll_mask = (pool_colls == coll)

        for anchor_id, anchor_text, anchor_vec in items:
            if count >= MAX_TRIPLETS_PER_COLLECTION:
                break
            if np.linalg.norm(anchor_vec) < 1e-6:
                continue
            others = [it for it in items if it[0] != anchor_id]
            if not others:
                continue
            pos_text = random.choice(others)[1]

            # Hard negative: nearest pool item in a different collection
            a_norm = anchor_vec / np.linalg.norm(anchor_vec)
            sims = pool_norms @ a_norm
            sims_masked = np.where(same_coll_mask, -np.inf, sims)
            best_idx = int(np.argmax(sims_masked))
            neg_text = pool_texts[best_idx]

            examples.append(InputExample(texts=[anchor_text, pos_text, neg_text]))
            count += 1
        per_coll_counts[coll] = count

    print(f"  {len(examples)} triplets built in {time.time()-t0:.1f}s")
    # Show per-collection distribution (top + bottom)
    sorted_counts = sorted(per_coll_counts.items(), key=lambda kv: -kv[1])
    print(f"  Top 5 collections by triplet count: {sorted_counts[:5]}")
    print(f"  Bottom 5: {sorted_counts[-5:]}")
    random.shuffle(examples)

    # Smoke mode: 500 examples × 1 epoch = 250 steps at batch=2. This exceeds
    # the step 201 crash point from Phase F v2 attempt #1, so progressive
    # memory buildup will surface here if it's going to.
    if args.smoke:
        examples = examples[:500]
        smoke_epochs = 1
        print(f"\n  SMOKE MODE: using first {len(examples)} triplets, {smoke_epochs} epoch")
    else:
        smoke_epochs = None

    # Train
    print(f"\nLoading base model: {BASE_MODEL}")
    model = SentenceTransformer(BASE_MODEL, trust_remote_code=True)
    # 512 covers 97.2% of items losslessly (vs 82.5% at 256). v1 used 256 and regressed.
    model.max_seq_length = MAX_SEQ_LENGTH
    print(f"  max_seq_length: {model.max_seq_length}")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"  Device: {device}")
    model = model.to(device)

    train_loader = DataLoader(examples, shuffle=True, batch_size=BATCH_SIZE)
    # MNRL with explicit hard negatives: each InputExample(texts=[anchor, pos, hard_neg])
    # contributes (anchor, pos) + hard_neg as an extra in-batch negative. 2 samples
    # per example forwarded (vs TripletLoss's 3), so ~33% more sequence room.
    train_loss = losses.MultipleNegativesRankingLoss(model=model)
    epochs = smoke_epochs if smoke_epochs else EPOCHS
    warmup = max(1, int(len(train_loader) * epochs * 0.1))
    print(f"  Training: {len(examples)} triplets, {epochs} epochs, batch={BATCH_SIZE}, warmup={warmup}")
    print(f"  Loss: MultipleNegativesRankingLoss (2 samples per example)")
    print(f"  AMP: disabled (MPS has no fp16 autocast support)")
    print(f"  PYTORCH_MPS_HIGH_WATERMARK_RATIO={os.environ.get('PYTORCH_MPS_HIGH_WATERMARK_RATIO')}")

    t0 = time.time()
    model.fit(
        train_objectives=[(train_loader, train_loss)],
        epochs=epochs,
        warmup_steps=warmup,
        output_path=str(MODEL_OUT),
        show_progress_bar=True,
    )
    print(f"  Training done in {time.time()-t0:.1f}s")

    if args.smoke:
        print("\n  SMOKE MODE complete — no OOM. Exiting before re-embed/eval.")
        print(f"  Peak MPS (if tracked): see Activity Monitor / powermetrics")
        sys.exit(0)

    # Re-embed labeled + test subset
    print("\nRe-embedding labeled + test subset...")
    embed_ids = set(labels.keys()) | test_ids
    valid = []
    for iid in embed_ids:
        entry = cache.get(iid)
        if not entry or not entry.get("vec"):
            continue
        text = build_embed_text(entry, vault_data.get(iid, {}))
        if len(text) >= 10:
            valid.append((iid, text))
    print(f"  {len(valid)} items to embed")

    ids_to_embed = [iid for iid, _ in valid]
    texts_to_embed = [t for _, t in valid]

    t0 = time.time()
    vecs = model.encode(
        texts_to_embed,
        batch_size=32,
        show_progress_bar=True,
        normalize_embeddings=True,
    )
    print(f"  Embedded in {time.time()-t0:.1f}s")

    new_cache = {}
    for i, iid in enumerate(ids_to_embed):
        orig = cache[iid]
        new_cache[iid] = {
            "vision": orig.get("vision"),
            "summary": orig.get("summary"),
            "category": orig.get("category"),
            "vec": vecs[i].tolist(),
        }
    json.dump(new_cache, open(OUT_CACHE, "w"))
    print(f"  Saved {len(new_cache)} items to {OUT_CACHE}")

    # Evaluate (sweep-matching centroid semantics: include ALL labeled items, LOO for GT)
    print("\nEvaluating...")
    members = defaultdict(list)
    for iid, coll in labels.items():
        if iid in new_cache:
            members[coll].append((iid, np.array(new_cache[iid]["vec"])))
    centroids = {c: np.mean([v for _, v in ms], axis=0) for c, ms in members.items() if ms}

    positive = [ti for ti in json.load(open(RESULTS_PATH))["testItems"] if not ti["isNegative"]]
    top1 = 0
    top3 = 0
    top7 = 0
    evaluated = 0
    for ti in positive:
        iid = ti["id"]
        gt = ti["groundTruth"]
        if iid not in new_cache:
            continue
        evaluated += 1
        vec = np.array(new_cache[iid]["vec"])
        sims = []
        for coll, centroid in centroids.items():
            if coll == gt and len(members[coll]) > 1:
                n = len(members[coll])
                if any(mid == iid for mid, _ in members[coll]):
                    use = (centroid * n - vec) / (n - 1)
                else:
                    use = centroid
            else:
                use = centroid
            num = float(np.dot(vec, use))
            den = np.linalg.norm(vec) * np.linalg.norm(use)
            sims.append((coll, num / (den + 1e-8)))
        sims.sort(key=lambda x: -x[1])
        if sims[0][0] == gt:
            top1 += 1
        if any(c == gt for c, _ in sims[:3]):
            top3 += 1
        if any(c == gt for c, _ in sims[:7]):
            top7 += 1

    N = len(positive)
    print(f"\n{'='*60}")
    print(f"PHASE F RESULTS — Fine-tune with mined hard negatives")
    print(f"{'='*60}")
    print(f"  Evaluated:                {evaluated}/{N} positive items")
    print(f"  Baseline (cached nomic):  70/119 (58.8%) top-1")
    print(f"  Fine-tuned hard-neg:      {top1}/{N} ({top1/N*100:.1f}%) top-1")
    print(f"                            {top3}/{N} ({top3/N*100:.1f}%) top-3")
    print(f"                            {top7}/{N} ({top7/N*100:.1f}%) top-7")
    delta = top1 / N * 100 - 58.8
    marker = " ← BEATS baseline" if delta > 0 else " ← regressed vs baseline"
    print(f"  Delta vs baseline:        {'+' if delta>=0 else ''}{delta:.1f}pp{marker}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
