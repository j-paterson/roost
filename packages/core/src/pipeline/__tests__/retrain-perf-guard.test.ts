/**
 * Regression guard for the retrain OOF fold count.
 *
 * Training now runs in the Python sidecar (off-thread, seconds) — the
 * LOGREG_MAX_ITERATIONS guard is no longer relevant. The OOF fold invariant
 * is kept: gate models use fewer folds than the deployed head (cheaper throwaway fits).
 */
import { describe, it, expect } from "vitest";
import { GATE_OOF, OOF_FOLDS } from "@/config";

describe("retrain performance guards", () => {
  it("the gate uses fewer OOF folds than the deployed head (throwaway models are cheaper)", () => {
    expect(GATE_OOF).toBeLessThan(OOF_FOLDS);
  });
});
