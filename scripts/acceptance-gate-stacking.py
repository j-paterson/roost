#!/usr/bin/env python3
"""Acceptance gate for the stacked-heads system (Task 7).

Evaluates single-head baseline vs stacked system on a held-out human-labeled
split, per platform (TikTok, Twitter), and decides pass/fail.

Gate passes iff:
  1. stacked top-1 >= single-head top-1 overall on BOTH platforms
  2. No category regresses by more than 5pp vs single-head on either platform

Outputs:
  - Per-platform single-head vs stacked top-1 + delta
  - Per-category single-head → stacked table (per platform)
  - Final  GATE: PASS / GATE: FAIL  with reason

Required head JSONs (produced by  scripts/train-stacked-heads.py --split all):
  <vault>/.roost/cache/classifier-head.json        — single head (vision-on)
  <vault>/.roost/cache/classifier-head-text.json   — text-only base head
  <vault>/.roost/cache/classifier-head-vision.json — vision-on base head
  <vault>/.roost/cache/meta-head.json              — meta head (input: [p_text, p_vision])

Forward pass (mirrors TS classifyStacked exactly):
  single head:
    x_norm = x / ||x||_2          (vision-on vector)
    z[c]   = dot(W[c], x_norm) + b[c]
    pred   = argmax(softmax(z))

  stacked:
    p_text   = softmax(W_text   · l2norm(vec_text)   + b_text)
    p_vision = softmax(W_vision · l2norm(vec_vision) + b_vision)
    feat     = [p_text, p_vision]   # length 2C — text FIRST (matches TS feat=[...pText,...pVision])
    z_meta   = W_meta · feat + b_meta
    pred     = argmax(softmax(z_meta))

Run:
  ROOST_VAULT=<vault> python scripts/acceptance-gate-stacking.py

Optional flags:
  --platform  tiktok|twitter|both  (default: both)
  --cat-regression-margin  0.05    (default: 5pp)
  --min-cat-n  6                   (minimum category samples for per-cat table)
  --sample-n   900                 (max items per platform)
"""

import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

# ── Paths ─────────────────────────────────────────────────────────────────────

def get_vault() -> Path:
    v = os.environ.get("ROOST_VAULT")
    if not v:
        print("ERROR: ROOST_VAULT environment variable not set.")
        print("  Usage:  ROOST_VAULT=<path> python scripts/acceptance-gate-stacking.py")
        sys.exit(1)
    return Path(v)


def cache_dir(vault: Path) -> Path:
    return vault / ".roost" / "cache"


REQUIRED_HEADS = [
    "classifier-head.json",
    "classifier-head-text.json",
    "classifier-head-vision.json",
    "meta-head.json",
]


def check_heads(c: Path) -> bool:
    """Return True if all required head JSONs exist; print diagnostics and return False otherwise."""
    missing = [name for name in REQUIRED_HEADS if not (c / name).exists()]
    if missing:
        print("ERROR: Required head JSON files are missing:")
        for m in missing:
            print(f"  MISSING  {c / m}")
        print()
        print("Run   scripts/train-stacked-heads.py --split all   first, then re-run this gate.")
        return False
    return True


# ── Head loading ──────────────────────────────────────────────────────────────

