#!/usr/bin/env python3
"""NONE-slot validation report.

Reads llm-rerank-results.json, computes three metrics per cell that has
`include_negatives=true`, derives a post-hoc FlatSim085 baseline from
stored `picked_sim` values (no new LLM calls), and prints a gate verdict
against the phase4-fixed positive baselines.

Metrics:
  positive_acc = correct_pos / 119
  trr          = refused_neg / 50           (true-refusal rate)
  combined_acc = (correct_pos + refused_neg) / 169

Gates (configurable below):
  POS_GATE_DROP = 2.0 pp    vs phase4-fixed baseline
  TRR_GATE      = 0.70      (≥ 35/50)
  COMBINED_GATE = FlatSim085 combined_acc (NONE must beat the free alternative)

FlatSim085 variant: for every cell with picked_sim annotations, relabel
picks with sim < 0.85 as refusals. Derived cells are named "{cell}+fs085".

Usage: python scripts/none-harness-report.py
"""
import json
from pathlib import Path

RESULTS_PATH = Path.home() / "ObsidianBookmarks" / ".roost" / "llm-rerank-results.json"

# Gates
POS_GATE_DROP_PP = 2.0
TRR_GATE = 0.70
FLAT_SIM_THRESH = 0.85

# Baselines are read dynamically from the results file. We look for
# no-NONE cells (T1_letter / T2_json, not T*_none) that have
# include_negatives=true — those are the current-environment baselines
# run under the same sweep session as the NONE candidates. This avoids
# drift from stale phase4 numbers.


def find_baseline_cell(all_results, family):
    """Find the no-NONE cell for the given template family that was run with
    --include-negatives. Returns the cell name or None.

    family ∈ {"T1_letter", "T2_json"}
    """
    for name, cd in all_results.items():
        if not cd.get("include_negatives"):
            continue
        if "_none" in name:
            continue
        if f"/{family}/" in name:
            return name
    return None


def positive_gate(pos_correct, pos_total, baseline_cell, all_results):
    """Return (pass, baseline_name, baseline_correct, delta_pp)."""
    if baseline_cell is None:
        return (None, None, None, None)
    base = all_results.get(baseline_cell, {})
    base_c = base.get("positive_correct", 0)
    base_t = base.get("positive_total", 119)
    if pos_total == 0:
        return (False, baseline_cell, base_c, -100.0)
    pct = pos_correct / pos_total * 100
    base_pct = base_c / base_t * 100
    delta = pct - base_pct
    return (delta >= -POS_GATE_DROP_PP, baseline_cell, base_c, delta)


def infer_family(cell_name):
    """Map a cell name to a template family ('T1_letter' or 'T2_json')."""
    low = cell_name.lower()
    if "t1_letter" in low:
        return "T1_letter"
    if "t2_json" in low:
        return "T2_json"
    return None


def derive_flatsim(cell_data, thresh=FLAT_SIM_THRESH):
    """Relabel picks with picked_sim < thresh as refusals and recompute metrics.

    Rules:
      positive item: if picked_sim < thresh → count as WRONG (was rejected),
                      else → keep original correctness.
      negative item: if picked_sim < thresh OR pick == 'N' → count as REFUSED (correct),
                      else → still counted as wrong (the model picked a high-sim thing
                      that the flat threshold couldn't reject).
    """
    picks = cell_data.get("picks", [])
    if not picks or "picked_sim" not in picks[0]:
        return None  # Cell doesn't have sim annotations; can't derive.
    pos_correct = 0
    pos_total = 0
    neg_refused = 0
    neg_total = 0
    for p in picks:
        is_neg = p.get("is_negative")
        sim = p.get("picked_sim", 0.0)
        pick = p.get("pick")
        picked_coll = p.get("picked_coll")
        gt = p.get("gt")
        # Post-hoc flat-sim rejection: any pick with sim<thresh becomes a refusal
        refused_now = (pick == "N") or (sim < thresh)
        if is_neg:
            neg_total += 1
            if refused_now:
                neg_refused += 1
        else:
            pos_total += 1
            # Positive is correct iff: it wasn't refused AND the collection matched gt
            if not refused_now and picked_coll == gt:
                pos_correct += 1
    return {
        "positive_correct": pos_correct,
        "positive_total": pos_total,
        "positive_accuracy": (pos_correct / pos_total) if pos_total else 0.0,
        "negative_refused": neg_refused,
        "negative_total": neg_total,
        "trr": (neg_refused / neg_total) if neg_total else 0.0,
        "combined_correct": pos_correct + neg_refused,
        "combined_total": pos_total + neg_total,
        "combined_accuracy": (pos_correct + neg_refused) / (pos_total + neg_total) if (pos_total + neg_total) else 0.0,
        "flatsim_thresh": thresh,
    }


def fmt_row(name, row, baseline_combined=None):
    pos = f"{row['positive_correct']}/{row['positive_total']} ({row['positive_accuracy']*100:.1f}%)"
    trr = f"{row['negative_refused']}/{row['negative_total']} ({row['trr']*100:.1f}%)"
    comb = f"{row['combined_correct']}/{row['combined_total']} ({row['combined_accuracy']*100:.1f}%)"
    combined_vs = ""
    if baseline_combined is not None:
        delta = (row["combined_accuracy"] - baseline_combined) * 100
        combined_vs = f"  Δvs-fs085: {delta:+.1f}pp"
    return f"  {name:<50} pos={pos:<20} trr={trr:<16} combined={comb:<18}{combined_vs}"


