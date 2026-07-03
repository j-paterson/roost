"""Fresh, provenance-audited evaluation of production open-set rejection.
Held-out by construction: train on --train-split, evaluate on --eval-split.
Signals: S1 production cascade (head-conf->centroid at config taus), S2 head-conf
with tau swept, S3 RelMahalanobis. Metrics: per-category LOO OOD AUROC (headline) /
OSCR-vs-gold (trusted, omitted if gold review pending) / unlabeled accept-rate (caveated).
Writes a Markdown report. Measurement only — no production writes.

Run: ROOST_VAULT=<vault> caffeinate -i python scripts/exp-rejection-fresh.py \
       --train-split dev --eval-split holdout [--smoke]

NEGATIVES POLICY (authoritative 2026-07-03):
- Trusted OSCR/AURC computed ONLY against (a) gold set (load_gold) or (b) LOO OOD.
- Gold set likely empty → OSCR-vs-gold omitted with "gold review pending" note.
- Per-category leave-one-out OOD AUROC is the HEADLINE open-set metric.
- unlabeled_pool used ONLY for caveated accept-rate; never fed to oscr/auroc/risk_coverage.
- fixture isNegative items NOT used for any metric.
- Provenance includes negatives composition to explain why pool is diagnostic-only."""
import os, json, argparse, glob
import numpy as np
import honest_eval_lib as L
import rej_provenance as P
import rej_signals as S
import rej_negatives as N

HEAD_TAU, CENT_TAU = 0.6149, 0.50  # mirror packages/core/src/config.ts


def split_scores(known_rows, unknown_rows):
    """known_rows: [(id, correct: bool, score)] ; unknown_rows: [(id, score)].
    Returns (knowns=[(correct,score)], unknowns=[score]) for honest_eval_lib metrics."""
    return [(c, s) for _, c, s in known_rows], [s for _, s in unknown_rows]


def _s1(clf, classes, cents, cache, rid):
    """Named wrapper: (pred, accept_score) from the production cascade."""
    pred, score, _tier = S.cascade_accept_score(clf, classes, cents, cache, rid, HEAD_TAU, CENT_TAU)
    return pred, score


def _known_rows(eval_items, cache, pred_fn):
    """Score eval positives only (skip isNegative items and missing embeddings).
    pred_fn(id) -> (pred_or_None, accept_score). correct = pred == groundTruth."""
    rows = []
    for it in eval_items:
        if it.get("isNegative") or not it.get("groundTruth") or cache.get(it["id"]) is None:
            continue
        pred, score = pred_fn(it["id"])
        rows.append((it["id"], pred == it["groundTruth"], score))
    return rows


def _negatives_composition(vault, sync_folder="Bookmarks"):
    """Scan vault notes to characterise the no-collection pool.
    Reports: total_no_collection; how many carry roost_category (system-sorted,
    NOT truly unfiled); untouched (neither collection nor roost_category).
    This composition explains why the unlabeled pool is diagnostic-only: the
    verified ~81% with roost_category are NOT out-of-distribution items."""
    total_no_coll = has_roost_cat = untouched = 0
    for p in glob.glob(os.path.join(vault, sync_folder, "**", "*.md"), recursive=True):
        fm = L._read_fm(p)
        if not fm.get("roost_id"):
            continue
        coll = fm.get("collection", "")
        if not coll or coll in ("undefined", "null", ""):
            total_no_coll += 1
            if fm.get("roost_category"):
                has_roost_cat += 1
            else:
                untouched += 1
    pct = round(100 * has_roost_cat / max(total_no_coll, 1), 1)
    return {
        "total_no_collection": total_no_coll,
        "has_roost_category": has_roost_cat,
        "untouched_pool": untouched,
        "pct_system_sorted": pct,
    }


