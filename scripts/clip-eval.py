#!/usr/bin/env python3
"""CLIP visual embedding evaluation on the 119-item test set.

Encodes cover.jpg/thumb.png thumbnails with SigLIP, builds LOO centroids
from labeled items, and reports top-1/3/5/7 accuracy — comparing directly
against the fine-tuned nomic text embeddings on the same items.

Also tests late-fusion (averaged cosine similarities from both spaces).

Usage:
  python scripts/clip-eval.py
  python scripts/clip-eval.py --model google/siglip-so400m-patch14-384
  python scripts/clip-eval.py --batch-size 16
"""
import argparse
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional

import struct

import numpy as np
import torch
from PIL import Image
from transformers import SiglipVisionModel, SiglipImageProcessor

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
BOOKMARKS = VAULT / "Bookmarks"
CACHE_PATH = ROOST / "embedding-cache.json"
RESULTS_PATH = ROOST / "strategy-results.json"
OUT_PATH = ROOST / "clip-eval-results.json"

DEFAULT_MODEL = "google/siglip-base-patch16-224"
TEXT_VEC_DIM = 768


def load_vectors_bin(bin_path: Path) -> Dict[str, np.ndarray]:
    """Load vectors from the binary format: JSON key array on first line, then raw Float32."""
    data = bin_path.read_bytes()
    nl = data.index(b"\n")
    keys = json.loads(data[:nl].decode("utf-8"))
    float_data = np.frombuffer(data[nl + 1:], dtype=np.float32)
    expected = len(keys) * TEXT_VEC_DIM
    if len(float_data) < expected:
        raise ValueError(f"Binary file too short: {len(float_data)} < {expected}")
    float_data = float_data[:expected].reshape(len(keys), TEXT_VEC_DIM)
    return {k: float_data[i] for i, k in enumerate(keys)}


def load_labels():
    """Load roost_id → collection from vault frontmatter (same as sweep scripts)."""
    labels = {}
    for md in BOOKMARKS.rglob("*.md"):
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
        cat_match = re.search(r'^roost_category:\s*(.+)', fm, re.MULTILINE)
        coll_match = re.search(r'^collection:\s*(.+)', fm, re.MULTILINE)
        cat = cat_match.group(1) if cat_match else (coll_match.group(1) if coll_match else None)
        if not cat:
            continue
        cat = cat.strip().strip('"')
        if cat and cat not in ("undefined", "null"):
            labels[rid] = cat
    return labels


def find_image(roost_id: str) -> Optional[Path]:
    """Resolve roost_id to a cover image path."""
    # tiktok:7125803175197691178 → Bookmarks/TikTok/tiktok-7125803175197691178/
    # twitter:1234567890 → Bookmarks/Twitter/twitter-1234567890/
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


