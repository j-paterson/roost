"""Honest, contamination-safe Smart Assign eval — shared lib.
GT is ALWAYS human `collection` (non-auto), NEVER roost_category. All eval (fixture)
items must be excluded from every model artifact (centroids AND covariance)."""
import os, json
import numpy as np

SEED = 1729  # fixed; recorded in fixtures

def load_cache(json_path=None, bin_path=None):
    """Return {id: np.ndarray(float32)}. Supports the v2 `embedding-vectors.bin`
    (keys-header + float32 matrix, dim from sibling embedding-meta.json) AND inline
    `{id: {vec: [...]}}` JSON caches (e.g. a fine-tuned cache)."""
    cache = {}
    if bin_path and os.path.exists(bin_path):
        meta_path = os.path.join(os.path.dirname(bin_path), "embedding-meta.json")
        if not os.path.exists(meta_path):
            raise FileNotFoundError(f"embedding-meta.json not found alongside {bin_path}")
        with open(meta_path) as mf:
            dim = int(json.load(mf)["dim"])
        with open(bin_path, "rb") as bf:
            raw = bf.read()
        nl = raw.index(b"\n")
        keys = json.loads(raw[:nl].decode("utf-8"))
        start = nl + 1
        ab = raw[start:start + len(keys) * dim * 4]  # copy → 4-byte aligned
        floats = np.frombuffer(ab, dtype=np.float32).reshape(len(keys), dim)
        for i, k in enumerate(keys):
            cache[k] = floats[i]
    if json_path and os.path.exists(json_path):
        with open(json_path) as jf:
            entries = json.load(jf)
        for k, v in entries.items():
            if isinstance(v, dict) and v.get("vec") is not None:
                cache.setdefault(k, np.asarray(v["vec"], dtype=np.float32))
    return cache
