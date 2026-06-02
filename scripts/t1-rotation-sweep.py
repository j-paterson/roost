#!/usr/bin/env python3
"""T1 position-bias mitigation experiment.

Hypothesis: T1_letter degrades from K=5 (84/119) to K=7 (78/119) because
forced single-letter choice at high K exposes letter-position bias
(A-preference, or deterministic-order preference). If we rotate the
letter -> candidate assignment N times per item and majority-vote on the
underlying *candidate* (not the letter slot), the ensemble should:

  a) recover items lost to position-bias (proving bias is real), OR
  b) stay flat (closing that branch).

Uses gemma4:e4b / T1_letter on the Phase F v2 hardneg cache.
Comparison baseline: `gemma4:e4b/T1_letter/phase4-t1k5-fixed` = 87/119
(the deployed K=5 T1 cell after Phase 4 label fixes).

Cost: N_ROTATIONS * 119 calls at ~0.5/s. Default N=5 -> ~20 min.

Every rotation is a random permutation of [0..K-1] -> [A..(A+K-1)].
Each underlying candidate collects votes across rotations. We evaluate:
  - plurality on underlying candidate (ties broken by embedding rank)
  - per-letter-slot distribution (to see if position bias is visible)
  - agreement with the deployed deterministic baseline

Results saved to .roost/t1-rotation-results.json
"""
import argparse
import json
import random
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import requests

# Reuse helpers from llm-rerank-sweep.py
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import importlib.util
spec = importlib.util.spec_from_file_location("llm_rerank_sweep", HERE / "llm-rerank-sweep.py")
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
OUT_PATH = ROOST / "t1-rotation-results.json"
PREV_RESULTS = ROOST / "llm-rerank-results.json"


