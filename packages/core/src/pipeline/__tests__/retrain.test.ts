import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Vault } from "obsidian";
import { shouldRetrain, decideSwap, decideFromFolds, runRetrain } from "@/pipeline/retrain";
import type { StackedHeads } from "@/pipeline/classifier-head";
import type { GateResult } from "@/pipeline/acceptance-gate";
import type { ClassifierHeadData, MetaHeadData } from "@/pipeline/classifier-head";

// ── Module mocks (hoisted by vitest before imports) ───────────────────────────

vi.mock("@/pipeline/train-head", () => ({
  buildTrainingRows: vi.fn(),
  trainStackedHeadsFromRows: vi.fn(),
}));

vi.mock("@/pipeline/classifier-head", () => ({
  loadStackedHeads: vi.fn(),
}));

vi.mock("@/pipeline/acceptance-gate", () => ({
  evaluateGate: vi.fn(),
}));

vi.mock("@/pipeline/head-store", () => ({
  writeStackedHeads: vi.fn(),
  restorePreviousHeads: vi.fn(),
  loadRetrainMeta: vi.fn(),
  saveRetrainMeta: vi.fn(),
}));

// Import after mocks so we get the mocked versions for vi.mocked() assertions.
import { buildTrainingRows, trainStackedHeadsFromRows } from "@/pipeline/train-head";
import { loadStackedHeads } from "@/pipeline/classifier-head";
import { evaluateGate } from "@/pipeline/acceptance-gate";
import { writeStackedHeads, restorePreviousHeads, loadRetrainMeta, saveRetrainMeta } from "@/pipeline/head-store";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_LAST_RETRAIN_TS = 1000;

/**
 * 3 rows for one class: with GATE_KFOLDS=3, each fold gets exactly 1 holdout item.
 * All have ts <= FAKE_LAST_RETRAIN_TS so baseline rows are always non-empty.
 */
const fakeRows = [
  { id: "item0", vecText: [1, 0], vecVision: [0, 1], category: "catA", ts: 100 },
  { id: "item1", vecText: [1, 0], vecVision: [0, 1], category: "catA", ts: 200 },
  { id: "item2", vecText: [1, 0], vecVision: [0, 1], category: "catA", ts: 300 },
];

const fakeCandidateData: { text: ClassifierHeadData; vision: ClassifierHeadData; meta: MetaHeadData } = {
  text:   { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2, norm: "l2",   trainedOn: 3, version: 1 },
  vision: { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2, norm: "l2",   trainedOn: 3, version: 1 },
  meta:   { classes: ["catA"], W: [[1, 1]], b: [0], inDim: 2, norm: "none", version: 1 },
};

const fakeCurrentHeads: StackedHeads = {
  text:   { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2 },
  vision: { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2 },
  meta:   { classes: ["catA"], W: [[1, 1]], b: [0], inDim: 2 },
};

const gatePass: GateResult = {
  pass: true, overallCurrent: 0.8, overallCandidate: 0.9,
  macroCurrent: 0.8, macroCandidate: 0.9,
  catastrophic: [], failures: [],
};

const gateFail: GateResult = {
  pass: false, overallCurrent: 0.9, overallCandidate: 0.7,
  macroCurrent: 0.9, macroCandidate: 0.7,
  catastrophic: [], failures: ["macro-recall regressed -20.0pp"],
};

const mockVault = {} as unknown as Vault;

// ── Pure-function tests (must remain green alongside mocked ones) ──────────────

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
    expect(decideSwap({
      pass: true, overallCurrent: 0.5, overallCandidate: 0.6,
      macroCurrent: 0.5, macroCandidate: 0.6, catastrophic: [], failures: [],
    }).swapped).toBe(true);
    expect(decideSwap({
      pass: false, overallCurrent: 0.6, overallCandidate: 0.5,
      macroCurrent: 0.6, macroCandidate: 0.5, catastrophic: [], failures: ["x"],
    }).swapped).toBe(false);
  });

  it("swaps when there is no current head (first-ever train)", () => {
    expect(decideSwap(null).swapped).toBe(true);
  });

  it("keeps when gate has failures even if overall improves", () => {
    expect(decideSwap({
      pass: false,
      overallCurrent: 0.5,
      overallCandidate: 0.9,
      macroCurrent: 0.9,
      macroCandidate: 0.7,
      catastrophic: ["catA"],
      failures: ["class catA collapsed -20.0pp"],
    }).swapped).toBe(false);
  });
});

// ── decideFromFolds ────────────────────────────────────────────────────────────

