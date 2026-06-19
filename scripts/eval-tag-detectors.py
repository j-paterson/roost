#!/usr/bin/env python3
"""Phase A — apply the EXPORTED tag detectors and report the operating point.

Loads the shipped <vault>/.roost/cache/tag-detectors.json, runs the exact
forward pass the plugin will use (L2-norm -> W.x + b -> sigmoid -> threshold per
tag), and reports per-tag recall + precision-LOWER-BOUND + system tags/item on a
fixture split. This is the faithfulness reference for Phase B (the TS detector
must match this) and the standing check that the shipped weights still behave.

NOTE: precision-LB is pessimistic (single-label GT counts a correct SECONDARY tag
as FP), so it badly understates FACET tags (Humor, Spicy) that are usually
secondary. True precision comes from the LLM audit (audit-tag-precision workflow).

Run: ROOST_VAULT=<vault> python scripts/eval-tag-detectors.py [--split holdout]
"""
import argparse
import json
import os

import numpy as np
import honest_eval_lib as L


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="holdout", choices=["dev", "holdout", "large"])
    args = ap.parse_args()
    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        raise SystemExit("ROOST_VAULT not set")

    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    head = json.load(open(os.path.join(vault, ".roost", "cache", "tag-detectors.json")))
    tags = head["tags"]
    W = np.array(head["W"], np.float64)
    b = np.array(head["b"], np.float64)
    thr = np.array(head["thresholds"], np.float64)
    ti = {t: i for i, t in enumerate(tags)}

    fx = L.load_fixture(os.path.join(vault, ".roost", "build"), args.split)
    items = [(t["id"], t["groundTruth"]) for t in fx
             if not t.get("isNegative") and t["groundTruth"] in ti]

    fires_true = np.zeros(len(tags))   # detector fires AND tag is the (primary) GT
    fires_all = np.zeros(len(tags))    # detector fires
    gt_count = np.zeros(len(tags))
    gt_recovered = 0
    tags_per_item = []
    for iid, gt in items:
        v = cache.get(iid)
        if v is None:
            continue
        v = np.asarray(v, np.float64)
        n = np.linalg.norm(v)
        if n == 0:
            continue
        p = sigmoid(W @ (v / n) + b)
        fire = p >= thr
        tags_per_item.append(int(fire.sum()))
        gt_count[ti[gt]] += 1
        if fire[ti[gt]]:
            gt_recovered += 1
            fires_true[ti[gt]] += 1
        fires_all += fire

    print(f"split={args.split}  items={len(tags_per_item)}  tags={len(tags)} (v{head['version']})")
    print(f"{'tag':<18}{'n':>5}{'thr':>7}{'recall':>8}{'precLB':>8}")
    for t in sorted(tags):
        j = ti[t]
        rec = fires_true[j] / gt_count[j] if gt_count[j] else 0
        prc = fires_true[j] / fires_all[j] if fires_all[j] else 0
        print(f"{t:<18}{int(gt_count[j]):>5}{thr[j]:>7.3f}{rec:>8.2f}{prc:>8.2f}")
    n = len(tags_per_item)
    print(f"\nsystem: avg tags/item {np.mean(tags_per_item):.2f}  | 0-tag {100*np.mean(np.array(tags_per_item)==0):.0f}%"
          f"  | GT recovered {100*gt_recovered/n:.0f}%")
    print("(precLB pessimistic for facet tags; true precision via the LLM audit)")


if __name__ == "__main__":
    main()