def rotate_topk(topk, perm):
    """Apply permutation: returned[i] = topk[perm[i]].
    perm is a list of indices into topk. The candidate at returned[i]
    will be shown under letter ALL_LETTERS[i].
    """
    return [topk[p] for p in perm]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gemma4:e4b")
    ap.add_argument("--cache", default="embedding-cache-hardneg.json")
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--rotations", type=int, default=5,
                    help="Number of letter->candidate permutations per item")
    ap.add_argument("--seed", type=int, default=17)
    ap.add_argument("--limit", type=int, default=0, help="Smoke test: only N items")
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)

    top_k = args.top_k
    letters = list(rs.ALL_LETTERS[:top_k])
    num_predict = max(80, 30 + top_k * 20)
    cache_path = rs.resolve_cache_path(args.cache)

    print("T1 rotation sweep")
    print("=" * 60)
    print(f"Model:       {args.model}")
    print(f"Cache:       {cache_path}")
    print(f"top_k:       {top_k}")
    print(f"rotations:   {args.rotations}")
    print(f"num_predict: {num_predict}")

    cache = json.load(open(cache_path))
    results = json.load(open(rs.RESULTS_PATH))
    descriptions = json.load(open(rs.DESC_PATH))
    labels = rs.load_labels()

    members = defaultdict(list)
    for iid, coll in labels.items():
        if iid in cache and cache[iid].get("vec"):
            members[coll].append((iid, np.array(cache[iid]["vec"])))
    centroids = {c: np.mean([v for _, v in ms], axis=0) for c, ms in members.items() if ms}

    positive = [ti for ti in results["testItems"] if not ti["isNegative"]]
    items = rs.compute_topk(positive, cache, members, centroids, top_k)
    if args.limit:
        items = items[:args.limit]
    N = len(items)
    print(f"  {N} positive test items")

    in_topk = sum(1 for it in items if it["gt"] in it["topk"])
    print(f"  GT in top-{top_k}: {in_topk}/{N} ({in_topk/N*100:.1f}%)  <- oracle ceiling")

    # Load prior deterministic baseline picks for agreement stats
    prev = {}
    if PREV_RESULTS.exists():
        try:
            prev_all = json.load(open(PREV_RESULTS))
            cell = prev_all.get("gemma4:e4b/T1_letter/phase4-t1k5-fixed", {})
            for p in cell.get("picks", []):
                prev[p["id"]] = p
        except Exception:
            pass
    print(f"  Loaded {len(prev)} deterministic baseline picks for comparison")

    # Build template once
    tpl = rs.build_t1_template(top_k)
    parse = rs.make_parse_t1(letters)

    def desc_of(name):
        d = descriptions.get(name)
        return (d or name)[:300]

    # Sanity ping
    print("\nOllama ping...")
    ping = rs.call_ollama(args.model, "Reply with only the letter A.")
    print(f"  {args.model}: {ping.strip()[:80]!r}")

    # Generate R permutations that we reuse for every item. Each perm is a list
    # of indices into the topk array. Rotation 0 is the identity (matches deployed
    # deterministic baseline exactly), so we can cross-check against the previous
    # sweep's picks.
    R = args.rotations
    perms = [list(range(top_k))]  # identity first
    while len(perms) < R:
        p = list(range(top_k))
        random.shuffle(p)
        if p not in perms:
            perms.append(p)
    print(f"  Permutations: {perms}")

    picks_by_item = []
    letter_slot_totals = Counter()  # which letter position the model picks across all calls
    t_start = time.time()
    done = 0
    total_calls = N * R

    for i, item in enumerate(items):
        topk = list(item["topk"])
        while len(topk) < top_k:
            topk.append("(none)")

        per_rotation = []
        candidate_votes = Counter()  # underlying candidate -> count

        for r_idx, perm in enumerate(perms):
            shown = rotate_topk(topk, perm)  # shown[letter_idx] = topk[perm[letter_idx]]
            prompt = rs.format_prompt(tpl, item["summary"], shown, desc_of)
            resp = rs.call_ollama(args.model, prompt, num_predict=num_predict)
            pick_letter = parse(resp)
            done += 1

            picked_candidate = None
            if pick_letter in letters:
                slot = letters.index(pick_letter)
                picked_candidate = shown[slot]
                candidate_votes[picked_candidate] += 1
                letter_slot_totals[pick_letter] += 1

            per_rotation.append({
                "perm": perm,
                "shown": shown,
                "pick_letter": pick_letter,
                "picked_candidate": picked_candidate,
                "raw": resp[:120],
            })

        # Plurality vote. Ties broken by embedding rank (lower topk index wins).
        if candidate_votes:
            max_votes = max(candidate_votes.values())
            tied = [c for c, v in candidate_votes.items() if v == max_votes]
            if len(tied) == 1:
                winner = tied[0]
            else:
                # Pick the one with the lowest original topk index
                winner = min(tied, key=lambda c: topk.index(c) if c in topk else 999)
        else:
            winner = None

        picks_by_item.append({
            "id": item["id"],
            "gt": item["gt"],
            "topk": topk,
            "rotations": per_rotation,
            "candidate_votes": dict(candidate_votes),
            "plurality": winner,
        })

        if (i + 1) % 10 == 0 or (i + 1) == N:
            elapsed = time.time() - t_start
            rate = done / elapsed if elapsed else 0
            remaining = total_calls - done
            eta_min = (remaining / rate / 60) if rate else 0
            acc = sum(1 for p in picks_by_item if p["plurality"] == p["gt"])
            print(f"  {i+1}/{N}  plurality_acc={acc}/{i+1} ({acc/(i+1)*100:.0f}%)  "
                  f"rate={rate:.1f}/s  ETA={eta_min:.0f}min")

    # ---------- Analysis ----------
    plurality_correct = sum(1 for p in picks_by_item if p["plurality"] == p["gt"])

    # Identity-rotation-only accuracy (should match deterministic baseline)
    ident_correct = 0
    ident_diffs = 0
    for p in picks_by_item:
        r0 = p["rotations"][0]  # identity
        if r0["picked_candidate"] == p["gt"]:
            ident_correct += 1
        prev_p = prev.get(p["id"])
        if prev_p and prev_p.get("picked_coll") != r0["picked_candidate"]:
            ident_diffs += 1

    # Per-rotation individual accuracy
    per_rot_acc = []
    for r_idx in range(R):
        c = sum(1 for p in picks_by_item if p["rotations"][r_idx]["picked_candidate"] == p["gt"])
        per_rot_acc.append(c)

    # Letter-slot distribution (should be uniform if no bias)
    total_letter_picks = sum(letter_slot_totals.values())
    letter_dist = {L: letter_slot_totals.get(L, 0) / total_letter_picks
                   for L in letters} if total_letter_picks else {}

    # Unanimity: how often all R rotations pick the same underlying candidate
    unanimous = 0
    unanimous_correct = 0
    split_items = 0
    rescued = 0   # plurality_correct=True but identity_correct=False
    broken  = 0   # plurality_correct=False but identity_correct=True
    for p in picks_by_item:
        votes = p["candidate_votes"]
        if votes and max(votes.values()) == R:
            unanimous += 1
            if p["plurality"] == p["gt"]:
                unanimous_correct += 1
        else:
            split_items += 1
        id_correct = (p["rotations"][0]["picked_candidate"] == p["gt"])
        plu_correct = (p["plurality"] == p["gt"])
        if plu_correct and not id_correct:
            rescued += 1
        if id_correct and not plu_correct:
            broken += 1

    print("\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)
    print(f"  Plurality-vote accuracy:      {plurality_correct}/{N} ({plurality_correct/N*100:.1f}%)")
    print(f"  Identity-rotation accuracy:   {ident_correct}/{N} ({ident_correct/N*100:.1f}%)")
    print(f"  Deterministic baseline (prev): 87/119 (73.1%)  [phase4-t1k5-fixed]")
    print(f"  Identity vs prev baseline diffs: {ident_diffs}")
    print()
    print(f"  Per-rotation individual accuracy:")
    for r_idx, c in enumerate(per_rot_acc):
        tag = " (identity)" if r_idx == 0 else ""
        print(f"    rot {r_idx} perm={perms[r_idx]}: {c}/{N} ({c/N*100:.1f}%){tag}")
    print()
    print(f"  Rescued (plurality correct, identity wrong): {rescued}")
    print(f"  Broken  (plurality wrong, identity correct): {broken}")
    print(f"  Net delta: {rescued - broken:+d}")
    print()
    print(f"  Unanimous items ({R}/{R} agree): {unanimous}/{N} ({unanimous/N*100:.1f}%)")
    print(f"    of which correct: {unanimous_correct}/{unanimous}")
    print(f"  Split items: {split_items}/{N}")
    print()
    if letter_dist:
        print(f"  Letter-slot pick distribution (uniform = {1/top_k:.2f} each):")
        for L in letters:
            bar = "#" * int(letter_dist[L] * 50)
            print(f"    {L}: {letter_dist[L]:.3f} {bar}")
    print("=" * 70)

    out = {
        "model": args.model,
        "cache": str(cache_path),
        "top_k": top_k,
        "rotations": R,
        "seed": args.seed,
        "perms": perms,
        "N": N,
        "plurality_correct": plurality_correct,
        "identity_correct": ident_correct,
        "per_rotation_correct": per_rot_acc,
        "rescued": rescued,
        "broken": broken,
        "unanimous": unanimous,
        "unanimous_correct": unanimous_correct,
        "letter_dist": letter_dist,
        "prev_baseline": {"cell": "gemma4:e4b/T1_letter/phase4-t1k5-fixed", "correct": 87, "total": 119},
        "ident_vs_prev_diffs": ident_diffs,
        "picks": picks_by_item,
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\nSaved to {OUT_PATH}")


if __name__ == "__main__":
    main()
