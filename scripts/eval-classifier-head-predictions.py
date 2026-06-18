#!/usr/bin/env python3
"""Apply an exported classifier-head.json to a fixture split and write predictions.

Forward pass: z = W · x_l2norm + b ; softmax ; argmax = pred, max-prob = score.

Writes <vault>/.roost/build/predictions-classifier-head.json in the standard
predictions format ({id: {pred: str, score: float}}) consumed by honest-eval.py.

Run:
  ROOST_VAULT=<vault> python scripts/eval-classifier-head-predictions.py [--split holdout]

Then score with honest-eval.py:
  ROOST_VAULT=<vault> python scripts/honest-eval.py \\
      --split holdout \\
      --predictions <vault>/.roost/build/predictions-classifier-head.json \\
      --by-platform
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import honest_eval_lib as L


def l2_normalize_row(v):
    """L2-normalize a single 1-D vector in place and return it."""
    n = float(np.linalg.norm(v))
    if n == 0.0:
        return v
    return v / n


def softmax(z):
    """Numerically stable softmax over a 1-D array."""
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def forward(W, b, x_raw):
    """Compute softmax(W · l2norm(x) + b) and return (pred_class_idx, max_prob).

    W : (C, D) float array
    b : (C,)   float array
    x_raw : (D,) float array — raw (un-normalised) embedding
    """
    x = l2_normalize_row(np.asarray(x_raw, dtype=np.float64))
    W64 = np.asarray(W, dtype=np.float64)
    b64 = np.asarray(b, dtype=np.float64)
    z = W64 @ x + b64          # (C,)
    probs = softmax(z)          # (C,)
    idx = int(np.argmax(probs))
    return idx, float(probs[idx])


def main():
    ap = argparse.ArgumentParser(
        description="Apply classifier-head.json to a fixture split → predictions JSON."
    )
    ap.add_argument(
        "--split", default="holdout", choices=["dev", "holdout", "large"],
        help="Fixture split to score (default: holdout).",
    )
    ap.add_argument(
        "--head", default=None,
        help="Path to classifier-head.json (default: <vault>/.roost/cache/classifier-head.json).",
    )
    ap.add_argument(
        "--out", default=None,
        help="Output path (default: <vault>/.roost/build/predictions-classifier-head.json).",
    )
    args = ap.parse_args()

    vault_env = os.environ.get("ROOST_VAULT")
    if vault_env:
        VAULT = Path(vault_env)
    else:
        VAULT = Path.home() / "ObsidianBookmarks"

    ROOST = VAULT / ".roost"
    BUILD_DIR = ROOST / "build"
    BIN_CACHE = ROOST / "cache" / "embedding-vectors.bin"

    head_path = Path(args.head) if args.head else ROOST / "cache" / "classifier-head.json"
    out_path = Path(args.out) if args.out else BUILD_DIR / "predictions-classifier-head.json"

    # ── Load classifier head weights ──────────────────────────────────────────
    if not head_path.exists():
        sys.exit(f"ERROR: classifier-head.json not found at {head_path}\n"
                 "Run scripts/train-classifier-head.py first.")
    with open(head_path, encoding="utf-8") as fh:
        head = json.load(fh)

    classes = head["classes"]          # list[str], length C
    W = np.asarray(head["W"], dtype=np.float64)    # (C, 768)
    b = np.asarray(head["b"], dtype=np.float64)    # (C,)
    dim = int(head["dim"])
    norm = head.get("norm", "l2")
    version = head.get("version", 1)

    C = len(classes)
    assert W.shape == (C, dim), f"W shape mismatch: expected ({C}, {dim}), got {W.shape}"
    assert b.shape == (C,), f"b shape mismatch: expected ({C},), got {b.shape}"
    assert norm == "l2", f"Unsupported norm '{norm}' — only 'l2' is supported"

    print(f"Classifier head: version={version}  classes={C}  dim={dim}  "
          f"trainedOn={head.get('trainedOn', '?')} items")
    print(f"Vault:      {VAULT}")
    print(f"Head:       {head_path}")
    print(f"Split:      {args.split}")
    print(f"Cache:      {BIN_CACHE}")
    print(f"Output:     {out_path}")
    print()

    # ── Contamination guard ───────────────────────────────────────────────────
    L.assert_gt_not_roost_category("collection")
    dev_ids = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "dev")]
    hld_ids = [t["id"] for t in L.load_fixture(str(BUILD_DIR), "holdout")]
    L.assert_disjoint(dev_ids, hld_ids)

    # ── Load embedding cache ──────────────────────────────────────────────────
    cache = L.load_cache(bin_path=str(BIN_CACHE))
    print(f"Embedding cache: {len(cache)} items")

    # ── Load fixture items for the requested split ────────────────────────────
    items = L.load_fixture(str(BUILD_DIR), args.split)
    print(f"Fixture items ({args.split}): {len(items)}")

    # ── Apply forward pass ────────────────────────────────────────────────────
    predictions = {}
    n_scored = 0
    n_missing = 0
    n_skip_nan = 0
    n_skip_zero = 0

    for it in items:
        iid = it["id"]
        v = cache.get(iid)
        if v is None:
            n_missing += 1
            continue
        v = np.asarray(v, dtype=np.float64)
        if not np.all(np.isfinite(v)):
            n_skip_nan += 1
            continue
        if float(np.linalg.norm(v)) == 0.0:
            n_skip_zero += 1
            continue

        pred_idx, score = forward(W, b, v)
        predictions[iid] = {
            "pred": classes[pred_idx],
            "score": score,
        }
        n_scored += 1

    n_total = len(items)
    skipped = n_missing + n_skip_nan + n_skip_zero
    print(f"Scored: {n_scored}/{n_total}  "
          f"(skipped: {n_missing} missing, {n_skip_nan} NaN/inf, {n_skip_zero} zero-norm)")

    if n_scored == 0:
        sys.exit("ERROR: no items scored — check embedding cache and fixture.")

    # ── Write output ──────────────────────────────────────────────────────────
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(predictions, fh, indent=2)
    print(f"Written: {out_path}")
    print()
    print("Next step — score with honest-eval.py:")
    print(f"  ROOST_VAULT={VAULT} python scripts/honest-eval.py \\")
    print(f"      --split {args.split} \\")
    print(f"      --predictions {out_path} \\")
    print(f"      --by-platform")


if __name__ == "__main__":
    main()
