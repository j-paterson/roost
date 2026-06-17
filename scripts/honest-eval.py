"""Honest Smart Assign eval. Loads a cache + centroids + fixture split, runs the
contamination self-check, and prints the standing metrics (OSCR/AURC primary) + a
labeled deployment operating-point view. Run:
  ROOST_VAULT=<vault> python scripts/honest-eval.py --split dev --rejection maxsim
Centroids: --centroids production-centroids.json (real buildCategoryDefs) or 'mean'
(in-Python plain mean). Embeddings: --cache <name in .roost/build> or v2 (.bin)."""
import os, sys, argparse, json
import numpy as np
import honest_eval_lib as L

def rank(vec, cents_names, Cn):
    # Cn is pre-row-normalized float64; normalize vec → cosine = dot. float64 +
    # np.dot avoids NumPy 2.x's spurious matmul FPE flags on float32 `@` (the
    # inputs are finite & unit-norm; the warnings are a SIMD artifact, not real).
    vn = np.ascontiguousarray(vec, dtype=np.float64)
    vn = vn / (float(np.linalg.norm(vn)) + 1e-9)
    sims = np.dot(Cn, vn)
    i = int(np.argmax(sims))
    return cents_names[i], float(sims[i])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="dev", choices=["dev", "holdout", "large"])
    ap.add_argument("--cache", default="v2")  # 'v2' = vault .bin; else inline json in build/
    ap.add_argument("--centroids", default="production-centroids.json")  # or 'mean'
    ap.add_argument("--rejection", default="maxsim", choices=["maxsim", "none"])
    ap.add_argument("--op-lambda", type=float, default=0.5)
    ap.add_argument("--op-r", type=float, default=0.30)
    args = ap.parse_args()
    vault = os.environ["ROOST_VAULT"]; build = os.path.join(vault, ".roost", "build")

    if args.cache == "v2":
        cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    else:
        cache = L.load_cache(json_path=os.path.join(build, args.cache))

    fixture_ids = {t["id"] for t in L.load_fixture(build, "large")}  # large == dev ∪ holdout (full fixture)
    if args.centroids == "mean":
        labels, _ = L.load_honest_labels(vault)
        members = {}
        for i, coll in labels.items():
            if i in cache:
                members.setdefault(coll, []).append((i, cache[i]))
        cents = L.build_centroids(members, exclude_ids=fixture_ids)
    else:
        with open(os.path.join(build, args.centroids), encoding="utf-8") as fh:
            prod = json.load(fh)
        cents = {k: np.asarray(v["centroid"], dtype=np.float32) for k, v in prod.items()}
    cnames = list(cents)
    if not cnames:
        raise SystemExit(
            "No centroids: every member was excluded as a fixture item. The fixture covers "
            "100% of honest labels, so the in-Python '--centroids mean' path (honest labels "
            "only) is degenerate by construction. Use --centroids production-centroids.json "
            "(production candidate pool incl. auto items, fixture strictly held out)."
        )
    C = np.ascontiguousarray(np.stack([cents[c] for c in cnames]), dtype=np.float64)
    C = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)  # row-normalize once

    # self-check (run by default). large == dev ∪ holdout by construction, so we
    # assert the only meaningful disjointness: dev ∩ holdout == ∅.
    L.assert_gt_not_roost_category("collection")
    L.assert_disjoint([t["id"] for t in L.load_fixture(build, "dev")],
                      [t["id"] for t in L.load_fixture(build, "holdout")])

    items = L.load_fixture(build, args.split)
    knowns, unknowns, rc_items, skipped = [], [], [], 0
    for it in items:
        v = cache.get(it["id"])
        if v is None:
            skipped += 1  # no cached embedding (stale cache) — not scored
            continue
        pred, score = rank(v, cnames, C)
        if args.rejection == "none":
            score = 1.0
        if it["isNegative"]:
            unknowns.append(score); rc_items.append((1, score))
        else:
            correct = pred == it["groundTruth"]
            knowns.append((correct, score)); rc_items.append((0 if correct else 1, score))

    acc = sum(1 for c, _ in knowns if c) / len(knowns) if knowns else float("nan")
    print(f"=== honest-eval | split={args.split} cache={args.cache} centroids={args.centroids} "
          f"rejection={args.rejection} | knowns={len(knowns)} unknowns={len(unknowns)} skipped={skipped} ===")
    print(f"  ACCURACY (top-1, no rejection) = {acc:.4f}  ({sum(1 for c,_ in knowns if c)}/{len(knowns)})")
    if args.rejection == "none":
        # All scores forced to 1.0 → no rejection signal; OSCR/AURC degenerate to a
        # single tied point and are not meaningful. Report accuracy + accept-all only.
        print("  NOTE: --rejection none has no rejection signal; OSCR/AURC omitted (use --rejection maxsim).")
        op = L.operating_point(knowns, unknowns, 0.5, args.op_r, args.op_lambda)  # accept-all (all scores==1.0)
        print(f"  DEPLOY-VIEW (λ={args.op_lambda}, r={args.op_r}): accept-all={op:.3f}")
        return
    print(f"  PRIMARY  OSCR = {L.oscr(knowns, unknowns):.4f}  (area under CCR-FPR, higher better)")
    aurc, _curve = L.risk_coverage(rc_items)
    print(f"  PRIMARY  AURC = {aurc:.4f}  (area under risk-coverage, lower better)")
    all_s = np.array([s for _, s in knowns] + unknowns)
    taus = np.quantile(all_s, np.linspace(0, 1, 41))
    # ties broken by tau (2nd tuple element) → picks the higher/more-conservative threshold.
    best = max((L.operating_point(knowns, unknowns, t, args.op_r, args.op_lambda), t) for t in taus)
    accept_all = L.operating_point(knowns, unknowns, all_s.min() - 1, args.op_r, args.op_lambda)
    reject_all = L.operating_point(knowns, unknowns, all_s.max() + 1, args.op_r, args.op_lambda)
    print(f"  DEPLOY-VIEW (λ={args.op_lambda}, r={args.op_r}): best={best[0]:.3f} @tau={best[1]:.3f} "
          f"| accept-all={accept_all:.3f} reject-all={reject_all:.3f}")

if __name__ == "__main__":
    main()