def l2_normalize(X):
    n = np.linalg.norm(X, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return X / n


def encode_images(model, processor, image_paths: List[Path], batch_size: int,
                  device: str) -> np.ndarray:
    """Encode a list of image paths into vectors via SiglipVisionModel."""
    all_vecs = []
    for i in range(0, len(image_paths), batch_size):
        batch_paths = image_paths[i:i + batch_size]
        images = []
        for p in batch_paths:
            img = Image.open(p).convert("RGB")
            images.append(img)
        inputs = processor(images=images, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = model(**inputs)
        vecs = outputs.pooler_output.cpu().numpy().astype(np.float32)
        all_vecs.append(vecs)
        if (i // batch_size + 1) % 10 == 0:
            print(f"  encoded {i + len(batch_paths)}/{len(image_paths)} images")
    return np.concatenate(all_vecs, axis=0)


def centroid_topk(X_pool, y_pool, X_query, classes):
    """Build centroids from pool, return (sims, present_classes) for queries."""
    by_class = defaultdict(list)
    for x, y in zip(X_pool, y_pool):
        by_class[y].append(x)
    present = [c for c in classes if by_class[c]]
    centroids = np.stack([
        np.mean(by_class[c], axis=0) / max(np.linalg.norm(np.mean(by_class[c], axis=0)), 1e-8)
        for c in present
    ])
    sims = X_query @ centroids.T
    return sims, present


def eval_topk(sims, present, y_test, topk_list=(1, 3, 5, 7)):
    """Given similarity matrix and class list, compute top-k hits."""
    N = len(y_test)
    idx_sorted = np.argsort(-sims, axis=1)
    hits = {}
    for k in topk_list:
        h = sum(1 for i in range(N)
                if y_test[i] in [present[j] for j in idx_sorted[i, :k]])
        hits[k] = h
    preds = [present[int(idx_sorted[i, 0])] for i in range(N)]
    return hits, preds


def main():
    parser = argparse.ArgumentParser(description="CLIP visual embedding eval")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"HuggingFace model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    args = parser.parse_args()

    print("CLIP Visual Embedding Evaluation")
    print("=" * 70)
    print(f"Model:   {args.model}")
    print(f"Device:  {args.device}")
    print(f"Batch:   {args.batch_size}")
    print()

    # ── Load data ──
    t0 = time.time()
    text_cache = json.load(open(CACHE_PATH))
    results_json = json.load(open(RESULTS_PATH))
    labels = load_labels()

    # Merge binary vectors into text cache (JSON has vec: null)
    bin_path = ROOST / "embedding-vectors.bin"
    if bin_path.exists():
        vec_map = load_vectors_bin(bin_path)
        merged = 0
        for k, v in vec_map.items():
            if k in text_cache:
                text_cache[k]["vec"] = v
                merged += 1
        print(f"Merged {merged} vectors from binary file")

    print(f"Loaded cache ({len(text_cache)} items), labels ({len(labels)} items) "
          f"in {time.time() - t0:.1f}s")

    positive = [ti for ti in results_json["testItems"] if not ti["isNegative"]]
    test_ids = [ti["id"] for ti in positive]
    test_gts = {ti["id"]: ti["groundTruth"] for ti in positive}
    test_id_set = set(test_ids)

    # ── Find images for all labeled items ──
    print("\nScanning for cover images...")
    all_ids = set(labels.keys()) | test_id_set
    image_map: Dict[str, Path] = {}
    missing_image = []
    for rid in all_ids:
        p = find_image(rid)
        if p:
            image_map[rid] = p
        else:
            missing_image.append(rid)

    test_with_image = [tid for tid in test_ids if tid in image_map]
    test_without_image = [tid for tid in test_ids if tid not in image_map]
    labeled_with_image = {rid: labels[rid] for rid in labels if rid in image_map}

    print(f"  Total items scanned: {len(all_ids)}")
    print(f"  Items with images:   {len(image_map)} ({len(image_map)/len(all_ids)*100:.0f}%)")
    print(f"  Test items:          {len(test_with_image)}/{len(test_ids)} have images")
    if test_without_image:
        platforms = Counter(tid.split(":")[0] for tid in test_without_image)
        print(f"  Test items missing:  {dict(platforms)}")

    if len(test_with_image) < 10:
        print("\nERROR: Too few test items have cover images. Cannot evaluate.")
        return

    # ── Load CLIP model ──
    print(f"\nLoading {args.model} (vision-only)...")
    t_load = time.time()
    processor = SiglipImageProcessor.from_pretrained(args.model)
    model = SiglipVisionModel.from_pretrained(args.model).to(args.device).eval()
    print(f"  Loaded in {time.time() - t_load:.1f}s")

    # Quick dimension check
    test_img = Image.open(image_map[test_with_image[0]]).convert("RGB")
    test_input = processor(images=[test_img], return_tensors="pt")
    test_input = {k: v.to(args.device) for k, v in test_input.items()}
    with torch.no_grad():
        test_out = model(**test_input)
    vec_dim = test_out.pooler_output.shape[1]
    print(f"  Vector dimension: {vec_dim}")

    # ── Encode all images ──
    # Build ordered lists: all labeled items with images + test items with images
    encode_ids = sorted(set(list(labeled_with_image.keys()) + test_with_image))
    encode_paths = [image_map[rid] for rid in encode_ids]

    print(f"\nEncoding {len(encode_ids)} images...")
    t_encode = time.time()
    raw_vecs = encode_images(model, processor, encode_paths, args.batch_size, args.device)
    encode_time = time.time() - t_encode
    print(f"  Encoded in {encode_time:.1f}s ({encode_time/len(encode_ids)*1000:.1f}ms/image)")

    # Build id → vector map
    clip_cache = {}
    for rid, vec in zip(encode_ids, raw_vecs):
        clip_cache[rid] = vec

    # Normalize all vectors
    X_clip_all = l2_normalize(raw_vecs)
    clip_normed = {rid: X_clip_all[i] for i, rid in enumerate(encode_ids)}

    # ── Build training and test matrices ──
    # Training pool: all labeled items with images, excluding test items
    train_ids = []
    X_train_clip = []
    y_train = []
    for rid, coll in labeled_with_image.items():
        if rid in test_id_set:
            continue
        train_ids.append(rid)
        X_train_clip.append(clip_normed[rid])
        y_train.append(coll)

    # Full pool (for LOO): all labeled items with images (including test items)
    pool_ids = []
    X_pool_clip = []
    y_pool = []
    for rid, coll in labeled_with_image.items():
        pool_ids.append(rid)
        X_pool_clip.append(clip_normed[rid])
        y_pool.append(coll)

    X_train_clip = np.array(X_train_clip)
    y_train = np.array(y_train)
    X_pool_clip = np.array(X_pool_clip)
    y_pool = np.array(y_pool)

    # Test matrix (only items with images)
    X_test_clip = np.array([clip_normed[tid] for tid in test_with_image])
    y_test = np.array([test_gts[tid] for tid in test_with_image])
    N = len(test_with_image)

    classes = sorted(set(y_pool.tolist()) | set(y_test.tolist()))
    print(f"\nClasses: {len(classes)}")
    print(f"Training pool: {len(train_ids)} (strict holdout)")
    print(f"Full pool: {len(pool_ids)} (for LOO)")
    print(f"Test items: {N}")

    all_results = {"model": args.model, "vec_dim": vec_dim,
                   "test_count": N, "test_total": len(test_ids),
                   "encode_time_s": encode_time,
                   "ms_per_image": encode_time / len(encode_ids) * 1000}

    # ── CLIP: Centroid cosine (strict holdout) ──
    print(f"\n{'='*70}")
    print("CLIP VISUAL EMBEDDINGS")
    print(f"{'='*70}")

    print("\n[1] CLIP centroid cosine (strict holdout)")
    sims, present = centroid_topk(X_train_clip, y_train, X_test_clip, classes)
    hits, preds = eval_topk(sims, present, y_test)
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {hits[k]}/{N} ({hits[k]/N*100:.1f}%)")
    all_results["clip_centroid_strict"] = {
        f"top{k}": hits[k] for k in (1, 3, 5, 7)
    }

    # ── CLIP: Centroid cosine with LOO ──
    print("\n[2] CLIP centroid cosine (LOO)")
    hits_loo = {1: 0, 3: 0, 5: 0, 7: 0}
    preds_loo = []
    for i, tid in enumerate(test_with_image):
        mask = np.array([pid != tid for pid in pool_ids])
        sims_i, cls_i = centroid_topk(X_pool_clip[mask], y_pool[mask],
                                       X_test_clip[i:i+1], classes)
        row_idx = np.argsort(-sims_i[0])
        preds_loo.append(cls_i[int(row_idx[0])])
        for k in (1, 3, 5, 7):
            if y_test[i] in [cls_i[j] for j in row_idx[:k]]:
                hits_loo[k] += 1
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {hits_loo[k]}/{N} ({hits_loo[k]/N*100:.1f}%)")
    all_results["clip_centroid_loo"] = {f"top{k}": hits_loo[k] for k in (1, 3, 5, 7)}

    # ── Text embeddings baseline (same items, from existing cache) ──
    print(f"\n{'='*70}")
    print("TEXT EMBEDDINGS (fine-tuned nomic, same items)")
    print(f"{'='*70}")

    # Only evaluate on test items that have BOTH an image AND a text embedding
    test_both = [tid for tid in test_with_image
                 if text_cache.get(tid, {}).get("vec") is not None]
    if len(test_both) < len(test_with_image):
        print(f"  Note: {len(test_with_image) - len(test_both)} test items have "
              f"image but no text vec — comparing on {len(test_both)} items")

    # Build text training pool (same labeled items that have images AND text vecs)
    text_train_ids = []
    X_train_text = []
    y_train_text = []
    text_pool_ids = []
    X_pool_text = []
    y_pool_text = []
    for rid, coll in labeled_with_image.items():
        entry = text_cache.get(rid, {})
        if entry.get("vec") is None:
            continue
        v = np.asarray(entry["vec"], dtype=np.float32)
        if not np.all(np.isfinite(v)) or float(np.linalg.norm(v)) == 0.0:
            continue
        text_pool_ids.append(rid)
        X_pool_text.append(v)
        y_pool_text.append(coll)
        if rid not in test_id_set:
            text_train_ids.append(rid)
            X_train_text.append(v)
            y_train_text.append(coll)

    if not X_train_text:
        print("\n  ERROR: No labeled items with both images and text vectors.")
        print("  Cannot compare text embeddings.")
        json.dump(all_results, open(OUT_PATH, "w"), default=str, indent=2)
        print(f"\nSaved partial results to {OUT_PATH}")
        return
    X_train_text = l2_normalize(np.array(X_train_text))
    y_train_text = np.array(y_train_text)
    X_pool_text = l2_normalize(np.array(X_pool_text))
    y_pool_text = np.array(y_pool_text)

    X_test_text = []
    y_test_text = []
    test_both_final = []
    for tid in test_both:
        v = np.asarray(text_cache[tid]["vec"], dtype=np.float32)
        if np.all(np.isfinite(v)) and float(np.linalg.norm(v)) > 0:
            X_test_text.append(v)
            y_test_text.append(test_gts[tid])
            test_both_final.append(tid)
    X_test_text = l2_normalize(np.array(X_test_text))
    y_test_text = np.array(y_test_text)
    N_both = len(test_both_final)

    print(f"\n[3] Text centroid cosine (strict holdout, {N_both} items)")
    sims_t, present_t = centroid_topk(X_train_text, y_train_text, X_test_text, classes)
    hits_t, _ = eval_topk(sims_t, present_t, y_test_text)
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {hits_t[k]}/{N_both} ({hits_t[k]/N_both*100:.1f}%)")
    all_results["text_centroid_strict"] = {f"top{k}": hits_t[k] for k in (1, 3, 5, 7)}

    print(f"\n[4] Text centroid cosine (LOO, {N_both} items)")
    hits_text_loo = {1: 0, 3: 0, 5: 0, 7: 0}
    for i, tid in enumerate(test_both_final):
        mask = np.array([pid != tid for pid in text_pool_ids])
        sims_i, cls_i = centroid_topk(X_pool_text[mask], y_pool_text[mask],
                                       X_test_text[i:i+1], classes)
        row_idx = np.argsort(-sims_i[0])
        for k in (1, 3, 5, 7):
            if y_test_text[i] in [cls_i[j] for j in row_idx[:k]]:
                hits_text_loo[k] += 1
    for k in (1, 3, 5, 7):
        print(f"  top-{k}: {hits_text_loo[k]}/{N_both} ({hits_text_loo[k]/N_both*100:.1f}%)")
    all_results["text_centroid_loo"] = {f"top{k}": hits_text_loo[k] for k in (1, 3, 5, 7)}

    # ── Late fusion: average cosine similarities from both spaces ──
    print(f"\n{'='*70}")
    print("LATE FUSION (averaged cosine similarities)")
    print(f"{'='*70}")

    # Only items in test_both_final (have both image and text vecs)
    # Re-compute CLIP sims on this subset for apples-to-apples fusion
    X_test_clip_both = np.array([clip_normed[tid] for tid in test_both_final])

    for alpha in (0.3, 0.5, 0.7):
        print(f"\n[fusion α={alpha:.1f}] (clip={alpha:.0%} + text={1-alpha:.0%})")
        hits_fusion_loo = {1: 0, 3: 0, 5: 0, 7: 0}
        for i, tid in enumerate(test_both_final):
            # CLIP LOO centroids
            clip_mask = np.array([pid != tid for pid in pool_ids])
            clip_sims_i, clip_cls_i = centroid_topk(
                X_pool_clip[clip_mask], y_pool[clip_mask],
                X_test_clip_both[i:i+1], classes)

            # Text LOO centroids
            text_mask = np.array([pid != tid for pid in text_pool_ids])
            text_sims_i, text_cls_i = centroid_topk(
                X_pool_text[text_mask], y_pool_text[text_mask],
                X_test_text[i:i+1], classes)

            # Merge: for each class present in both, average sims
            clip_sim_map = {c: clip_sims_i[0, j] for j, c in enumerate(clip_cls_i)}
            text_sim_map = {c: text_sims_i[0, j] for j, c in enumerate(text_cls_i)}
            all_cls = sorted(set(clip_sim_map.keys()) | set(text_sim_map.keys()))
            fused = []
            for c in all_cls:
                cs = clip_sim_map.get(c, 0.0)
                ts = text_sim_map.get(c, 0.0)
                fused.append(alpha * cs + (1 - alpha) * ts)
            fused = np.array(fused)
            order = np.argsort(-fused)
            for k in (1, 3, 5, 7):
                if y_test_text[i] in [all_cls[j] for j in order[:k]]:
                    hits_fusion_loo[k] += 1

        for k in (1, 3, 5, 7):
            print(f"  top-{k}: {hits_fusion_loo[k]}/{N_both} ({hits_fusion_loo[k]/N_both*100:.1f}%)")
        all_results[f"fusion_a{alpha:.1f}_loo"] = {
            f"top{k}": hits_fusion_loo[k] for k in (1, 3, 5, 7)
        }

    # ── Per-item comparison: which items does CLIP get right that text misses? ──
    print(f"\n{'='*70}")
    print("PER-ITEM COMPARISON (LOO, items with both embeddings)")
    print(f"{'='*70}")

    # Recompute per-item CLIP LOO predictions on the shared subset
    clip_preds_both = []
    for i, tid in enumerate(test_both_final):
        mask = np.array([pid != tid for pid in pool_ids])
        sims_i, cls_i = centroid_topk(X_pool_clip[mask], y_pool[mask],
                                       X_test_clip_both[i:i+1], classes)
        row_idx = np.argsort(-sims_i[0])
        clip_preds_both.append(cls_i[int(row_idx[0])])

    text_preds_both = []
    for i, tid in enumerate(test_both_final):
        mask = np.array([pid != tid for pid in text_pool_ids])
        sims_i, cls_i = centroid_topk(X_pool_text[mask], y_pool_text[mask],
                                       X_test_text[i:i+1], classes)
        row_idx = np.argsort(-sims_i[0])
        text_preds_both.append(cls_i[int(row_idx[0])])

    both_ok = only_clip = only_text = neither = 0
    clip_wins = []
    text_wins = []
    for i, tid in enumerate(test_both_final):
        gt = y_test_text[i]
        c_ok = clip_preds_both[i] == gt
        t_ok = text_preds_both[i] == gt
        if c_ok and t_ok:
            both_ok += 1
        elif c_ok:
            only_clip += 1
            clip_wins.append({"id": tid, "gt": gt, "clip": clip_preds_both[i],
                              "text": text_preds_both[i]})
        elif t_ok:
            only_text += 1
            text_wins.append({"id": tid, "gt": gt, "clip": clip_preds_both[i],
                              "text": text_preds_both[i]})
        else:
            neither += 1

    print(f"  Both correct:    {both_ok}")
    print(f"  Only CLIP:       {only_clip}")
    print(f"  Only text:       {only_text}")
    print(f"  Neither:         {neither}")
    print(f"  Union ceiling:   {both_ok + only_clip + only_text}/{N_both} "
          f"({(both_ok + only_clip + only_text)/N_both*100:.1f}%)")

    if clip_wins:
        print(f"\n  CLIP-only wins ({len(clip_wins)}):")
        for w in clip_wins:
            print(f"    {w['id']}: gt={w['gt']}, clip={w['clip']}, text={w['text']}")
    if text_wins:
        print(f"\n  Text-only wins ({len(text_wins)}):")
        for w in text_wins[:10]:
            print(f"    {w['id']}: gt={w['gt']}, clip={w['clip']}, text={w['text']}")
        if len(text_wins) > 10:
            print(f"    ... and {len(text_wins) - 10} more")

    all_results["comparison"] = {
        "both": both_ok, "only_clip": only_clip,
        "only_text": only_text, "neither": neither,
        "union_ceiling": both_ok + only_clip + only_text,
        "clip_wins": clip_wins, "text_wins": text_wins[:20],
    }

    # ── Summary ──
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"  Model: {args.model} ({vec_dim}d)")
    print(f"  Encode speed: {encode_time/len(encode_ids)*1000:.1f}ms/image")
    print(f"  Test items: {N} with images / {len(test_ids)} total")
    print()
    print(f"  {'Method':<45} {'top-1':>10} {'top-3':>10} {'top-5':>10} {'top-7':>10}")
    print(f"  {'-'*45} {'-'*10} {'-'*10} {'-'*10} {'-'*10}")

    def fmt_row(label, res, n):
        parts = [f"  {label:<45}"]
        for k in (1, 3, 5, 7):
            v = res[f"top{k}"]
            parts.append(f"{v:>3}/{n} {v/n*100:>4.1f}%")
        print("  ".join(parts))

    fmt_row("CLIP centroid (strict)", all_results["clip_centroid_strict"], N)
    fmt_row("CLIP centroid (LOO)", all_results["clip_centroid_loo"], N)
    if N_both > 0:
        fmt_row("Text centroid (strict)", all_results["text_centroid_strict"], N_both)
        fmt_row("Text centroid (LOO)", all_results["text_centroid_loo"], N_both)
        for alpha in (0.3, 0.5, 0.7):
            key = f"fusion_a{alpha:.1f}_loo"
            if key in all_results:
                fmt_row(f"Fusion α={alpha:.1f} (LOO)", all_results[key], N_both)

    print(f"\n  LLM ensemble SOTA (deployed):  88/119 (73.9%)")

    json.dump(all_results, open(OUT_PATH, "w"), default=str, indent=2)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == "__main__":
    main()
