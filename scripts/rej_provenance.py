"""Provenance preflight for the fresh rejection eval. Stamps every input
(path, mtime, size, sha256, item count), verifies the embedding cache is the
current v2 model (cosine >= 0.9999 vs a fresh sidecar re-embed), and reads the
model tags + git SHA. Nothing downstream is trusted unless it appears here."""
import os, json, hashlib, subprocess, re, urllib.request
import numpy as np
import honest_eval_lib as L

def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def _count(path):
    if not path.endswith(".json"):
        return None
    try:
        obj = json.load(open(path))
    except Exception:
        return None
    if isinstance(obj, dict) and "testItems" in obj:
        return len(obj["testItems"])
    if isinstance(obj, dict):
        return len(obj)
    if isinstance(obj, list):
        return len(obj)
    return None

def stamp(path):
    if not os.path.exists(path):
        return {"path": path, "exists": False, "mtime": None, "bytes": None,
                "sha256": None, "count": None}
    st = os.stat(path)
    return {"path": path, "exists": True, "mtime": int(st.st_mtime),
            "bytes": st.st_size, "sha256": _sha256(path), "count": _count(path)}

def _note_text_for_id(vault, rid, sync_folder="Bookmarks"):
    """Reconstruct the 5-field embed text the pipeline embeds. Minimal, cache-free:
    read the note's title+subtitle from frontmatter and the embedding-cache
    summary/vision/category for this id. Mirrors describe-items' field order."""
    import glob
    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    # embedding-cache.json carries the text fields (summary/vision/category)
    ec_path = os.path.join(vault, ".roost", "cache", "embedding-cache.json")
    ec = json.load(open(ec_path)) if os.path.exists(ec_path) else {}
    e = ec.get(rid, {})
    fm = {}
    for p in glob.glob(os.path.join(vault, sync_folder, "**", "*.md"), recursive=True):
        f = L._read_fm(p)
        if f.get("roost_id") == rid:
            fm = f
            break
    parts = [e.get("vision", ""), e.get("summary", ""), e.get("category", ""),
             fm.get("title", ""), fm.get("subtitle", "")]
    return " ".join(x for x in parts if x), cache.get(rid)

def _embed(text, embed_url):
    body = json.dumps({"model": "x", "input": [text]}).encode()
    req = urllib.request.Request(embed_url, body, {"Content-Type": "application/json"})
    v = json.load(urllib.request.urlopen(req, timeout=60))["embeddings"][0]
    return np.asarray(v, dtype=np.float64)

def verify_embeddings_fresh(vault, sample_ids, embed_url="http://localhost:11435/api/embed", tol=0.90):
    """Model-identity check: verifies the running sidecar is the current v2 model,
    NOT that vectors reproduce exactly (the embedding-cache.json does not store the
    exact text that was embedded, so reconstruction is approximate).

    Threshold semantics:
      - Current v2 model re-embeds reconstructed text at cos 0.92–1.0 even with
        imperfect text reconstruction (verified in-vault 2026-07-03).
      - A stale/wrong model (base-nomic or old cache) re-embeds at cos ~0.67
        (see ARCHITECTURE.md honest-eval-results: "sidecar reproduces cached vectors
        at cos=1.0000 … vs raw nomic ~0.67").
      - tol=0.90 cleanly separates current-v2 (≥0.90) from stale (<0.90).

    Returns {"checked": int, "min_cos": float|None, "ok": bool}.
    min_cos is None when no IDs were checkable (nothing measured ≠ perfect)."""
    checked = 0
    min_cos = None
    for rid in sample_ids:
        text, cached = _note_text_for_id(vault, rid)
        if cached is None or not text:
            continue
        fresh = _embed(text, embed_url)
        c = cached.astype(np.float64)
        cos = float(fresh @ c / ((np.linalg.norm(fresh) or 1) * (np.linalg.norm(c) or 1)))
        min_cos = cos if min_cos is None else min(min_cos, cos)
        checked += 1
        if cos < tol:
            raise AssertionError(f"stale embedding for {rid}: cos={cos:.4f} < {tol} — cache is not current v2")
    return {"checked": checked, "min_cos": min_cos, "ok": checked > 0}


def sidecar_model_stamp(vault):
    """Stamp the sidecar's fine-tuned model file for provenance.
    Tries <vault>/.roost/build/nomic-finetuned-hardneg/model.safetensors then
    <vault>/.roost/nomic-finetuned-hardneg/model.safetensors; returns stamp() of
    the first that exists, or {"exists": False} if neither does."""
    candidates = [
        os.path.join(vault, ".roost", "build", "nomic-finetuned-hardneg", "model.safetensors"),
        os.path.join(vault, ".roost", "nomic-finetuned-hardneg", "model.safetensors"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return stamp(path)
    return {"exists": False}

def _config_models(repo_root):
    cfg = os.path.join(repo_root, "packages", "core", "src", "config.ts")
    txt = open(cfg).read() if os.path.exists(cfg) else ""
    def grab(name):
        m = re.search(rf'{name}\s*=\s*"([^"]+)"', txt)
        return m.group(1) if m else None
    return {"EMBED_MODEL": grab("EMBED_MODEL"), "VISION_MODEL": grab("VISION_MODEL")}

def build_block(vault, inputs, repo_root="."):
    block = {label: stamp(path) for label, path in inputs.items()}
    try:
        sha = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=repo_root).decode().strip()
    except Exception:
        sha = None
    block["_git_sha"] = sha
    block["_models"] = _config_models(repo_root)
    return block