def load_head(path: Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_all_heads(c: Path):
    """Load and return (single, text, vision, meta) head dicts."""
    single = load_head(c / "classifier-head.json")
    text   = load_head(c / "classifier-head-text.json")
    vision = load_head(c / "classifier-head-vision.json")
    meta   = load_head(c / "meta-head.json")
    return single, text, vision, meta


# ── Math: softmax / forward passes ───────────────────────────────────────────

def softmax(z: np.ndarray) -> np.ndarray:
    """Numerically stable softmax over a 1-D logit vector."""
    e = np.exp(z - z.max())
    return e / e.sum()


def l2norm(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / (n if n > 0 else 1.0)


def forward_single(head: dict, vec: np.ndarray) -> str:
    """Single-head forward pass (vision-on embedding).

    Mirrors TS classifyWithHead:
        x_norm = l2norm(vec)           (vision-on vector)
        z[c]   = dot(W[c], x_norm) + b[c]
        pred   = classes[argmax(softmax(z))]
    """
    W = np.asarray(head["W"], dtype=np.float64)   # (C, dim)
    b = np.asarray(head["b"], dtype=np.float64)   # (C,)
    classes = head["classes"]
    x = l2norm(vec.astype(np.float64))
    z = W @ x + b
    return classes[int(np.argmax(softmax(z)))]


def forward_stacked(text_head: dict, vision_head: dict, meta_head: dict,
                    vec_text: np.ndarray, vec_vision: np.ndarray) -> str:
    """Stacked-heads forward pass.

    Mirrors TS classifyStacked exactly:
        p_text   = softmax(W_text   · l2norm(vec_text)   + b_text)
        p_vision = softmax(W_vision · l2norm(vec_vision) + b_vision)
        feat     = [...pText, ...pVision]   # text FIRST — length 2C
        z_meta   = W_meta · feat + b_meta
        pred     = classes_meta[argmax(softmax(z_meta))]

    Feature-order invariant: text probabilities occupy indices [0, C)
    and vision probabilities occupy indices [C, 2C).  This must match
    the export order in train-stacked-heads.py
    (feat_meta = np.hstack([P_text_oof, P_vision_oof])).
    """
    W_t = np.asarray(text_head["W"],   dtype=np.float64)
    b_t = np.asarray(text_head["b"],   dtype=np.float64)
    W_v = np.asarray(vision_head["W"], dtype=np.float64)
    b_v = np.asarray(vision_head["b"], dtype=np.float64)
    W_m = np.asarray(meta_head["W"],   dtype=np.float64)
    b_m = np.asarray(meta_head["b"],   dtype=np.float64)
    classes_meta = meta_head["classes"]

    p_text   = softmax(W_t @ l2norm(vec_text.astype(np.float64))   + b_t)
    p_vision = softmax(W_v @ l2norm(vec_vision.astype(np.float64)) + b_v)

    # Text FIRST, then vision — invariant must match train-stacked-heads.py
    feat  = np.concatenate([p_text, p_vision])   # length 2C
    z_meta = W_m @ feat + b_m
    return classes_meta[int(np.argmax(softmax(z_meta)))]


# ── Embedding via sidecar ─────────────────────────────────────────────────────

SIDECAR = "http://localhost:11435"


def embed(text: str, retries: int = 6) -> np.ndarray:
    """Embed text via the local sidecar; surrogate-safe + 10 000 char cap."""
    # Mirrors the guard used in exp-stacking-cascade.py and exp-tiktok-gating.py
    text = text.encode("utf-8", "ignore").decode("utf-8")[:10000]
    body = json.dumps({"model": "x", "input": [text]}).encode()
    req  = urllib.request.Request(
        SIDECAR + "/api/embed", body, {"Content-Type": "application/json"}
    )
    for attempt in range(retries):
        try:
            v = json.load(urllib.request.urlopen(req, timeout=60))["embeddings"][0]
            v = np.asarray(v, dtype=np.float32)
            n = float(np.linalg.norm(v))
            return v / (n if n > 0 else 1.0)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2.0 * (attempt + 1))


# ── Platform helpers ──────────────────────────────────────────────────────────

def _loadmod(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_sample_tiktok(vault: Path, max_n: int, scripts_dir: str):
    """Return (items, labels, tcache, info) for TikTok using exp-tiktok-gating.sample()."""
    tk = _loadmod("tkm", os.path.join(scripts_dir, "exp-tiktok-gating.py"))
    samp, labels, tcache, info = tk.sample(str(vault))
    return samp[:max_n], labels, tcache, info


def build_sample_twitter(vault: Path, max_n: int, scripts_dir: str):
    """Return (items, labels, tcache, info) for Twitter using exp-twitter-gating.sample()."""
    tw = _loadmod("twm", os.path.join(scripts_dir, "exp-twitter-gating.py"))
    samp, labels, tcache, info = tw.sample(str(vault))
    return samp[:max_n], labels, tcache, info


def cap_tiktok(i: str, tcache: dict, info: dict) -> str:
    """Text-only caption for TikTok item (mirrors cap_tk in exp-stacking-cascade.py)."""
    e  = tcache[i]
    it = info[i]
    return " ".join(x for x in [e.get("summary"), e.get("category"),
                                  it["title"], it["subtitle"]] if x)


def cap_twitter(i: str, tcache: dict, info: dict) -> str:
    """Text-only caption for Twitter item — PRODUCTION order to match the runtime
    embed text (describe-items.ts plainText = [summary, category, title]); the
    single-head baseline was also trained on this order, so the gate measures the
    representation that actually ships."""
    e  = tcache[i]
    it = info[i]
    return " ".join(x for x in [e.get("summary"), e.get("category"), it["title"]] if x)


def cover_text(iid: str, cover_cache: dict, cap: str) -> str:
    """Vision-on text = cover description + caption (mirrors etext in gating scripts)."""
    vis = cover_cache.get(iid, "")
    return (vis + " " + cap).strip() if vis else cap


# ── Evaluation loop ───────────────────────────────────────────────────────────

def evaluate_platform(
    platform: str,
    samp: list,
    labels: dict,
    tcache: dict,
    info: dict,
    cap_fn,
    cover_cache: dict,
    single_head: dict,
    text_head: dict,
    vision_head: dict,
    meta_head: dict,
):
    """Embed and classify all items in `samp`; return per-item result dicts.

    Each result: {id, gt, pred_single, pred_stacked}
    """
    results = []
    n = len(samp)
    print(f"  Embedding {n} items for {platform} ...")
    t0 = time.time()
    for idx, iid in enumerate(samp):
        if idx > 0 and idx % 100 == 0:
            elapsed = time.time() - t0
            print(f"    {idx}/{n}  ({elapsed:.0f}s elapsed)")
        gt   = labels[iid]
        cap  = cap_fn(iid, tcache, info)
        text = cap                              # text-only: caption only
        vis  = cover_text(iid, cover_cache, cap) # vision-on: cover + caption

        vec_text   = embed(text)
        vec_vision = embed(vis)

        pred_single  = forward_single(single_head, vec_vision)   # baseline uses vision-on
        pred_stacked = forward_stacked(text_head, vision_head, meta_head,
                                       vec_text, vec_vision)
        results.append({
            "id":           iid,
            "gt":           gt,
            "pred_single":  pred_single,
            "pred_stacked": pred_stacked,
        })
    print(f"    Done in {time.time()-t0:.1f}s")
    return results


# ── Gate metrics ──────────────────────────────────────────────────────────────

def compute_metrics(results: list, min_cat_n: int):
    """Return (overall_single, overall_stacked, per_cat dict) for a list of results."""
    n = len(results)
    if n == 0:
        return 0.0, 0.0, {}

    correct_single  = sum(1 for r in results if r["pred_single"]  == r["gt"])
    correct_stacked = sum(1 for r in results if r["pred_stacked"] == r["gt"])

    overall_single  = correct_single  / n
    overall_stacked = correct_stacked / n

    # Per-category
    by_cat = defaultdict(list)
    for r in results:
        by_cat[r["gt"]].append(r)

    per_cat = {}
    for cat, items in sorted(by_cat.items()):
        if len(items) < min_cat_n:
            continue
        c_s = sum(1 for r in items if r["pred_single"]  == r["gt"])
        c_k = sum(1 for r in items if r["pred_stacked"] == r["gt"])
        per_cat[cat] = {
            "n":      len(items),
            "single": c_s / len(items),
            "stacked": c_k / len(items),
            "delta":   (c_k - c_s) / len(items),
        }
    return overall_single, overall_stacked, per_cat


def print_platform_report(platform: str, n: int, single: float, stacked: float,
                           per_cat: dict, margin: float):
    """Print the per-platform section of the gate report."""
    delta = stacked - single
    sign  = "+" if delta >= 0 else ""
    print(f"\n{'='*60}")
    print(f"  {platform}  (n={n})")
    print(f"{'='*60}")
    print(f"  single-head top-1 : {single*100:.1f}%")
    print(f"  stacked top-1     : {stacked*100:.1f}%")
    print(f"  delta             : {sign}{delta*100:.1f}pp")
    if per_cat:
        print(f"\n  Per-category breakdown (min n={args_global.min_cat_n}):")
        header = f"  {'Category':<22}  {'n':>4}  {'single':>7}  {'stacked':>7}  {'delta':>8}  flag"
        print(header)
        print("  " + "-" * (len(header) - 2))
        for cat, m in sorted(per_cat.items()):
            flag = "  REGRESS" if m["delta"] < -margin else ""
            sign2 = "+" if m["delta"] >= 0 else ""
            print(
                f"  {cat:<22}  {m['n']:>4}  {m['single']*100:>6.1f}%"
                f"  {m['stacked']*100:>6.1f}%  {sign2}{m['delta']*100:>6.1f}pp{flag}"
            )


# ── Main ──────────────────────────────────────────────────────────────────────

# Module-level holder for argparse namespace so print_platform_report can read min_cat_n.
args_global = None


def main():
    global args_global

    ap = argparse.ArgumentParser(
        description="Acceptance gate: single-head baseline vs stacked system, per platform."
    )
    ap.add_argument(
        "--platform", choices=["tiktok", "twitter", "both"], default="both",
        help="Which platform(s) to evaluate (default: both)",
    )
    ap.add_argument(
        "--cat-regression-margin", type=float, default=0.05,
        dest="margin",
        help="Maximum allowable per-category regression (default: 0.05 = 5pp)",
    )
    ap.add_argument(
        "--min-cat-n", type=int, default=6,
        help="Minimum samples for a category to appear in the per-category table (default: 6)",
    )
    ap.add_argument(
        "--sample-n", type=int, default=900,
        help="Maximum items per platform (default: 900, matches gating eval design)",
    )
    args = ap.parse_args()
    args_global = args

    vault = get_vault()
    c     = cache_dir(vault)
    sd    = os.path.dirname(os.path.abspath(__file__))

    # ── Pre-flight: verify all head JSONs exist ───────────────────────────────
    if not check_heads(c):
        sys.exit(1)

    single_head, text_head, vision_head, meta_head = load_all_heads(c)

    # Verify class alignment across all heads
    classes_s = single_head["classes"]
    classes_t = text_head["classes"]
    classes_v = vision_head["classes"]
    classes_m = meta_head["classes"]
    if not (classes_s == classes_t == classes_v == classes_m):
        print("ERROR: Head JSON files have mismatched class lists.")
        print(f"  classifier-head.json:        {classes_s}")
        print(f"  classifier-head-text.json:   {classes_t}")
        print(f"  classifier-head-vision.json: {classes_v}")
        print(f"  meta-head.json:              {classes_m}")
        print()
        print("Re-run  scripts/train-stacked-heads.py --split all  to regenerate all three heads together.")
        sys.exit(1)

    # Verify meta inDim = 2 * C
    n_classes = len(classes_m)
    expected_in_dim = 2 * n_classes
    actual_in_dim   = meta_head.get("inDim", len(meta_head["W"][0]) if meta_head["W"] else 0)
    if actual_in_dim != expected_in_dim:
        print(f"ERROR: meta-head.json inDim={actual_in_dim} but expected {expected_in_dim} (2 × {n_classes} classes).")
        sys.exit(1)

    print("acceptance-gate-stacking.py")
    print("=" * 60)
    print(f"Vault:              {vault}")
    print(f"Platform(s):        {args.platform}")
    print(f"Regression margin:  {args.margin*100:.0f}pp")
    print(f"Min category n:     {args.min_cat_n}")
    print(f"Max sample n:       {args.sample_n}")
    print(f"Classes ({n_classes}):        {classes_m}")
    print()

    # ── Evaluate platforms ────────────────────────────────────────────────────
    platforms_to_run = (
        ["tiktok", "twitter"] if args.platform == "both" else [args.platform]
    )

    # ── Load cover description caches ────────────────────────────────────────
    tk_cover_path = c / "exp-keyframe-cover.json"
    tw_cover_path = c / "exp-twitter-cover.json"
    tk_cover = json.load(open(tk_cover_path)) if tk_cover_path.exists() else {}
    tw_cover = json.load(open(tw_cover_path)) if tw_cover_path.exists() else {}

    # Abort if a cover cache is absent/empty for any platform being evaluated —
    # with no cover descriptions the vision vector collapses to the text vector and
    # a GATE: PASS would be meaningless.
    cover_errors = []
    if "tiktok" in platforms_to_run and not tk_cover:
        cover_errors.append(
            f"ERROR: exp-keyframe-cover.json is absent or empty ({tk_cover_path}).\n"
            "  Run the TikTok describe phase to populate keyframe cover descriptions before gating."
        )
    if "twitter" in platforms_to_run and not tw_cover:
        cover_errors.append(
            f"ERROR: exp-twitter-cover.json is absent or empty ({tw_cover_path}).\n"
            "  Run the Twitter describe phase to populate cover descriptions before gating."
        )
    if cover_errors:
        for msg in cover_errors:
            print(msg)
        sys.exit(1)

    platform_results = {}

    for plat in platforms_to_run:
        print(f"\nLoading {plat} sample ...")
        if plat == "tiktok":
            samp, labels, tcache, info = build_sample_tiktok(vault, args.sample_n, sd)
            cap_fn   = cap_tiktok
            cover    = tk_cover
        else:
            samp, labels, tcache, info = build_sample_twitter(vault, args.sample_n, sd)
            cap_fn   = cap_twitter
            cover    = tw_cover
        print(f"  {len(samp)} items  |  cats: {sorted(set(labels[i] for i in samp))}")

        results = evaluate_platform(
            plat, samp, labels, tcache, info,
            cap_fn, cover,
            single_head, text_head, vision_head, meta_head,
        )
        platform_results[plat] = results

    # ── Compute and print metrics ─────────────────────────────────────────────
    print("\n\n" + "#" * 60)
    print("  GATE METRICS")
    print("#" * 60)

    gate_failures = []
    plat_metrics  = {}

    for plat, results in platform_results.items():
        ov_s, ov_k, per_cat = compute_metrics(results, args.min_cat_n)
        plat_metrics[plat] = (ov_s, ov_k, per_cat)

        print_platform_report(plat, len(results), ov_s, ov_k, per_cat, args.margin)

        # Gate check 1: overall non-regression per platform
        if ov_k < ov_s:
            gate_failures.append(
                f"{plat}: stacked top-1 {ov_k*100:.1f}% < single-head {ov_s*100:.1f}% "
                f"(delta {(ov_k-ov_s)*100:.1f}pp)"
            )

        # Gate check 2: no per-category regression beyond margin
        for cat, m in per_cat.items():
            if m["delta"] < -args.margin:
                gate_failures.append(
                    f"{plat}/{cat}: regression {m['delta']*100:.1f}pp exceeds "
                    f"-{args.margin*100:.0f}pp margin"
                )

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    for plat, (ov_s, ov_k, _) in plat_metrics.items():
        sign = "+" if ov_k >= ov_s else ""
        print(
            f"  {plat:<8}  single {ov_s*100:.1f}%  stacked {ov_k*100:.1f}%  "
            f"delta {sign}{(ov_k-ov_s)*100:.1f}pp"
        )

    print()
    if gate_failures:
        print("GATE: FAIL")
        print("Reasons:")
        for f in gate_failures:
            print(f"  - {f}")
        sys.exit(2)
    else:
        print("GATE: PASS")
        sys.exit(0)


if __name__ == "__main__":
    main()
