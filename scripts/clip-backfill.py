#!/usr/bin/env python3
"""Backfill CLIP (SigLIP) visual embeddings for all vault items with cover images.

Encodes cover.jpg/thumb.png thumbnails into 768d vectors and writes them to
.roost/clip-vectors.bin in the same binary format as embedding-vectors.bin:
  line 1: JSON array of roost IDs
  rest:   raw Float32 data (768 floats per ID)

Incremental: skips items already present in clip-vectors.bin.

Usage:
  python scripts/clip-backfill.py
  python scripts/clip-backfill.py --batch-size 64
  python scripts/clip-backfill.py --dry-run        # count how many need encoding
"""
import argparse
import json
import struct
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import torch
from PIL import Image
from transformers import SiglipVisionModel, SiglipImageProcessor

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
BOOKMARKS = VAULT / "Bookmarks"
CACHE_PATH = ROOST / "embedding-cache.json"
CLIP_BIN_PATH = ROOST / "clip-vectors.bin"

DEFAULT_MODEL = "google/siglip-base-patch16-224"
VEC_DIM = 768


def load_existing_clip_vectors() -> Dict[str, np.ndarray]:
    """Load existing clip-vectors.bin if present."""
    if not CLIP_BIN_PATH.exists():
        return {}
    try:
        data = CLIP_BIN_PATH.read_bytes()
        nl = data.index(b"\n")
        keys = json.loads(data[:nl].decode("utf-8"))
        float_data = np.frombuffer(data[nl + 1:], dtype=np.float32)
        expected = len(keys) * VEC_DIM
        if len(float_data) < expected:
            print(f"Warning: clip-vectors.bin truncated ({len(float_data)} < {expected})")
            return {}
        float_data = float_data[:expected].reshape(len(keys), VEC_DIM)
        return {k: float_data[i] for i, k in enumerate(keys)}
    except Exception as e:
        print(f"Warning: could not load clip-vectors.bin: {e}")
        return {}


def find_image(roost_id: str) -> Optional[Path]:
    """Resolve roost_id to a cover image path."""
    parts = roost_id.split(":", 1)
    if len(parts) != 2:
        return None
    platform, numeric_id = parts
    if platform == "tiktok":
        folder = BOOKMARKS / "TikTok" / f"tiktok-{numeric_id}"
    elif platform == "twitter":
        folder = BOOKMARKS / "Twitter" / f"twitter-{numeric_id}"
    else:
        return None
    for name in ("cover.jpg", "thumb.png", "cover.png", "thumb.jpg"):
        p = folder / name
        if p.exists():
            return p
    return None


def save_clip_vectors(vectors: Dict[str, np.ndarray]) -> None:
    """Write clip-vectors.bin in the standard binary format."""
    keys = sorted(vectors.keys())
    if not keys:
        return
    header = json.dumps(keys).encode("utf-8") + b"\n"
    buf = bytearray(header)
    for k in keys:
        vec = vectors[k]
        buf.extend(struct.pack(f"{VEC_DIM}f", *vec.tolist()))
    CLIP_BIN_PATH.write_bytes(bytes(buf))


def encode_images(model, processor, image_paths: List[Path], batch_size: int,
                  device: str) -> np.ndarray:
    """Encode a list of image paths into vectors via SiglipVisionModel."""
    all_vecs = []
    for i in range(0, len(image_paths), batch_size):
        batch_paths = image_paths[i:i + batch_size]
        images = []
        for p in batch_paths:
            try:
                img = Image.open(p).convert("RGB")
                images.append(img)
            except Exception as e:
                print(f"  Warning: could not open {p}: {e}")
                # Use a blank 224x224 image as placeholder
                images.append(Image.new("RGB", (224, 224)))
        inputs = processor(images=images, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = model(**inputs)
        vecs = outputs.pooler_output.cpu().numpy().astype(np.float32)
        # L2 normalize
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vecs = vecs / norms
        all_vecs.append(vecs)
        done = i + len(batch_paths)
        if (i // batch_size + 1) % 10 == 0 or done == len(image_paths):
            print(f"  encoded {done}/{len(image_paths)} images")
    return np.concatenate(all_vecs, axis=0)


def main():
    parser = argparse.ArgumentParser(description="Backfill CLIP visual embeddings")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="SigLIP model name")
    parser.add_argument("--batch-size", type=int, default=32, help="Batch size")
    parser.add_argument("--dry-run", action="store_true", help="Count items only")
    args = parser.parse_args()

    # Load embedding cache to get all roost IDs
    print("Loading embedding cache...")
    with open(CACHE_PATH) as f:
        cache = json.load(f)
    print(f"  {len(cache)} items in cache")

    # Load existing CLIP vectors
    existing = load_existing_clip_vectors()
    print(f"  {len(existing)} items already have CLIP vectors")

    # Find items that need encoding
    todo = []  # (roost_id, image_path)
    no_image = 0
    for roost_id in cache:
        if roost_id in existing:
            continue
        img = find_image(roost_id)
        if img:
            todo.append((roost_id, img))
        else:
            no_image += 1

    print(f"\n  {len(todo)} items to encode ({no_image} without images, skipped)")

    if args.dry_run or not todo:
        if not todo:
            print("Nothing to do.")
        return

    # Set up device
    if torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    print(f"\nUsing device: {device}")

    # Load model
    print(f"Loading {args.model}...")
    processor = SiglipImageProcessor.from_pretrained(args.model)
    model = SiglipVisionModel.from_pretrained(args.model).to(device).eval()
    print("  Model loaded")

    # Encode in batches
    ids = [t[0] for t in todo]
    paths = [t[1] for t in todo]

    print(f"\nEncoding {len(paths)} images (batch_size={args.batch_size})...")
    t0 = time.time()
    vecs = encode_images(model, processor, paths, args.batch_size, device)
    elapsed = time.time() - t0
    print(f"  Done in {elapsed:.1f}s ({elapsed / len(paths) * 1000:.1f}ms/image)")

    # Merge with existing vectors
    for i, roost_id in enumerate(ids):
        existing[roost_id] = vecs[i]

    # Save
    print(f"\nSaving {len(existing)} vectors to {CLIP_BIN_PATH}...")
    save_clip_vectors(existing)
    size_mb = CLIP_BIN_PATH.stat().st_size / 1024 / 1024
    print(f"  {size_mb:.1f} MB written")
    print("\nDone.")


if __name__ == "__main__":
    main()
