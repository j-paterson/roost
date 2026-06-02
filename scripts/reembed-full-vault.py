#!/usr/bin/env python3
"""Phase 1: Re-embed the entire vault with the fine-tuned hardneg model.

Reads embedding-cache.json (the full ~18K vault), reconstructs the 5-field
production embed text using the same logic finetune-hard-neg.py uses, and
writes a new full-vault cache whose vectors come from .roost/nomic-finetuned-hardneg.

The existing embedding-cache-hardneg.json only covers the labeled+test subset
(~2.3K items) produced during training. This script extends that to every
cache entry so the deployed plugin can use v2 vectors at runtime.

Outputs:
  .roost/embedding-cache-nomic-raw.json   — backup of current cache (first run only)
  .roost/embedding-cache.json             — rewritten in place with v2 vectors

Usage:
  python scripts/reembed-full-vault.py --dry-run    # count + sample preview
  python scripts/reembed-full-vault.py              # full run (~15-30 min on MPS)
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

# Reuse parse_frontmatter / load_vault_data / build_embed_text so the text
# reconstruction is bit-identical to the training/eval pipeline.
sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module
_fhn = import_module("finetune-hard-neg".replace("-", "_")) if False else None  # noqa
# The module name has hyphens, so import via runpy-style exec. Cheap and
# keeps the logic in exactly one place.
import runpy
_ns = runpy.run_path(str(Path(__file__).parent / "finetune-hard-neg.py"),
                     run_name="__reembed_import__")
parse_frontmatter = _ns["parse_frontmatter"]
load_vault_data = _ns["load_vault_data"]
build_embed_text = _ns["build_embed_text"]

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
CACHE_PATH = ROOST / "embedding-cache.json"
BACKUP_PATH = ROOST / "embedding-cache-nomic-raw.json"
MODEL_PATH = ROOST / "nomic-finetuned-hardneg"
MAX_SEQ_LENGTH = 384  # match training


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="Count items, show 3 sample embed texts, do not write")
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--model-path", default=str(MODEL_PATH))
    args = ap.parse_args()

    print("Phase 1 — re-embed full vault with hardneg v2 model")
    print("=" * 60)

    print(f"\nLoading cache: {CACHE_PATH}")
    cache = json.load(open(CACHE_PATH))
    print(f"  {len(cache)} entries")

    print("Scanning vault frontmatter...")
    vault_data = load_vault_data()
    print(f"  {len(vault_data)} vault entries")

    # Build (id, text) for every cache entry with a non-empty text. We re-embed
    # EVERY cached item so the new cache is a drop-in replacement — including
    # entries whose vault file has gone missing (use empty title/subtitle).
    to_embed = []  # (id, text)
    skipped_empty = 0
    skipped_nondict = 0
    missing_vault = 0
    for iid, entry in cache.items():
        if not isinstance(entry, dict):
            skipped_nondict += 1
            continue
        v = vault_data.get(iid)
        if v is None:
            missing_vault += 1
            v = {"title": "", "subtitle": "", "collection": None}
        text = build_embed_text(entry, v)
        if len(text) < 10:
            skipped_empty += 1
            continue
        to_embed.append((iid, text))

    print(f"  {len(to_embed)} embeddable items")
    print(f"  {missing_vault} cache entries without a matching vault file (embedded using cache fields only)")
    print(f"  {skipped_empty} skipped (text <10 chars)")
    print(f"  {skipped_nondict} skipped (non-dict cache entries)")

    if args.dry_run:
        print("\nDry run — 3 sample embed texts:")
        for iid, text in to_embed[:3]:
            preview = text[:300].replace("\n", " ")
            print(f"\n  [{iid}]")
            print(f"    {preview}{'...' if len(text) > 300 else ''}")
        print(f"\nWould embed {len(to_embed)} items using {args.model_path}")
        print("Re-run without --dry-run to write.")
        return

    # Backup current cache before we clobber it — only if we haven't already.
    if not BACKUP_PATH.exists():
        print(f"\nBacking up current cache to {BACKUP_PATH}")
        shutil.copy2(CACHE_PATH, BACKUP_PATH)
    else:
        print(f"\nBackup already exists at {BACKUP_PATH} — not overwriting")

    print(f"\nLoading fine-tuned model: {args.model_path}")
    from sentence_transformers import SentenceTransformer
    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    t0 = time.time()
    model = SentenceTransformer(args.model_path, trust_remote_code=True)
    model.max_seq_length = MAX_SEQ_LENGTH
    model = model.to(device)
    print(f"  loaded in {time.time()-t0:.1f}s; device={device} max_seq={MAX_SEQ_LENGTH}")

    ids = [iid for iid, _ in to_embed]
    texts = [t for _, t in to_embed]

    print(f"\nEncoding {len(texts)} items (batch_size={args.batch_size})...")
    t0 = time.time()
    vecs = model.encode(
        texts,
        batch_size=args.batch_size,
        show_progress_bar=True,
        normalize_embeddings=True,
    )
    elapsed = time.time() - t0
    print(f"  encoded in {elapsed:.1f}s ({elapsed/len(texts)*1000:.1f}ms/item)")

    # Build new cache: copy every old entry, overwrite vec for items we embedded.
    # Items that didn't meet the >=10-char threshold keep their old vec; that
    # preserves behaviour for edge cases and avoids breaking the plugin loader.
    print("\nMerging new vectors into cache...")
    new_cache = {}
    vec_by_id = {iid: vec for iid, vec in zip(ids, vecs)}
    updated = 0
    preserved = 0
    for iid, entry in cache.items():
        if not isinstance(entry, dict):
            new_cache[iid] = entry
            continue
        new_entry = dict(entry)
        if iid in vec_by_id:
            new_entry["vec"] = vec_by_id[iid].tolist()
            updated += 1
        else:
            preserved += 1
        new_cache[iid] = new_entry
    print(f"  {updated} entries got new v2 vectors")
    print(f"  {preserved} entries preserved as-is (text too short to embed)")

    tmp_path = CACHE_PATH.with_suffix(".json.tmp")
    print(f"\nWriting to {tmp_path} then atomic rename → {CACHE_PATH}")
    json.dump(new_cache, open(tmp_path, "w"))
    os.replace(tmp_path, CACHE_PATH)
    print(f"  wrote {len(new_cache)} entries")

    print("\n" + "=" * 60)
    print("Phase 1 re-embed complete.")
    print(f"  Backup:        {BACKUP_PATH}")
    print(f"  New cache:     {CACHE_PATH} ({updated} vectors replaced)")
    print("=" * 60)


if __name__ == "__main__":
    main()