def _unlabeled_accept_rates(pool_ids, clf, classes, cents, cache, relmaha_fn):
    """Fraction of the untouched unlabeled pool each signal would accept at its
    production threshold. NOT ground truth — purely diagnostic. Never fed to
    oscr/auroc/risk_coverage."""
    if not pool_ids:
        return {"n_pool": 0, "note": "pool is empty"}
    n = len(pool_ids)
    s1_accepted = s2_accepted = 0
    s3_scores = []
    for rid in pool_ids:
        _, _, tier = S.cascade_accept_score(clf, classes, cents, cache, rid, HEAD_TAU, CENT_TAU)
        if tier != "reject":
            s1_accepted += 1
        _, conf = S.head_conf(clf, classes, cache, rid)
        if conf >= HEAD_TAU:
            s2_accepted += 1
        s3_scores.append(float(relmaha_fn(rid)))
    return {
        "n_pool": n,
        "NOT_ground_truth": True,
        "S1_cascade_accept_rate": round(s1_accepted / n, 4),
        "tau_S1": f"head>={HEAD_TAU} OR centroid>={CENT_TAU}",
        "S2_headconf_accept_rate": round(s2_accepted / n, 4),
        "tau_S2": HEAD_TAU,
        "S3_relmaha_median_score": round(float(np.median(s3_scores)), 4) if s3_scores else None,
        "S3_note": "no production tau defined for RelMaha; median shown for context only",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-split", default="dev")
    ap.add_argument("--eval-split", default="holdout")
    ap.add_argument("--smoke", action="store_true", help="1-item end-to-end check; skip full run")
    args = ap.parse_args()
    vault = os.environ["ROOST_VAULT"]
    build = os.path.join(vault, ".roost", "build")
    binp = os.path.join(vault, ".roost", "cache", "embedding-vectors.bin")

    # ── Provenance preflight ──
    inputs = {
        "fixture_train": os.path.join(build, f"eval-fixture-{args.train_split}.json"),
        "fixture_eval": os.path.join(build, f"eval-fixture-{args.eval_split}.json"),
        "embeddings_bin": binp,
        "aliases": os.path.join(vault, ".roost", "cache", "collection-aliases.json"),
    }
    prov = P.build_block(
        vault, inputs,
        repo_root=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    cache = L.load_cache(bin_path=binp)
    train = L.load_fixture(build, args.train_split)
    ev = L.load_fixture(build, args.eval_split)
    L.assert_disjoint([t["id"] for t in train], [t["id"] for t in ev])

    sample = [it["id"] for it in ev if not it.get("isNegative")][:1 if args.smoke else 5]
    fresh = P.verify_embeddings_fresh(vault, sample)
    prov["_embeddings_fresh"] = fresh
    assert fresh["ok"], "freshness check verified 0 items — embedding-cache.json missing text or sidecar returned nothing"
    prov["_sidecar_model"] = P.sidecar_model_stamp(vault)

    if args.smoke:
        clf, classes = S.train_head(train, cache)
        rid = sample[0]
        pred, conf = S.head_conf(clf, classes, cache, rid)
        print(f"[smoke] {rid}: head pred={pred} conf={conf:.3f}; embeddings_fresh={fresh}")
        return

    # ── Negatives composition for provenance ──
    print("Computing negatives composition...")
    neg_comp = _negatives_composition(vault)
    prov["_negatives_composition"] = neg_comp
    print(f"  no-collection total={neg_comp['total_no_collection']}; "
          f"has_roost_category={neg_comp['has_roost_category']} "
          f"({neg_comp['pct_system_sorted']}%); "
          f"untouched={neg_comp['untouched_pool']}")

    # ── Train held-out head + centroids on the TRAIN split ──
    print("Training head classifier on train split...")
    clf, classes = S.train_head(train, cache)
    cats = sorted({it["groundTruth"] for it in train
                   if not it.get("isNegative") and it["groundTruth"]
                   and it["groundTruth"].lower() not in L.RESERVED_NON_CATEGORIES})
    cents = L.build_centroids(
        {c: [(it["id"], cache[it["id"]]) for it in train
             if it["groundTruth"] == c and cache.get(it["id"]) is not None]
         for c in cats},
        exclude_ids=[it["id"] for it in ev])
    L.assert_no_fixture_leak(
        [it["id"] for it in train if not it.get("isNegative")],
        [it["id"] for it in ev])
    relmaha = S.rel_mahalanobis(train, cache)

    # ── Load trusted gold set (may be empty — review pending) ──
    # vault= enables live frontmatter scan for roost_belongs_nothing: true stamps
    gold_ids = [g for g in N.load_gold(build, vault=vault) if cache.get(g) is not None]
    if not gold_ids:
        print("NOTE: gold set (belongs-nothing-gold.json) not yet created — "
              "OSCR-vs-gold omitted (gold review pending).")

    # ── Load unlabeled pool — DIAGNOSTIC ONLY, never fed to oscr/auroc ──
    print("Loading unlabeled pool (diagnostic only)...")
    pool_ids = N.unlabeled_pool(vault, cache)
    print(f"  unlabeled pool size: {len(pool_ids)}")

    # ── Score signals on eval-split knowns ──
    def _s1_bound(i):
        return _s1(clf, classes, cents, cache, i)

    signals_fns = {
        "S1_cascade_prod": _s1_bound,
        "S2_headconf": lambda i: S.head_conf(clf, classes, cache, i),
        "S3_relmaha": lambda i: (None, relmaha(i)),
    }

    signal_results = {}
    for name, fn in signals_fns.items():
        print(f"Scoring {name} on eval split...")
        known_rows = _known_rows(ev, cache, fn)
        kn, _ = split_scores(known_rows, [])
        acc = round(sum(1 for c, _ in kn if c) / max(len(kn), 1), 4)

        entry = {
            "n_known": len(kn),
            "accuracy": acc,
            "n_gold": len(gold_ids),
            "n_unlabeled_pool": len(pool_ids),
        }

        # Trusted OSCR/AURC only if gold set exists
        if gold_ids:
            gold_rows = [(i, fn(i)[1]) for i in gold_ids]
            kn2, un_gold = split_scores(known_rows, gold_rows)
            entry["oscr_vs_gold"] = round(L.oscr(kn2, un_gold), 4)
            entry["aurc_vs_gold"] = round(
                L.risk_coverage(
                    [(0 if c else 1, s) for c, s in kn2] + [(1, s) for s in un_gold]
                )[0], 4)
        else:
            entry["oscr_vs_gold"] = "pending"
            entry["aurc_vs_gold"] = "pending"

        signal_results[name] = (entry, known_rows)

    # ── Unlabeled accept-rate (diagnostic, NOT ground truth) ──
    print("Computing unlabeled accept-rates (diagnostic)...")
    unlabeled_ar = _unlabeled_accept_rates(pool_ids, clf, classes, cents, cache, relmaha)

    # ── Per-category leave-one-out OOD AUROC — HEADLINE METRIC ──
    print("Computing per-category LOO OOD AUROC (headline)...")
    loo = {}
    for c in cats:
        train_wo, ood_ids = N.leave_one_out(train, ev, c)
        ood_ids = [i for i in ood_ids if cache.get(i) is not None]
        if len(ood_ids) < 3:
            print(f"  {c}: skipped (only {len(ood_ids)} OOD items)")
            continue
        clf_wo, cls_wo = S.train_head(train_wo, cache)
        other_eval = [it for it in ev
                      if not it.get("isNegative") and it.get("groundTruth") != c]
        kn_rows = _known_rows(other_eval, cache,
                              lambda i, _clf=clf_wo, _cls=cls_wo:
                              S.head_conf(_clf, _cls, cache, i))
        kn, _ = split_scores(kn_rows, [])
        un = [S.head_conf(clf_wo, cls_wo, cache, i)[1] for i in ood_ids]
        if kn and un:
            loo[c] = round(L.auroc(kn, un), 4)
            print(f"  {c}: LOO OOD AUROC = {loo[c]} ({len(ood_ids)} OOD, {len(kn)} known)")

    notes = [
        "OSCR/AURC vs gold: OMITTED — belongs-nothing-gold.json not yet created (gold review pending)."
        if not gold_ids else f"OSCR/AURC vs gold: computed on {len(gold_ids)} human-verified OOD items.",
        "Unlabeled accept-rate pool = items with NO `collection` AND NO `roost_category` (truly untouched). NOT ground-truth OOD.",
        f"~{neg_comp['pct_system_sorted']}% of no-collection items carry roost_category "
        f"(system-sorted, not truly unfiled) → pool is NOT trusted OOD ground truth.",
        "Per-category leave-one-out OOD AUROC is the headline open-set metric.",
        "fixture isNegative items not used for any metric.",
        "S3 RelMaha accuracy is always 0 (not a classifier; score used for OOD separation only).",
        "S2 τ-recalibration omitted — a τ sweep would need an OOD target; the unlabeled pool is contaminated (diagnostic-only), so proper recalibration requires the gold set or a LOO-based sweep (follow-up once gold is assembled).",
    ]

    report = {
        "provenance": prov,
        "signals": {name: e for name, (e, _) in signal_results.items()},
        "unlabeled_accept_rate_diagnostic": unlabeled_ar,
        "per_category_loo_ood_auroc": dict(sorted(loo.items(), key=lambda kv: kv[1])),
        "notes": notes,
    }

    out_path = _write_report(report)
    print(f"wrote report → {out_path}")


def _write_report(r):
    prov = r["provenance"]
    nc = prov.get("_negatives_composition", {})
    lines = [
        "# Fresh Rejection Eval — Results",
        "",
        "> Held-out: train split → eval split. GT = human collection. No cached model outputs.",
        "> **Headline open-set metric: per-category leave-one-out OOD AUROC.**",
        "> OSCR-vs-gold omitted — gold review pending (see Notes).",
        "",
        "## Provenance",
    ]
    for k, v in prov.items():
        if k.startswith("_"):
            continue
        lines.append(
            f"- **{k}**: mtime={v.get('mtime')}, "
            f"sha256={str(v.get('sha256', ''))[:16]}…, count={v.get('count')}"
        )
    lines.append(f"- **git_sha**: `{prov.get('_git_sha')}`")
    lines.append(f"- **embeddings_fresh**: `{json.dumps(prov.get('_embeddings_fresh'))}`")
    lines.append(f"- **models**: `{json.dumps(prov.get('_models'))}`")
    lines.append(f"- **sidecar_model**: `{json.dumps(prov.get('_sidecar_model'))}`")

    lines += [
        "",
        "### Negatives composition (why unlabeled pool is diagnostic-only)",
        f"- Total items with no `collection`: **{nc.get('total_no_collection')}**",
        f"- Of those, carrying `roost_category` (system-sorted, NOT truly unfiled): "
        f"**{nc.get('has_roost_category')}** ({nc.get('pct_system_sorted')}%)",
        f"- Truly untouched (no `collection`, no `roost_category`): **{nc.get('untouched_pool')}**",
        f"- Conclusion: ~{nc.get('pct_system_sorted')}% of no-collection items are "
        f"actually sorted by the system → pool is NOT trusted OOD ground truth.",
    ]

    lines += ["", "## Notes (governing metric interpretation)"]
    for note in r.get("notes", []):
        lines.append(f"- {note}")

    lines += [
        "",
        "## Per-category leave-one-out OOD AUROC ← HEADLINE open-set metric",
        "",
        "(ascending — low = category signal bleeds into OOD space; "
        "high = cleanly separable from all-other-categories head)",
        "",
        "| category | LOO OOD AUROC |",
        "|---|---|",
    ]
    for c, a in r["per_category_loo_ood_auroc"].items():
        lines.append(f"| {c} | {a} |")

    lines += [
        "",
        "## Reject signals — accuracy on eval-split knowns",
        "| signal | n_known | accuracy | OSCR vs gold | AURC vs gold | n_gold | n_unlabeled_pool |",
        "|---|---|---|---|---|---|---|",
    ]
    for name, e in r["signals"].items():
        lines.append(
            f"| {name} | {e['n_known']} | {e['accuracy']} | "
            f"{e.get('oscr_vs_gold', '—')} | {e.get('aurc_vs_gold', '—')} | "
            f"{e['n_gold']} | {e['n_unlabeled_pool']} |"
        )

    ar = r.get("unlabeled_accept_rate_diagnostic", {})
    lines += [
        "",
        "## Diagnostic: Unlabeled Accept-Rate (NOT ground truth)",
        f"> Pool: {ar.get('n_pool')} items with no `collection` AND no `roost_category`. "
        f"NOT verified OOD — see negatives composition above.",
        "",
        "| signal | accept-rate | tau / note |",
        "|---|---|---|",
        f"| S1 cascade | {ar.get('S1_cascade_accept_rate')} | {ar.get('tau_S1')} |",
        f"| S2 head-conf | {ar.get('S2_headconf_accept_rate')} | tau={ar.get('tau_S2')} |",
        f"| S3 RelMaha | median={ar.get('S3_relmaha_median_score')} | {ar.get('S3_note')} |",
    ]

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(repo_root, "docs", "superpowers", "specs",
                        "2026-07-03-fresh-rejection-eval-results.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


if __name__ == "__main__":
    main()