function gr(ovC: number, ovK: number, maC: number, maK: number, cata: string[] = []): GateResult {
  return { pass: true, overallCurrent: ovC, overallCandidate: ovK, macroCurrent: maC, macroCandidate: maK, catastrophic: cata, failures: [] };
}

describe("decideFromFolds", () => {
  it("passes when avg overall & macro both non-negative and no majority catastrophe", () => {
    const r = decideFromFolds([gr(.6,.63,.6,.66), gr(.6,.62,.6,.65), gr(.6,.64,.6,.67)], 0);
    expect(r.pass).toBe(true); expect(r.avgMacroDelta).toBeGreaterThan(0);
  });
  it("rejects when avg macro regresses", () => {
    const r = decideFromFolds([gr(.66,.65,.65,.63), gr(.66,.64,.65,.62), gr(.66,.65,.65,.64)], 0);
    expect(r.pass).toBe(false);
  });
  it("rejects when a class is catastrophic in a majority of folds", () => {
    const r = decideFromFolds([gr(.6,.62,.6,.63,["X"]), gr(.6,.62,.6,.63,["X"]), gr(.6,.62,.6,.63)], 0);
    expect(r.catastrophicClasses).toContain("X"); expect(r.pass).toBe(false);
  });
});

// ── runRetrain branch tests ───────────────────────────────────────────────────

describe("runRetrain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gate passes → writeStackedHeads called once, saveRetrainMeta called once; result {ran:true, swapped:true}", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: FAKE_LAST_RETRAIN_TS });
    vi.mocked(evaluateGate).mockReturnValue(gatePass);

    const result = runRetrain(mockVault, () => {});

    expect(result).toMatchObject({ ran: true, swapped: true, reason: "gate passed" });
    expect(vi.mocked(writeStackedHeads)).toHaveBeenCalledOnce();
    expect(vi.mocked(saveRetrainMeta)).toHaveBeenCalledOnce();
    expect(vi.mocked(restorePreviousHeads)).not.toHaveBeenCalled();
  });

  it("gate fails → writeStackedHeads NOT called; result {ran:true, swapped:false, reason:'gate failed'}; restorePreviousHeads NOT called", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: FAKE_LAST_RETRAIN_TS });
    vi.mocked(evaluateGate).mockReturnValue(gateFail);

    const result = runRetrain(mockVault, () => {});

    expect(result).toMatchObject({ ran: true, swapped: false, reason: "gate failed" });
    expect(vi.mocked(writeStackedHeads)).not.toHaveBeenCalled();
    expect(vi.mocked(saveRetrainMeta)).not.toHaveBeenCalled();
    expect(vi.mocked(restorePreviousHeads)).not.toHaveBeenCalled();
  });

  it("no baseline rows for any fold → protects live head; result {ran:false, swapped:false, reason:'no gate folds'}", () => {
    // All rows have ts > lastRetrainTs → baselineRows empty for every fold → no usable folds.
    const futureRows = fakeRows.map((r) => ({ ...r, ts: 9999 }));
    vi.mocked(buildTrainingRows).mockReturnValue(futureRows);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: 0 });
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);

    const result = runRetrain(mockVault, () => {});

    expect(result).toEqual({ ran: false, swapped: false, reason: "no gate folds" });
    expect(vi.mocked(writeStackedHeads)).not.toHaveBeenCalled();
  });

  it("first train (no current head) → deploys unconditionally, saveRetrainMeta called, no gating", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(null);
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: 0 });
    const result = runRetrain(mockVault, () => {});
    expect(result).toMatchObject({ ran: true, swapped: true, reason: "first head" });
    expect(vi.mocked(writeStackedHeads)).toHaveBeenCalledOnce();
    expect(vi.mocked(saveRetrainMeta)).toHaveBeenCalledOnce();
    expect(vi.mocked(evaluateGate)).not.toHaveBeenCalled();
  });

  it("write throws → restorePreviousHeads called; result {ran:true, swapped:false}; function does NOT re-throw", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(loadRetrainMeta).mockReturnValue({ lastRetrainTs: FAKE_LAST_RETRAIN_TS });
    vi.mocked(evaluateGate).mockReturnValue(gatePass);
    vi.mocked(writeStackedHeads).mockImplementation(() => { throw new Error("disk full"); });

    let result: ReturnType<typeof runRetrain> | undefined;
    expect(() => { result = runRetrain(mockVault, () => {}); }).not.toThrow();

    expect(result).toMatchObject({ ran: true, swapped: false, reason: "write failed, restored previous" });
    expect(vi.mocked(restorePreviousHeads)).toHaveBeenCalledOnce();
    expect(vi.mocked(saveRetrainMeta)).not.toHaveBeenCalled();
  });
});
