"""Honest Smart Assign eval. Loads a cache + centroids + fixture split, runs the
contamination self-check, and prints the standing metrics (OSCR/AURC primary) + a
labeled deployment operating-point view. Run:
  ROOST_VAULT=<vault> python scripts/honest-eval.py --split dev --rejection maxsim
Centroids: --centroids production-centroids.json (real buildCategoryDefs) or 'mean'
(in-Python plain mean). Embeddings: --cache <name in .roost/build> or v2 (.bin).
External predictions: --predictions <predictions.json> scores an external file through
the same guards (lookup replaces the internal rank(); centroid+cache loading skipped)."""
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


def _platform_prefix(roost_id):
    """Return 'tiktok' or 'twitter' from the roost_id prefix, else 'other'."""
    if roost_id.startswith("tiktok:"):
        return "tiktok"
    if roost_id.startswith("twitter:"):
        return "twitter"
    return "other"


def _print_metrics(label, knowns, unknowns, rc_items, rejection_mode, op_r, op_lambda):
    """Print ACCURACY + OSCR + AUROC + AUPR + AURC for a given slice."""
    acc = sum(1 for c, _ in knowns if c) / len(knowns) if knowns else float("nan")
    print(f"  [{label}] ACCURACY (top-1) = {acc:.4f}  ({sum(1 for c,_ in knowns if c)}/{len(knowns)})")
    if rejection_mode == "none":
        print(f"  [{label}] NOTE: --rejection none has no rejection signal; OSCR/AURC/AUROC/AUPR omitted.")
        if unknowns:  # operating_point divides by len(unknowns); guard empty-OOD slices (e.g. a platform split)
            op = L.operating_point(knowns, unknowns, 0.5, op_r, op_lambda)
            print(f"  [{label}] DEPLOY-VIEW (λ={op_lambda}, r={op_r}): accept-all={op:.3f}")
        return
    if not unknowns:
        print(f"  [{label}] NOTE: no unknowns in this slice; OSCR/AUROC/AUPR skipped.")
        return
    oscr_v = L.oscr(knowns, unknowns)
    auroc_v = L.auroc(knowns, unknowns)
    aupr_v = L.aupr(knowns, unknowns)
    aurc_v, _curve = L.risk_coverage(rc_items)
    print(f"  [{label}] PRIMARY  OSCR  = {oscr_v:.4f}  (area under CCR-FPR, higher better)")
    print(f"  [{label}] PRIMARY  AUROC = {auroc_v:.4f}  (ROC AUC ID vs OOD, higher better)")
    print(f"  [{label}] PRIMARY  AUPR  = {aupr_v:.4f}  (PR AUC in-dist positive, higher better)")
    print(f"  [{label}] PRIMARY  AURC  = {aurc_v:.4f}  (area under risk-coverage, lower better)")
    all_s = np.array([s for _, s in knowns] + unknowns)
    taus = np.quantile(all_s, np.linspace(0, 1, 41))
    best = max((L.operating_point(knowns, unknowns, t, op_r, op_lambda), t) for t in taus)
    accept_all = L.operating_point(knowns, unknowns, all_s.min() - 1, op_r, op_lambda)
    reject_all = L.operating_point(knowns, unknowns, all_s.max() + 1, op_r, op_lambda)
    print(f"  [{label}] DEPLOY-VIEW (λ={op_lambda}, r={op_r}): best={best[0]:.3f} @tau={best[1]:.3f} "
          f"| accept-all={accept_all:.3f} reject-all={reject_all:.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="dev", choices=["dev", "holdout", "large"])
    ap.add_argument("--cache", default="v2")  # 'v2' = vault .bin; else inline json in build/
    ap.add_argument("--centroids", default="production-centroids.json")  # or 'mean'
    ap.add_argument("--rejection", default="maxsim", choices=["maxsim", "none"])
    ap.add_argument("--op-lambda", type=float, default=0.5)
    ap.add_argument("--op-r", type=float, default=0.30)
    ap.add_argument("--predictions", default=None,
                    help="Path to external predictions.json ({id:{pred,score,...}}). "
                         "When set: scores from this file replace the internal rank(); "
                         "centroid+cache loading is skipped. Items missing from the file "
                         "are skipped.")
    ap.add_argument("--by-platform", action="store_true",
                    help="Additionally split results by roost_id prefix (tiktok/twitter) "
                         "and print per-platform top-1 ACCURACY + OSCR/AUROC/AUPR.")
    args = ap.parse_args()

    vault = os.environ["ROOST_VAULT"]
    build = os.path.join(vault, ".roost", "build")

    # ── Predictions mode: load external file; skip centroid+cache loading ────
    ext_preds = None
    if args.predictions is not None:
        with open(args.predictions, encoding="utf-8") as fh:
            ext_preds = json.load(fh)
        cache = {}  # not used in predictions mode
        cnames = []
        C = None
    else:
        # ── Standard mode: load cache + centroids ────────────────────────────
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
            # honor build_centroids' contract: post-exclusion members must not leak the fixture
            L.assert_no_fixture_leak([i for ms in members.values() for i, _ in ms if i not in fixture_ids], fixture_ids)
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

    # self-check (run by default, regardless of predictions mode). large == dev ∪ holdout by
    # construction, so we assert the only meaningful disjointness: dev ∩ holdout == ∅.
    L.assert_gt_not_roost_category("collection")
    L.assert_disjoint([t["id"] for t in L.load_fixture(build, "dev")],
                      [t["id"] for t in L.load_fixture(build, "holdout")])

    items = L.load_fixture(build, args.split)
    knowns, unknowns, rc_items, skipped = [], [], [], 0

    # Per-platform accumulators (used when --by-platform is set)
    plat_knowns = {}; plat_unknowns = {}; plat_rc = {}

    for it in items:
        if ext_preds is not None:
            # ── predictions mode: look up from external file ─────────────────
            entry = ext_preds.get(it["id"])
            if entry is None:
                skipped += 1
                continue
            pred = entry["pred"]
            score = float(entry["score"])
        else:
            # ── standard mode: look up cache, run rank() ─────────────────────
            v = cache.get(it["id"])
            if v is None:
                skipped += 1  # no cached embedding (stale cache) — not scored
                continue
            pred, score = rank(v, cnames, C)

        if args.rejection == "none":
            score = 1.0

        if it["isNegative"]:
            unknowns.append(score)
            rc_items.append((1, score))
        else:
            correct = pred == it["groundTruth"]
            knowns.append((correct, score))
            rc_items.append((0 if correct else 1, score))

        if args.by_platform:
            plat = _platform_prefix(it["id"])
            plat_knowns.setdefault(plat, [])
            plat_unknowns.setdefault(plat, [])
            plat_rc.setdefault(plat, [])
            if it["isNegative"]:
                plat_unknowns[plat].append(score)
                plat_rc[plat].append((1, score))
            else:
                plat_knowns[plat].append((correct, score))
                plat_rc[plat].append((0 if correct else 1, score))

    # ── Header ───────────────────────────────────────────────────────────────
    preds_label = f"predictions={args.predictions}" if ext_preds is not None else f"cache={args.cache} centroids={args.centroids}"
    print(f"=== honest-eval | split={args.split} {preds_label} "
          f"rejection={args.rejection} | knowns={len(knowns)} unknowns={len(unknowns)} skipped={skipped} ===")

    # ── Overall metrics ──────────────────────────────────────────────────────
    acc = sum(1 for c, _ in knowns if c) / len(knowns) if knowns else float("nan")
    print(f"  ACCURACY (top-1, no rejection) = {acc:.4f}  ({sum(1 for c,_ in knowns if c)}/{len(knowns)})")
    if args.rejection == "none":
        print("  NOTE: --rejection none has no rejection signal; OSCR/AURC/AUROC/AUPR omitted (use --rejection maxsim).")
        op = L.operating_point(knowns, unknowns, 0.5, args.op_r, args.op_lambda)
        print(f"  DEPLOY-VIEW (λ={args.op_lambda}, r={args.op_r}): accept-all={op:.3f}")
    else:
        print(f"  PRIMARY  OSCR  = {L.oscr(knowns, unknowns):.4f}  (area under CCR-FPR, higher better)")
        print(f"  PRIMARY  AUROC = {L.auroc(knowns, unknowns):.4f}  (ROC AUC ID vs OOD, higher better)")
        print(f"  PRIMARY  AUPR  = {L.aupr(knowns, unknowns):.4f}  (PR AUC in-dist positive, higher better)")
        aurc, _curve = L.risk_coverage(rc_items)
        print(f"  PRIMARY  AURC  = {aurc:.4f}  (area under risk-coverage, lower better)")
        all_s = np.array([s for _, s in knowns] + unknowns)
        taus = np.quantile(all_s, np.linspace(0, 1, 41))
        # ties broken by tau (2nd tuple element) → picks the higher/more-conservative threshold.
        best = max((L.operating_point(knowns, unknowns, t, args.op_r, args.op_lambda), t) for t in taus)
        accept_all = L.operating_point(knowns, unknowns, all_s.min() - 1, args.op_r, args.op_lambda)
        reject_all = L.operating_point(knowns, unknowns, all_s.max() + 1, args.op_r, args.op_lambda)
        print(f"  DEPLOY-VIEW (λ={args.op_lambda}, r={args.op_r}): best={best[0]:.3f} @tau={best[1]:.3f} "
              f"| accept-all={accept_all:.3f} reject-all={reject_all:.3f}")

    # ── Per-platform breakdown (--by-platform) ────────────────────────────────
    if args.by_platform:
        all_plats = sorted(set(list(plat_knowns.keys()) + list(plat_unknowns.keys())))
        print(f"\n--- by-platform breakdown ---")
        for plat in all_plats:
            pk = plat_knowns.get(plat, [])
            pu = plat_unknowns.get(plat, [])
            pr = plat_rc.get(plat, [])
            if not pk:
                print(f"  [{plat}] no knowns — skipping")
                continue
            _print_metrics(plat, pk, pu, pr, args.rejection, args.op_r, args.op_lambda)

if __name__ == "__main__":
    main()
