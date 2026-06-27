import { describe, it, expect } from "vitest";
import { correctionRateFlags, labelDistributionDrift } from "@/pipeline/honesty-monitors";
import type { EvalRecord } from "@/pipeline/eval-log";

function r(ts: number, guess: string | null, final: string | null, correct: boolean): EvalRecord {
  return { ts, roostId: `${ts}-${guess}-${final}`, guess, tier: "stacked", finalLabel: final, correct };
}

describe("correctionRateFlags", () => {
  it("flags a predicted class whose wrong predictions go uncorrected past the window", () => {
    // 'Lifestyle' predicted across batches 1..10, always accepted as correct (never corrected)
    const recs: EvalRecord[] = [];
    for (let t = 1; t <= 10; t++) recs.push(r(t, "Lifestyle", "Lifestyle", true));
    const flags = correctionRateFlags(recs, 8);
    const ls = flags.find((f) => f.category === "Lifestyle")!;
    expect(ls.flagged).toBe(true);
    expect(ls.batchesSinceWrongCorrected).toBeGreaterThanOrEqual(8);
  });

  it("does NOT flag a class the user actively corrects", () => {
    const recs: EvalRecord[] = [];
    for (let t = 1; t <= 10; t++) recs.push(r(t, "Tech", t === 10 ? "Money" : "Tech", t !== 10));
    // at batch 10 the user corrected a wrong Tech guess → recent engagement
    const flags = correctionRateFlags(recs, 8);
    const tech = flags.find((f) => f.category === "Tech")!;
    expect(tech.flagged).toBe(false);
  });
});

describe("labelDistributionDrift", () => {
  it("flags a class whose human-label share jumps between the older and recent halves", () => {
    const recs: EvalRecord[] = [];
    // older half (ts 1..4): mostly Tech;  recent half (ts 5..8): mostly Food
    for (let t = 1; t <= 4; t++) recs.push(r(t, "Tech", "Tech", true));
    for (let t = 5; t <= 8; t++) recs.push(r(t, "Food", "Food", true));
    const flags = labelDistributionDrift(recs, 0.15);
    expect(flags.find((f) => f.category === "Food")!.flagged).toBe(true);
  });
});
