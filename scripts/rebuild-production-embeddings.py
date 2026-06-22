#!/usr/bin/env python3
"""Production embedding rebuild (Task 7 Step 1, deferred to operational rollout).

Refreshes the ENTIRE vault's embeddings to the qwen cover-only representation the
stacked heads expect. The production embedding-vectors.bin is stale (vision present
on only ~2.5k/20k items, gemma-era) so the stacked path would score on a mismatched
representation until this runs.

Two phases (memory staging — qwen + the embed sidecar OOM 24 GB together):

  --phase describe : qwen cover-only describe for every cover-bearing item, written
                     to  qwen-cover-full.json  (id -> description). Resumable: skips
                     ids already present. SIDECAR MUST BE DOWN.
                     (Seeded from the existing exp-{keyframe,twitter}-cover.json so
                     the ~1.9k already-described covers are not re-described.)

  --phase embed    : build the production-uniform vision-on + text-only embed text,
                     embed BOTH via the sidecar, and rewrite:
                        embedding-cache.json        (entry.vision refreshed)
                        embedding-vectors.bin       (entry.vec  = vision-on)
                        embedding-vectors-text.bin  (entry.vecText = text-only)
                     Backs up embedding-cache.json + embedding-vectors.bin first.
                     SIDECAR MUST BE UP.

Text construction MIRRORS describe-items.ts exactly (uniform across platforms):
  visionText = [vision, summary, category, title, subtitle]   (join " ", drop empties)
  plainText  = [summary, category, title, subtitle]
matching the stacked heads retrained on the production order.

Run:
  ROOST_VAULT=<v> python scripts/rebuild-production-embeddings.py --phase describe  # sidecar DOWN
  ROOST_VAULT=<v> python scripts/rebuild-production-embeddings.py --phase embed      # sidecar UP
"""
import argparse
import base64
import glob
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

OLLAMA = "http://localhost:11434"
SIDECAR = "http://localhost:11435"
VISION_MODEL = "huihui_ai/qwen2.5-vl-abliterated:latest"
VISION_NUM_CTX = 4096
VISION_PROMPT = "Describe what is happening in this image in two or three sentences."
DIM = 768


def vault_dirs():
    V = os.environ.get("ROOST_VAULT")
    if not V:
        print("ERROR: ROOST_VAULT not set."); sys.exit(1)
    V = str(Path(V))
    C = os.path.join(V, ".roost", "cache")
    return V, C


# ── md scan: id -> {title, subtitle, cover_abs} ───────────────────────────────

def scan_items(V):
    info = {}
    for p in glob.glob(os.path.join(V, "Bookmarks", "**", "*.md"), recursive=True):
        try:
            t = open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        m = re.search(r"^roost_id:\s*(\S+)", t, re.M)
        if not m:
            continue
        iid = m.group(1).strip().strip('"')
        fm = t.split("---")[1] if t.count("---") >= 2 else t
        tit = re.search(r"^title:\s*(.*)$", fm, re.M)
        sub = re.search(r"^subtitle:\s*(.*)$", fm, re.M)
        cov = re.search(r'^cover:\s*"?\[?\[?([^\]\n"]+)\]?\]?"?', fm, re.M)
        cover_abs = None
        if cov:
            raw = cov.group(1).strip()
            cand = os.path.join(V, raw)
            if os.path.exists(cand):
                cover_abs = cand
            else:
                # try alongside the note's attachment dir
                d = os.path.dirname(p)
                base = os.path.basename(raw)
                alt = os.path.join(d, base)
                if os.path.exists(alt):
                    cover_abs = alt
        info[iid] = {
            "title": (tit.group(1).strip().strip('"') if tit else ""),
            "subtitle": (sub.group(1).strip().strip('"') if sub else ""),
            "cover": cover_abs,
        }
    return info


# ── qwen describe ─────────────────────────────────────────────────────────────

def qwen(img_path, tries=3):
    try:
        b64 = base64.b64encode(open(img_path, "rb").read()).decode()
    except Exception:
        return ""
    body = json.dumps({
        "model": VISION_MODEL, "prompt": VISION_PROMPT, "images": [b64],
        "stream": False, "options": {"num_ctx": VISION_NUM_CTX},
    }).encode()
    for k in range(tries):
        try:
            r = json.load(urllib.request.urlopen(
                urllib.request.Request(OLLAMA + "/api/generate", body,
                                       {"Content-Type": "application/json"}), timeout=300))
            return (r.get("response", "") or "").strip()[:500]
        except Exception:
            if k == tries - 1:
                return ""
            time.sleep(2.0 * (k + 1))


# ── sidecar embed (surrogate-safe, 10k cap, normalized) ───────────────────────

def embed(text, tries=6):
    text = (text or "").encode("utf-8", "ignore").decode("utf-8")[:10000]
    body = json.dumps({"model": "x", "input": [text]}).encode()
    for k in range(tries):
        try:
            v = json.load(urllib.request.urlopen(
                urllib.request.Request(SIDECAR + "/api/embed", body,
                                       {"Content-Type": "application/json"}), timeout=60))["embeddings"][0]
            v = np.asarray(v, np.float32)
            n = float(np.linalg.norm(v))
            return v / (n if n > 0 else 1.0)
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2.0 * (k + 1))


def write_bin(path, ids, vecs):
    arr = np.asarray(vecs, dtype=np.float32)
    with open(path, "wb") as f:
        f.write(json.dumps(ids).encode("utf-8")); f.write(b"\n")
        f.write(arr.tobytes(order="C"))


