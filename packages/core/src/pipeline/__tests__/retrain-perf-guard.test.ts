/**
 * Regression guard for the run-start retrain performance blowup.
 *
 * The retrain runs synchronously on the main thread. With LOGREG_MAX_ITERATIONS
 * at 2000, one train (13 logistic-regression fits) over a large label set took
 * minutes, and runRetrain does ~7 of them → Smart Assign froze for 20+ minutes.
 * These invariants keep the cost bounded; a synthetic wall-clock test on the full
 * label set isn't run here (it's minutes even when correct), so we pin the knobs.
 */
import { describe, it, expect } from "vitest";
import { LOGREG_MAX_ITERATIONS, GATE_OOF, OOF_FOLDS } from "@/config";

describe("retrain performance guards", () => {
  it("LOGREG_MAX_ITERATIONS stays bounded (2000 froze the UI for 20+ min)", () => {
    expect(LOGREG_MAX_ITERATIONS).toBeLessThanOrEqual(400);
  });

  it("the gate uses fewer OOF folds than the deployed head (throwaway models are cheaper)", () => {
    expect(GATE_OOF).toBeLessThan(OOF_FOLDS);
  });
});
