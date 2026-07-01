/**
 * Unit tests for maybeRetrainAtRunStart — the run-start retrain injection helper
 * extracted from runSmartAssignClustering.
 *
 * Mocks the retrain/training-set/head-store pipeline modules so the test is
 * fast and deterministic with no vault I/O.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Vault } from "obsidian";

// ── Module mocks (hoisted by vitest before imports) ───────────────────────────

vi.mock("@/pipeline/retrain", () => ({
  runRetrain: vi.fn(),
  shouldRetrain: vi.fn(),
  newLabelsSince: vi.fn(),
}));

vi.mock("@/pipeline/training-set", () => ({
  loadTrainingSet: vi.fn(),
}));

vi.mock("@/pipeline/head-store", () => ({
  loadRetrainMeta: vi.fn(),
}));

import { runRetrain, shouldRetrain, newLabelsSince } from "@/pipeline/retrain";
import { loadTrainingSet } from "@/pipeline/training-set";
import { loadRetrainMeta } from "@/pipeline/head-store";
import type { TrainingSet } from "@/pipeline/training-set";
import { maybeRetrainAtRunStart, retrainNoticeMessage } from "@/ui/lib/smart-assign/clustering";
import { PIPELINE_STEP } from "@/ui/lib/smart-assign/pipeline-steps";
import type { RetrainOutcome } from "@/pipeline/retrain";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fakeVault = {} as unknown as Vault;
const fakeTs: TrainingSet = { version: 1, positives: {}, rejections: {} };

function makeHost(autoRetrain: boolean) {
  return {
    app: { vault: fakeVault },
    plugin: { settings: { smartAssignAutoRetrain: autoRetrain } },
    log: vi.fn(),
    setPipelineStep: vi.fn(),
    setSyncProgress: vi.fn(),
  } as unknown as Parameters<typeof maybeRetrainAtRunStart>[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("maybeRetrainAtRunStart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadTrainingSet).mockReturnValue(fakeTs);
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: 0 });
    vi.mocked(newLabelsSince).mockReturnValue(11);
  });

  it("calls runRetrain when flag is ON and shouldRetrain returns true", async () => {
    vi.mocked(shouldRetrain).mockReturnValue(true);
    const host = makeHost(true);

    await maybeRetrainAtRunStart(host);

    expect(vi.mocked(runRetrain)).toHaveBeenCalledOnce();
    expect(vi.mocked(runRetrain)).toHaveBeenCalledWith(fakeVault, host.log);
  });

  it("surfaces retrain as its own pipeline step (with a start log) before running it", async () => {
    vi.mocked(shouldRetrain).mockReturnValue(true);
    const order: string[] = [];
    const host = makeHost(true);
    vi.mocked(host.setPipelineStep).mockImplementation(() => { order.push("step"); });
    vi.mocked(runRetrain).mockImplementation(() => { order.push("retrain"); return Promise.resolve({ ran: false, swapped: false, reason: "x" }); });

    await maybeRetrainAtRunStart(host);

    expect(host.setPipelineStep).toHaveBeenCalledWith(PIPELINE_STEP.RETRAIN);
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("Retrain"));
    // The step must be set BEFORE the (blocking) retrain runs, so the UI paints it.
    expect(order).toEqual(["step", "retrain"]);
  });

  it("does NOT set the Retrain step or call runRetrain when shouldRetrain returns false", async () => {
    vi.mocked(shouldRetrain).mockReturnValue(false);
    const host = makeHost(true);

    await maybeRetrainAtRunStart(host);

    expect(vi.mocked(runRetrain)).not.toHaveBeenCalled();
    expect(host.setPipelineStep).not.toHaveBeenCalled();
  });

  it("does NOT call runRetrain when flag is OFF (even if shouldRetrain would return true)", async () => {
    vi.mocked(shouldRetrain).mockReturnValue(true);
    const host = makeHost(false);

    await maybeRetrainAtRunStart(host);

    expect(vi.mocked(runRetrain)).not.toHaveBeenCalled();
    // Should not even check the training set when disabled
    expect(vi.mocked(loadTrainingSet)).not.toHaveBeenCalled();
  });

  it("does NOT call runRetrain when flag is ON but shouldRetrain returns false", async () => {
    vi.mocked(shouldRetrain).mockReturnValue(false);
    const host = makeHost(true);

    await maybeRetrainAtRunStart(host);

    expect(vi.mocked(runRetrain)).not.toHaveBeenCalled();
  });

  it("passes newLabelsSince result to shouldRetrain with newlyEligibleCount 0", async () => {
    vi.mocked(newLabelsSince).mockReturnValue(42);
    vi.mocked(shouldRetrain).mockReturnValue(false);
    const host = makeHost(true);

    await maybeRetrainAtRunStart(host);

    expect(vi.mocked(shouldRetrain)).toHaveBeenCalledWith({
      newLabelsSinceLastTrain: 42,
      newlyEligibleCount: 0,
    });
  });

  it("uses lastRetrainTs from loadRetrainMeta as the sinceTs watermark", async () => {
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: 9999 });
    vi.mocked(shouldRetrain).mockReturnValue(false);
    const host = makeHost(true);

    await maybeRetrainAtRunStart(host);

    expect(vi.mocked(newLabelsSince)).toHaveBeenCalledWith(fakeTs, 9999);
  });

  it("logs and does NOT re-throw when an error occurs mid-check", async () => {
    vi.mocked(loadTrainingSet).mockImplementation(() => { throw new Error("disk error"); });
    const host = makeHost(true);

    await expect(maybeRetrainAtRunStart(host)).resolves.toBeUndefined();
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("disk error"));
  });

  it("logs and does NOT re-throw when runRetrain throws", async () => {
    vi.mocked(shouldRetrain).mockReturnValue(true);
    vi.mocked(runRetrain).mockImplementation(() => { throw new Error("retrain boom"); });
    const host = makeHost(true);

    await expect(maybeRetrainAtRunStart(host)).resolves.toBeUndefined();
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("retrain boom"));
  });
});

// ── retrainNoticeMessage — pure helper, no Obsidian runtime needed ────────────

describe("retrainNoticeMessage", () => {
  it("returns null when outcome.ran is false (not triggered)", () => {
    const outcome: RetrainOutcome = { ran: false, swapped: false, reason: "no eligible training data" };
    expect(retrainNoticeMessage(outcome)).toBeNull();
  });

  it("returns improvement string on swap with macro delta", () => {
    const outcome: RetrainOutcome = { ran: true, swapped: true, reason: "gate passed", avgMacroDelta: 0.034 };
    expect(retrainNoticeMessage(outcome)).toBe("Classifier improved (+3.4% macro)");
  });

  it("returns improvement string with +?% when avgMacroDelta is undefined", () => {
    const outcome: RetrainOutcome = { ran: true, swapped: true, reason: "first head" };
    expect(retrainNoticeMessage(outcome)).toBe("Classifier improved (+?% macro)");
  });

  it("returns write-error string (NOT would-regress) when reason is 'write failed, restored previous'", () => {
    const outcome: RetrainOutcome = {
      ran: true,
      swapped: false,
      reason: "write failed, restored previous",
      avgMacroDelta: -0.05,
      catastrophic: [],
    };
    const msg = retrainNoticeMessage(outcome);
    expect(msg).toBe("Retrain failed (write error) — kept current head");
    expect(msg).not.toContain("would regress");
  });

  it("returns would-regress with catastrophic classes on gate failure", () => {
    const outcome: RetrainOutcome = {
      ran: true,
      swapped: false,
      reason: "gate failed",
      catastrophic: ["nsfw", "violence"],
    };
    expect(retrainNoticeMessage(outcome)).toBe("Retrain skipped — would regress nsfw, violence");
  });

  it("returns would-regress with 'overall/macro' fallback when catastrophic is empty", () => {
    const outcome: RetrainOutcome = {
      ran: true,
      swapped: false,
      reason: "gate failed",
      catastrophic: [],
      avgMacroDelta: -0.02,
    };
    expect(retrainNoticeMessage(outcome)).toBe("Retrain skipped — would regress overall/macro");
  });
});