# ── phases ────────────────────────────────────────────────────────────────────

def phase_describe(V, C):
    full_path = os.path.join(C, "qwen-cover-full.json")
    vis = json.load(open(full_path)) if os.path.exists(full_path) else {}
    # Seed from the eval cover caches (already qwen) so we don't redo ~1.9k.
    for seed in ("exp-keyframe-cover.json", "exp-twitter-cover.json"):
        sp = os.path.join(C, seed)
        if os.path.exists(sp):
            for k, d in json.load(open(sp)).items():
                vis.setdefault(k, d)
    info = scan_items(V)
    cover_ids = [i for i, m in info.items() if m["cover"]]
    todo = [i for i in cover_ids if i not in vis]
    print(f"cover-bearing items: {len(cover_ids)}   already described: {len(cover_ids)-len(todo)}   todo: {len(todo)}")
    print("SIDECAR MUST BE DOWN. Resumable — re-run to continue.")
    t0 = time.time()
    for n, iid in enumerate(todo):
        vis[iid] = qwen(info[iid]["cover"])
        if n % 20 == 0:
            json.dump(vis, open(full_path, "w"))
            el = time.time() - t0
            rate = (n / el) if el > 0 else 0
            eta = ((len(todo) - n) / rate / 3600) if rate > 0 else 0
            print(f"  {n}/{len(todo)}  ({el/3600:.2f}h, ~{eta:.1f}h left)")
    json.dump(vis, open(full_path, "w"))
    print(f"describe done: {len(vis)} descriptions in {full_path}. Bring sidecar UP, run --phase embed.")


def phase_embed(V, C):
    full_path = os.path.join(C, "qwen-cover-full.json")
    if not os.path.exists(full_path):
        print(f"ERROR: {full_path} missing — run --phase describe first."); sys.exit(1)
    vis = json.load(open(full_path))
    cache_path = os.path.join(C, "embedding-cache.json")
    cache = json.load(open(cache_path))
    info = scan_items(V)

    # Back up before writing.
    for src in (cache_path, os.path.join(C, "embedding-vectors.bin")):
        bak = src + ".PRE-QWEN-REBUILD"
        if os.path.exists(src) and not os.path.exists(bak):
            shutil.copy2(src, bak); print(f"backup: {bak}")

    ids, vecs, tvecs = [], [], []
    items = [i for i in cache if isinstance(cache[i], dict)]
    n = len(items)
    print(f"embedding {n} items (uniform construction) — SIDECAR UP")
    t0 = time.time()
    for k, iid in enumerate(items):
        e = cache[iid]
        m = info.get(iid, {"title": "", "subtitle": ""})
        v = vis.get(iid, "") or ""
        e["vision"] = v or e.get("vision")  # refresh vision metadata if we have qwen desc
        summary = e.get("summary") or ""
        category = e.get("category") or ""
        title = m["title"]; subtitle = m["subtitle"]
        vision_text = " ".join(x for x in [v, summary, category, title, subtitle] if x)
        plain_text = " ".join(x for x in [summary, category, title, subtitle] if x)
        if len(plain_text) < 1 and len(vision_text) < 1:
            continue
        vv = embed(vision_text if len(vision_text) > 10 else plain_text)
        vt = embed(plain_text if len(plain_text) > 10 else vision_text)
        ids.append(iid); vecs.append(vv); tvecs.append(vt)
        if k % 200 == 0 and k:
            print(f"  {k}/{n}  ({time.time()-t0:.0f}s)")
    print(f"embedded {len(ids)} items in {time.time()-t0:.1f}s")

    json.dump({"dim": DIM}, open(os.path.join(C, "embedding-meta.json"), "w"))
    write_bin(os.path.join(C, "embedding-vectors.bin"), ids, vecs)
    write_bin(os.path.join(C, "embedding-vectors-text.bin"), ids, tvecs)
    json.dump(cache, open(cache_path, "w"))
    print(f"wrote embedding-vectors.bin + embedding-vectors-text.bin ({len(ids)} items) + refreshed embedding-cache.json")


def count_todo(V, C):
    """Print the number of cover-bearing items still lacking a qwen description
    (0 == describe phase complete). Used by the rollout orchestrator."""
    full_path = os.path.join(C, "qwen-cover-full.json")
    vis = json.load(open(full_path)) if os.path.exists(full_path) else {}
    for seed in ("exp-keyframe-cover.json", "exp-twitter-cover.json"):
        sp = os.path.join(C, seed)
        if os.path.exists(sp):
            for k in json.load(open(sp)):
                vis.setdefault(k, "")
    info = scan_items(V)
    cover_ids = [i for i, m in info.items() if m["cover"]]
    print(sum(1 for i in cover_ids if i not in vis))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--phase", choices=["describe", "embed"])
    ap.add_argument("--check-todo", action="store_true",
                    help="Print remaining describe count (0 = done) and exit.")
    args = ap.parse_args()
    V, C = vault_dirs()
    if args.check_todo:
        count_todo(V, C)
        return
    if not args.phase:
        ap.error("--phase is required unless --check-todo")
    print("rebuild-production-embeddings.py"); print("=" * 60)
    print(f"Vault: {V}   phase: {args.phase}\n")
    if args.phase == "describe":
        phase_describe(V, C)
    else:
        phase_embed(V, C)


if __name__ == "__main__":
    main()