def main():
    all_results = json.load(open(RESULTS_PATH))

    # Find cells with negatives included
    neg_cells = {name: cd for name, cd in all_results.items() if cd.get("include_negatives")}
    if not neg_cells:
        print("No cells with include_negatives=true found. Run sweep with --include-negatives first.")
        return

    # Derive FlatSim085 variant for every neg cell
    flatsim_cells = {}
    for name, cd in neg_cells.items():
        fs = derive_flatsim(cd)
        if fs is not None:
            flatsim_cells[f"{name}+fs085"] = fs

    print("\n" + "=" * 110)
    print("NONE-SLOT VALIDATION HARNESS REPORT")
    print("=" * 110)
    print(f"Gates: positive drop ≤ {POS_GATE_DROP_PP}pp vs same-session no-NONE baseline, "
          f"TRR ≥ {TRR_GATE*100:.0f}%, combined > FlatSim{int(FLAT_SIM_THRESH*100)}")
    # Resolve baselines dynamically from the current results file
    baseline_map = {}
    for fam in ("T1_letter", "T2_json"):
        b = find_baseline_cell(all_results, fam)
        baseline_map[fam] = b
        if b is None:
            print(f"  {fam} baseline: (none found — run no-NONE sweep with --include-negatives)")
        else:
            bd = all_results[b]
            print(f"  {fam} baseline: {bd['positive_correct']}/{bd['positive_total']} "
                  f"= {bd['positive_correct']/bd['positive_total']*100:.1f}%  ({b})")
    print()

    print("── Raw sweep cells (with negatives) ──")
    for name in sorted(neg_cells):
        cd = neg_cells[name]
        fam = infer_family(name)
        baseline_cell = baseline_map.get(fam) if fam else None
        pass_pos, base_name, base_c, delta = positive_gate(
            cd["positive_correct"], cd["positive_total"], baseline_cell, all_results
        )
        # Format row
        row = {
            "positive_correct": cd["positive_correct"],
            "positive_total": cd["positive_total"],
            "positive_accuracy": cd["positive_accuracy"],
            "negative_refused": cd["negative_refused"],
            "negative_total": cd["negative_total"],
            "trr": cd["trr"],
            "combined_correct": cd["combined_correct"],
            "combined_total": cd["combined_total"],
            "combined_accuracy": cd["combined_accuracy"],
        }
        print(fmt_row(name, row))
        if fam and delta is not None:
            verdict_pos = "PASS" if pass_pos else "FAIL"
            verdict_trr = "PASS" if cd["trr"] >= TRR_GATE else "FAIL"
            print(f"    pos-gate: {verdict_pos} (Δ={delta:+.1f}pp vs {fam})  "
                  f"trr-gate: {verdict_trr}")
        elif fam:
            print(f"    (no {fam} baseline cell found — pos-gate skipped)")

    print("\n── Derived FlatSim085 variants (no new LLM calls) ──")
    for name in sorted(flatsim_cells):
        row = flatsim_cells[name]
        print(fmt_row(name, row))

    print("\n── Head-to-head: NONE vs FlatSim085 (per template family) ──")
    # For each NONE cell, find the matching baseline cell's FlatSim derivation
    # and compare combined accuracy.
    # Match rule: NONE cell `.../T1_letter_none/...withneg-none-k5` pairs with
    # the FlatSim derived from `.../T1_letter/...withneg-k5+fs085`.
    def base_of(name):
        """Given a NONE cell name, find the matching no-NONE cell's +fs085 key."""
        if "_none" not in name:
            return None
        base_name = name.replace("_none", "").replace("withneg-none", "withneg")
        return f"{base_name}+fs085"

    for name in sorted(neg_cells):
        if "_none" not in name:
            continue
        none_row = neg_cells[name]
        base_fs = base_of(name)
        fs_row = flatsim_cells.get(base_fs)
        if fs_row is None:
            print(f"  {name}: no matching FlatSim baseline (looking for {base_fs})")
            continue
        none_comb = none_row["combined_accuracy"]
        fs_comb = fs_row["combined_accuracy"]
        delta = (none_comb - fs_comb) * 100
        winner = "NONE" if none_comb > fs_comb else ("tie" if abs(delta) < 0.5 else "FlatSim085")
        print(f"  {name}")
        print(f"    NONE:       combined={none_row['combined_correct']}/{none_row['combined_total']} ({none_comb*100:.1f}%)  "
              f"pos={none_row['positive_correct']}/{none_row['positive_total']}  trr={none_row['negative_refused']}/{none_row['negative_total']}")
        print(f"    FlatSim085: combined={fs_row['combined_correct']}/{fs_row['combined_total']} ({fs_comb*100:.1f}%)  "
              f"pos={fs_row['positive_correct']}/{fs_row['positive_total']}  trr={fs_row['negative_refused']}/{fs_row['negative_total']}")
        print(f"    winner: {winner} (Δ={delta:+.2f}pp)")

        # Full gate verdict for NONE
        fam = infer_family(name)
        baseline_cell = baseline_map.get(fam) if fam else None
        pass_pos, _, _, ppdelta = positive_gate(
            none_row["positive_correct"], none_row["positive_total"],
            baseline_cell, all_results
        )
        pass_trr = none_row["trr"] >= TRR_GATE
        pass_comb = none_comb > fs_comb
        all_pass = pass_pos and pass_trr and pass_comb
        print(f"    NONE gate: pos={'PASS' if pass_pos else 'FAIL'}  "
              f"trr={'PASS' if pass_trr else 'FAIL'}  "
              f"combined>fs085={'PASS' if pass_comb else 'FAIL'}  "
              f"→ {'PASS (port to evaluate.ts)' if all_pass else 'FAIL (do not port)'}")

    print("=" * 110)


if __name__ == "__main__":
    main()
