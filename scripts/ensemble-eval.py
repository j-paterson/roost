#!/usr/bin/env python3
"""Compute production ensemble accuracy on the 119-item test set from
llm-rerank-results.json cells.

Production rule (matches src/pipeline/evaluate.ts:529-559):
  - T1 letter pick over top 5 candidates (K=5)
  - T2 JSON pick over top 7 candidates (K=7)
  - Agree → final = picked candidate
  - Disagree → smaller index wins (top-1 over top-2 over top-3+)
  - Conditional reject: if disagree AND picked_sim < 0.87 → UNMATCHED
  - On a positive-only test set, UNMATCHED counts as INCORRECT.

Both T1 and T2 cells must be run with --tag matching this script's --tag arg.
The cells share top-K computation parameters (alpha, cache, vault state) only
if they were produced from the same sweep invocation context.

Usage:
  ensemble-eval.py [--tag clip-fused] [--model gemma4:e4b]
"""
import argparse
import json
from pathlib import Path

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
RESULTS_PATH = ROOST / "llm-rerank-results.json"
FIXTURE_V2 = ROOST / "strategy-results-v2.json"
FIXTURE_V1 = ROOST / "strategy-results.json"
CONDITIONAL_REJECT_THRESHOLD = 0.87


def load_fixture_ids(fixture_arg):
    """Return set of item IDs to score against. Default: v2 if present, else v1.
    'v1' / 'v2' / 'all' shortcuts; otherwise treat as filename in .roost."""
    if fixture_arg in ("all", None, ""):
        return None
    if fixture_arg == "v2":
        path = FIXTURE_V2
    elif fixture_arg == "v1":
        path = FIXTURE_V1
    else:
        path = ROOST / fixture_arg
    if not path.exists():
        raise SystemExit(f"fixture not found: {path}")
    fix = json.load(open(path))
    return {t["id"] for t in fix["testItems"]}


def cell_key(model, template, tag):
    return f"{model}/{template}/{tag}" if tag else f"{model}/{template}"


def load_cell(results, model, template, tag):
    key = cell_key(model, template, tag)
    if key not in results:
        raise SystemExit(f"missing cell: {key}")
    return results[key]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gemma4:e4b")
    ap.add_argument("--tag", default="clip-fused")
    ap.add_argument("--threshold", type=float, default=CONDITIONAL_REJECT_THRESHOLD)
    ap.add_argument("--fixture", default="v2",
                    help="Which test fixture to score against. 'v2' (default, "
                         "patched 106-item set), 'v1' (legacy 119-item set), "
                         "'all' (intersect both cells without fixture filter), "
                         "or a filename under .roost/.")
    args = ap.parse_args()

    results = json.load(open(RESULTS_PATH))
    t1 = load_cell(results, args.model, "T1_letter", args.tag)
    t2 = load_cell(results, args.model, "T2_json", args.tag)

    t1_picks = {p["id"]: p for p in t1["picks"]}
    t2_picks = {p["id"]: p for p in t2["picks"]}

    fixture_ids = load_fixture_ids(args.fixture)
    if fixture_ids is not None:
        ids = sorted((set(t1_picks) & set(t2_picks)) & fixture_ids)
    else:
        ids = sorted(set(t1_picks) & set(t2_picks))
    n = len(ids)
    print(f"model={args.model}  tag={args.tag}  threshold={args.threshold}")
    print(f"items in both cells: {n} (T1={len(t1_picks)}  T2={len(t2_picks)})")

    correct = 0
    rejected = 0
    parse_fail = 0
    agree = 0
    a_wins = 0  # T1 wins (smaller top-K index in T1's K=5 ballot)
    b_wins = 0
    a_only = 0
    b_only = 0
    perItem = []

    for iid in ids:
        a = t1_picks[iid]
        b = t2_picks[iid]
        gt = a["gt"]
        if a.get("is_negative") or b.get("is_negative"):
            continue  # 119-item positive set only

        # T1 ballot is K=5; its picked_coll is one of top-5.
        # T2 ballot is K=7; its picked_coll is one of top-7.
        # Production uses top-7 indices for arbitration (smaller index wins).
        top7 = b["topk"]  # T2's top-7 list IS the canonical top-7 ordering
        a_pick = a.get("picked_coll")
        b_pick = b.get("picked_coll")

        a_idx = top7.index(a_pick) if a_pick in top7 else None
        b_idx = top7.index(b_pick) if b_pick in top7 else None

        decision = "fail"
        final_pick = None
        final_idx = None

        if a_idx is not None and b_idx is not None:
            if a_idx == b_idx:
                final_idx = a_idx
                decision = "agree"
                agree += 1
            elif a_idx < b_idx:
                final_idx = a_idx
                decision = "a_wins"
                a_wins += 1
            else:
                final_idx = b_idx
                decision = "b_wins"
                b_wins += 1
            final_pick = top7[final_idx]
        elif a_idx is not None:
            final_idx = a_idx
            final_pick = top7[final_idx]
            decision = "a_only"
            a_only += 1
        elif b_idx is not None:
            final_idx = b_idx
            final_pick = top7[final_idx]
            decision = "b_only"
            b_only += 1
        else:
            parse_fail += 1
            decision = "fail"

        # Production-equivalent picked_sim: top7_sims at the chosen index.
        # T2 has top7_sims; T1's topk_sims only covers K=5.
        picked_sim = b["topk_sims"][final_idx] if final_idx is not None and final_idx < len(b["topk_sims"]) else 0.0
        disagreed = decision in ("a_wins", "b_wins")
        conditional_reject = disagreed and picked_sim < args.threshold

        if decision == "fail" or conditional_reject:
            rejected += 1
            is_correct = False
        else:
            is_correct = (final_pick == gt)
            if is_correct:
                correct += 1

        perItem.append({
            "id": iid,
            "gt": gt,
            "t1": a_pick,
            "t2": b_pick,
            "final": final_pick,
            "decision": decision,
            "picked_sim": picked_sim,
            "rejected": conditional_reject or decision == "fail",
            "correct": is_correct,
        })

    acc = correct / n if n else 0.0
    print()
    print(f"Decisions: agree={agree}  a_wins={a_wins}  b_wins={b_wins}  a_only={a_only}  b_only={b_only}  parse_fail={parse_fail}")
    print(f"Rejected (parse-fail OR disagree+sim<{args.threshold}): {rejected}")
    print(f"Accuracy: {correct}/{n} = {acc*100:.1f}%")

    # Compare to legacy 88/119 = 73.9%
    print(f"  (Apr 10 baseline: 88/119 = 73.9%)")

    out_path = ROOST / f"ensemble-eval-{args.tag or 'untagged'}.json"
    json.dump({
        "model": args.model,
        "tag": args.tag,
        "threshold": args.threshold,
        "n": n,
        "correct": correct,
        "accuracy": acc,
        "rejected": rejected,
        "decisions": {
            "agree": agree, "a_wins": a_wins, "b_wins": b_wins,
            "a_only": a_only, "b_only": b_only, "parse_fail": parse_fail,
        },
        "perItem": perItem,
    }, open(out_path, "w"), indent=2)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
