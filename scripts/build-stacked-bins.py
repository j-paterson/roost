#!/usr/bin/env python3
"""One-off (Task 7 Step 2): build qwen-cover-consistent vision-on + text-only
embedding bins for the honest-labeled TikTok+Twitter items, so
train-stacked-heads.py can train the two base heads + meta WITHOUT touching the
live production embedding-vectors.bin.

Embeds EXACTLY as acceptance-gate-stacking.py does — same caption construction,
same qwen cover-description source (exp-{keyframe,twitter}-cover.json), same
sidecar — so the trained heads match the representation the gate evaluates on.

Sidecar must be UP (this step only embeds; the qwen describe is already cached).

Outputs (under a SEPARATE dir so production embedding-vectors.bin is untouched):
  <vault>/.roost/cache/stacked-bins/embedding-vectors.bin       vision-on (cover+caption)
  <vault>/.roost/cache/stacked-bins/embedding-vectors-text.bin  text-only (caption)
  <vault>/.roost/cache/stacked-bins/embedding-meta.json         {"dim":768}

Then train:
  python scripts/train-stacked-heads.py --split all \
    --bin-vision <vault>/.roost/cache/stacked-bins/embedding-vectors.bin \
    --bin-text   <vault>/.roost/cache/stacked-bins/embedding-vectors-text.bin

Run:
  ROOST_VAULT=<vault> python scripts/build-stacked-bins.py [--limit N]
"""
import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import honest_eval_lib as L

CANONICAL_CATS = {
    "Art", "Content Creation", "Crafts", "Design", "Fashion", "Fitness",
    "Food", "Growth", "Humor", "Lifestyle", "Media", "Money", "Other",
    "Places & Travel", "Quotes", "Products", "Relationships", "Spicy", "Tech",
}
DIM = 768


def _loadmod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SD = os.path.dirname(os.path.abspath(__file__))
TK = _loadmod("tkm", os.path.join(SD, "exp-tiktok-gating.py"))
TW = _loadmod("twm", os.path.join(SD, "exp-twitter-gating.py"))
EMBED = TK.embed  # robust embed: strips lone surrogates, caps 10k chars, retries


# ── Caption construction (VERBATIM from acceptance-gate-stacking.py cap_*) ─────

def cap_tiktok(i, tcache, info):
    e = tcache[i]; it = info[i]
    return " ".join(x for x in [e.get("summary"), e.get("category"),
                                 it["title"], it["subtitle"]] if x)


def cap_twitter(i, tcache, info):
    # Production order (describe-items.ts plainText = [summary, category, title]).
    e = tcache[i]; it = info[i]
    return " ".join(x for x in [e.get("summary"), e.get("category"), it["title"]] if x)


def vision_text(cover_desc, cap):
    return (cover_desc + " " + cap).strip() if cover_desc else cap


# ── Binary writer (mirrors shared.ts saveVectorsBin / honest_eval load_cache) ──

def write_bin(path: Path, ids, vecs):
    """First line = JSON keys array + '\\n', then row-major float32 (len(ids) x DIM)."""
    arr = np.asarray(vecs, dtype=np.float32)
    assert arr.shape == (len(ids), DIM), f"bad matrix shape {arr.shape}"
    with open(path, "wb") as f:
        f.write(json.dumps(ids).encode("utf-8"))
        f.write(b"\n")
        f.write(arr.tobytes(order="C"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=0,
                    help="Smoke test: build only the first N items per platform (0 = all).")
    ap.add_argument("--out-dir", default=None,
                    help="Output dir (default <vault>/.roost/cache/stacked-bins).")
    args = ap.parse_args()

    V = os.environ.get("ROOST_VAULT")
    if not V:
        print("ERROR: ROOST_VAULT not set."); sys.exit(1)
    V = str(Path(V))
    C = os.path.join(V, ".roost", "cache")
    out_dir = Path(args.out_dir) if args.out_dir else Path(C) / "stacked-bins"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    print("build-stacked-bins.py")
    print("=" * 60)
    print(f"Vault:    {V}")
    print(f"Out dir:  {out_dir}")
    print(f"Limit:    {args.limit or 'all'}")
    print()

    labels, _neg = L.load_honest_labels(V)
    tcache = json.load(open(os.path.join(C, "embedding-cache.json")))
    tk_cover = json.load(open(os.path.join(C, "exp-keyframe-cover.json")))
    tw_cover = json.load(open(os.path.join(C, "exp-twitter-cover.json")))

    print("Scanning vault frontmatter (TikTok + X)...")
    tk_info = TK.build_info(V)
    tw_info = TW.build_info(V)
    print(f"  tiktok md: {len(tk_info)}   twitter md: {len(tw_info)}  ({time.time()-t0:.1f}s)")

    # Build the work list: honest, canonical, has cache entry + cover desc.
    def gather(prefix, info, cover, cap_fn):
        ids = []
        for i, cat in labels.items():
            if not i.startswith(prefix):
                continue
            if cat not in CANONICAL_CATS:
                continue
            if i not in tcache or i not in info or not cover.get(i):
                continue
            ids.append(i)
        ids.sort()
        if args.limit:
            ids = ids[:args.limit]
        return [(i, cap_fn(i, tcache, info), cover[i]) for i in ids]

    tk_items = gather("tiktok:", tk_info, tk_cover, cap_tiktok)
    tw_items = gather("twitter:", tw_info, tw_cover, cap_twitter)
    work = tk_items + tw_items
    print(f"  buildable: tiktok={len(tk_items)} twitter={len(tw_items)} total={len(work)}")
    if not work:
        print("ERROR: no buildable items."); sys.exit(1)

    ids, vis_vecs, txt_vecs = [], [], []
    n = len(work)
    print(f"\nEmbedding {n} items x2 (text-only + vision-on) via sidecar...")
    for k, (iid, cap, cover_desc) in enumerate(work):
        if k % 100 == 0 and k:
            print(f"  {k}/{n}  ({time.time()-t0:.0f}s)")
        v_txt = EMBED(cap)
        v_vis = EMBED(vision_text(cover_desc, cap))
        ids.append(iid)
        txt_vecs.append(v_txt)
        vis_vecs.append(v_vis)
    print(f"  embedded {n} items in {time.time()-t0:.1f}s")

    # Sanity: every vector finite, unit-norm, correct dim.
    A = np.asarray(vis_vecs, dtype=np.float32)
    B = np.asarray(txt_vecs, dtype=np.float32)
    assert A.shape == (n, DIM) and B.shape == (n, DIM), f"shape {A.shape}/{B.shape}"
    assert np.all(np.isfinite(A)) and np.all(np.isfinite(B)), "non-finite vectors"

    meta_path = out_dir / "embedding-meta.json"
    json.dump({"dim": DIM}, open(meta_path, "w"))
    write_bin(out_dir / "embedding-vectors.bin", ids, vis_vecs)
    write_bin(out_dir / "embedding-vectors-text.bin", ids, txt_vecs)

    print(f"\nWrote:")
    print(f"  {out_dir / 'embedding-vectors.bin'}       (vision-on, {n} x {DIM})")
    print(f"  {out_dir / 'embedding-vectors-text.bin'}  (text-only, {n} x {DIM})")
    print(f"  {meta_path}")
    print(f"\nTotal time: {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
