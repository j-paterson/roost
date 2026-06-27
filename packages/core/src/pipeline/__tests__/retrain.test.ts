import { describe, it, expect } from "vitest";
import { shouldRetrain, decideSwap } from "@/pipeline/retrain";

describe("shouldRetrain", () => {
  it("fires at the signal floor or when a category newly qualifies", () => {
    expect(shouldRetrain({ newLabelsSinceLastTrain: 10, newlyEligibleCount: 0 })).toBe(true);
    expect(shouldRetrain({ newLabelsSinceLastTrain: 0, newlyEligibleCount: 1 })).toBe(true);
    expect(shouldRetrain({ newLabelsSinceLastTrain: 3, newlyEligibleCount: 0 })).toBe(false);
  });

  it("fires exactly at the floor (boundary)", () => {
    // RETRAIN_SIGNAL_FLOOR = 10
    expect(shouldRetrain({ newLabelsSinceLastTrain: 9, newlyEligibleCount: 0 })).toBe(false);
    expect(shouldRetrain({ newLabelsSinceLastTrain: 10, newlyEligibleCount: 0 })).toBe(true);
    expect(shouldRetrain({ newLabelsSinceLastTrain: 11, newlyEligibleCount: 0 })).toBe(true);
  });

  it("does not fire when both counts are zero", () => {
    expect(shouldRetrain({ newLabelsSinceLastTrain: 0, newlyEligibleCount: 0 })).toBe(false);
  });

  it("fires when both counts are positive", () => {
    expect(shouldRetrain({ newLabelsSinceLastTrain: 15, newlyEligibleCount: 2 })).toBe(true);
  });
});

describe("decideSwap", () => {
  it("swaps when the gate passes, keeps when it fails", () => {
    expect(decideSwap({ pass: true, overallCurrent: 0.5, overallCandidate: 0.6, perClass: {}, failures: [] }).swapped).toBe(true);
    expect(decideSwap({ pass: false, overallCurrent: 0.6, overallCandidate: 0.5, perClass: {}, failures: ["x"] }).swapped).toBe(false);
  });

  it("swaps when there is no current head (first-ever train)", () => {
    expect(decideSwap(null).swapped).toBe(true);
  });

  it("keeps when gate has failures even if overall improves", () => {
    expect(decideSwap({
      pass: false,
      overallCurrent: 0.5,
      overallCandidate: 0.9,
      perClass: { "catA": { current: 0.9, candidate: 0.7, delta: -0.2 } },
      failures: ["class catA regressed -20.0pp"],
    }).swapped).toBe(false);
  });
});
