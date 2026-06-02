"""
UMAP + HDBSCAN clustering via Python — fast evaluation on full corpus.
Outputs JSON to stdout, progress to stderr.

Usage:
  python test/cluster-python.py [--sample N] [--min-cluster-size N]
"""
import json, sys, time, argparse
from pathlib import Path
from collections import Counter

import numpy as np
import umap
import hdbscan

# ── Args ──
parser = argparse.ArgumentParser()
parser.add_argument("--sample", type=int, default=0, help="Sample size (0 = all)")
parser.add_argument("--min-cluster-size", type=int, default=15)
parser.add_argument("--cache", type=str, default="")
args = parser.parse_args()

def log(msg):
    print(msg, file=sys.stderr, flush=True)

# ── Load cache ──
home = Path.home()
cache_paths = [
    args.cache,
    str(home / "ObsidianBookmarks/.roost/embedding-cache.json"),
    str(home / "Library/Application Support/roost-app/.embedding-cache-tiktok.json"),
]
cache = None
cache_path_used = None
for p in cache_paths:
    if p and Path(p).exists():
        log(f"Loading cache: {p}")
        with open(p) as f:
            cache = json.load(f)
        cache_path_used = p
        break

if not cache:
    log("ERROR: No embedding cache found")
    sys.exit(1)

# Filter to items with vectors
ids = [k for k, v in cache.items() if v and v.get("vec")]
if args.sample > 0:
    ids = ids[:args.sample]

vectors = np.array([cache[id]["vec"] for id in ids], dtype=np.float32)
log(f"{len(ids)} items, {vectors.shape[1]}d vectors")

# ── UMAP to 15d (for clustering) ──
log("UMAP 15d...")
t0 = time.time()
reducer_15d = umap.UMAP(
    n_components=15,
    n_neighbors=15,
    min_dist=0.1,
    metric="cosine",
    verbose=False,
)
reduced_15d = reducer_15d.fit_transform(vectors)
umap_15d_time = time.time() - t0
log(f"  UMAP 15d: {umap_15d_time:.1f}s")

# ── UMAP to 2d (for visualization) ──
log("UMAP 2d...")
t0 = time.time()
reducer_2d = umap.UMAP(
    n_components=2,
    n_neighbors=15,
    min_dist=0.1,
    metric="cosine",
    verbose=False,
)
reduced_2d = reducer_2d.fit_transform(vectors)
umap_2d_time = time.time() - t0
log(f"  UMAP 2d: {umap_2d_time:.1f}s")

# ── HDBSCAN at primary minClusterSize ──
log(f"HDBSCAN (minClusterSize={args.min_cluster_size})...")

# Try both selection methods — 'leaf' extracts fine-grained clusters,
# 'eom' (default) prefers larger clusters
for method in ['leaf', 'eom']:
    t0 = time.time()
    test_clusterer = hdbscan.HDBSCAN(
        min_cluster_size=args.min_cluster_size,
        cluster_selection_method=method,
        metric="euclidean",
        core_dist_n_jobs=-1,
    )
    test_labels = test_clusterer.fit_predict(reduced_15d)
    t_elapsed = time.time() - t0
    n_clusters = len(set(test_labels[test_labels >= 0]))
    n_noise = int(np.sum(test_labels == -1))
    log(f"  method={method}: {n_clusters} clusters, {n_noise} noise ({t_elapsed:.1f}s)")

# Use 'leaf' — it produces the fine-grained clusters we need for categorization
t0 = time.time()
clusterer = hdbscan.HDBSCAN(
    min_cluster_size=args.min_cluster_size,
    cluster_selection_method='leaf',
    metric="euclidean",
    core_dist_n_jobs=-1,
)
labels = clusterer.fit_predict(reduced_15d)
hdbscan_time = time.time() - t0
log(f"  Using leaf method: {hdbscan_time:.1f}s")

cluster_ids = sorted(set(labels[labels >= 0]))
noise_count = int(np.sum(labels == -1))
log(f"  {len(cluster_ids)} clusters, {noise_count} noise")

# ── Per-cluster stats ──
per_cluster = []
for cl in cluster_ids:
    member_mask = labels == cl
    member_ids = [ids[i] for i in range(len(ids)) if member_mask[i]]
    cats = Counter(cache[id].get("category", "(none)") for id in member_ids)
    top_cat, top_count = cats.most_common(1)[0]
    purity = top_count / len(member_ids)

    # Cohesion on original 768d vectors
    member_vecs = vectors[member_mask]
    centroid = member_vecs.mean(axis=0)
    norms_m = np.linalg.norm(member_vecs, axis=1, keepdims=True)
    norm_c = np.linalg.norm(centroid)
    cosines = (member_vecs @ centroid) / (norms_m.flatten() * norm_c + 1e-10)
    cohesion = float(cosines.mean())

    topic_samples = [cache[id].get("topic", "")[:70] for id in member_ids[:5]]

    per_cluster.append({
        "label": int(cl),
        "count": int(member_mask.sum()),
        "purity": round(purity, 3),
        "top_category": top_cat,
        "cohesion": round(cohesion, 4),
        "categories": {k: v for k, v in cats.most_common(5)},
        "topic_samples": topic_samples,
    })

# Noise category distribution
noise_ids = [ids[i] for i in range(len(ids)) if labels[i] == -1]
noise_cats = Counter(cache[id].get("category", "(none)") for id in noise_ids)

# ── Slider comparison: re-run HDBSCAN at different minClusterSize values ──
slider_results = []
for mcs in [5, 10, 15, 20, 30, 40, 60, 80]:
    t0 = time.time()
    sl = hdbscan.HDBSCAN(min_cluster_size=mcs, cluster_selection_method='leaf', metric="euclidean", core_dist_n_jobs=-1)
    sl_labels = sl.fit_predict(reduced_15d)
    sl_time = time.time() - t0
    sl_clusters = sorted(set(sl_labels[sl_labels >= 0]))
    sl_noise = int(np.sum(sl_labels == -1))

    # Average purity
    purities = []
    for cl in sl_clusters:
        mm = sl_labels == cl
        mi = [ids[i] for i in range(len(ids)) if mm[i]]
        cats = Counter(cache[id].get("category", "(none)") for id in mi)
        top_count = cats.most_common(1)[0][1]
        purities.append(top_count / len(mi))

    avg_purity = sum(purities) / len(purities) if purities else 0

    slider_results.append({
        "min_cluster_size": mcs,
        "clusters": len(sl_clusters),
        "noise": sl_noise,
        "avg_purity": round(avg_purity, 3),
        "time_ms": round(sl_time * 1000),
        "labels": sl_labels.tolist(),
    })
    log(f"  mcs={mcs}: {len(sl_clusters)} clusters, {sl_noise} noise, purity {avg_purity:.1%}, {sl_time*1000:.0f}ms")

# ── Output JSON ──
result = {
    "item_count": len(ids),
    "ids": ids,
    "labels": labels.tolist(),
    "reduced_2d": reduced_2d.tolist(),
    "reduced_15d": reduced_15d.tolist(),
    "stats": {
        "clusters": len(cluster_ids),
        "noise": noise_count,
        "min_cluster_size": args.min_cluster_size,
        "umap_15d_time_ms": round(umap_15d_time * 1000),
        "umap_2d_time_ms": round(umap_2d_time * 1000),
        "hdbscan_time_ms": round(hdbscan_time * 1000),
    },
    "per_cluster": per_cluster,
    "noise_categories": {k: v for k, v in noise_cats.most_common(20)},
    "slider_results": slider_results,
}

json.dump(result, sys.stdout)
log("\nDone.")
