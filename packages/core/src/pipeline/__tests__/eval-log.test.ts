import { describe, it, expect } from "vitest";
import { fadingWindowAccuracy, type EvalRecord } from "@/pipeline/eval-log";

function rec(ts: number, guess: string, tier: EvalRecord["tier"], final: string): EvalRecord {
  return { ts, roostId: `${ts}-${guess}`, guess, tier, finalLabel: final, correct: guess === final };
}

describe("fadingWindowAccuracy", () => {
  it("weights recent batches more than old ones", () => {
    // batch ts=1 (old): all wrong;  batch ts=2 (recent): all right
    const records = [
      rec(1, "Tech", "stacked", "Food"),
      rec(1, "Tech", "stacked", "Food"),
      rec(2, "Food", "stacked", "Food"),
      rec(2, "Food", "stacked", "Food"),
    ];
    const a = fadingWindowAccuracy(records, 1); // half-life 1 batch
    // recent batch (right) weighted 2x the old (wrong) → accuracy > 0.5
    expect(a.overall).toBeGreaterThan(0.5);
  });

  it("segments by tier and by final-label class", () => {
    const records = [
      rec(1, "Tech", "stacked", "Tech"),     // correct, tier stacked, class Tech
      rec(1, "Food", "centroid", "Money"),   // wrong, tier centroid, class Money
    ];
    const a = fadingWindowAccuracy(records, 5);
    expect(a.byTier["stacked"]).toBe(1);
    expect(a.byTier["centroid"]).toBe(0);
    expect(a.byClass["Tech"]).toBe(1);
    expect(a.byClass["Money"]).toBe(0);
  });

  it("returns 0 buckets safely for empty input", () => {
    const a = fadingWindowAccuracy([], 5);
    expect(a.overall).toBe(0);
    expect(a.byTier).toEqual({});
  });
});
