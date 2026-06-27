import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Vault } from "obsidian";
import { shouldRetrain, decideSwap, runRetrain } from "@/pipeline/retrain";
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
}));

// Import after mocks so we get the mocked versions for vi.mocked() assertions.
import { buildTrainingRows, trainStackedHeadsFromRows } from "@/pipeline/train-head";
import { loadStackedHeads } from "@/pipeline/classifier-head";
import { evaluateGate } from "@/pipeline/acceptance-gate";
import { writeStackedHeads, restorePreviousHeads } from "@/pipeline/head-store";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** 5 rows for one class so splitHoldout's every-5th rule yields 1 holdout sample. */
const fakeRows = Array.from({ length: 5 }, (_, i) => ({
  id: `item${i}`,
  vecText: [1, 0],
  vecVision: [0, 1],
  category: "catA",
}));

const fakeCandidateData: { text: ClassifierHeadData; vision: ClassifierHeadData; meta: MetaHeadData } = {
  text:   { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2, norm: "l2",   trainedOn: 4, version: 1 },
  vision: { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2, norm: "l2",   trainedOn: 4, version: 1 },
  meta:   { classes: ["catA"], W: [[1, 1]], b: [0], inDim: 2, norm: "none", version: 1 },
};

const fakeCurrentHeads: StackedHeads = {
  text:   { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2 },
  vision: { classes: ["catA"], W: [[1, 0]], b: [0], dim: 2 },
  meta:   { classes: ["catA"], W: [[1, 1]], b: [0], inDim: 2 },
};

const gatePass: GateResult = {
  pass: true, overallCurrent: 0.8, overallCandidate: 0.9, perClass: {}, failures: [],
};

const gateFail: GateResult = {
  pass: false, overallCurrent: 0.9, overallCandidate: 0.7, perClass: {}, failures: ["overall regressed -20.0pp"],
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

// ── runRetrain branch tests ───────────────────────────────────────────────────

describe("runRetrain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gate passes → writeStackedHeads called once; result {ran:true, swapped:true}", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(evaluateGate).mockReturnValue(gatePass);
    // writeStackedHeads and restorePreviousHeads are already vi.fn() (no-op by default)

    const result = runRetrain(mockVault, () => {});

    expect(result).toMatchObject({ ran: true, swapped: true, reason: "gate passed" });
    expect(vi.mocked(writeStackedHeads)).toHaveBeenCalledOnce();
    expect(vi.mocked(restorePreviousHeads)).not.toHaveBeenCalled();
  });

  it("gate fails → writeStackedHeads NOT called; result {ran:true, swapped:false, reason:'gate failed'}; restorePreviousHeads NOT called", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(evaluateGate).mockReturnValue(gateFail);

    const result = runRetrain(mockVault, () => {});

    expect(result).toMatchObject({ ran: true, swapped: false, reason: "gate failed" });
    expect(vi.mocked(writeStackedHeads)).not.toHaveBeenCalled();
    expect(vi.mocked(restorePreviousHeads)).not.toHaveBeenCalled();
  });

  it("holdout empty with existing head → skips retrain to protect live head; writeStackedHeads NOT called", () => {
    // 3 rows of one class: n values are 0,1,2 — none satisfy n%5===4 → holdout is empty.
    const sparseRows = Array.from({ length: 3 }, (_, i) => ({
      id: `sparse${i}`,
      vecText: [1, 0],
      vecVision: [0, 1],
      category: "catA",
    }));
    vi.mocked(buildTrainingRows).mockReturnValue(sparseRows);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    // trainStackedHeadsFromRows should NOT be reached, but mock defensively.
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);

    const result = runRetrain(mockVault, () => {});

    expect(result).toEqual({ ran: false, swapped: false, reason: "holdout empty, cannot gate" });
    expect(vi.mocked(writeStackedHeads)).not.toHaveBeenCalled();
  });

  it("write throws → restorePreviousHeads called; result {ran:true, swapped:false}; function does NOT re-throw", () => {
    vi.mocked(buildTrainingRows).mockReturnValue(fakeRows);
    vi.mocked(trainStackedHeadsFromRows).mockReturnValue(fakeCandidateData);
    vi.mocked(loadStackedHeads).mockReturnValue(fakeCurrentHeads);
    vi.mocked(evaluateGate).mockReturnValue(gatePass);
    vi.mocked(writeStackedHeads).mockImplementation(() => { throw new Error("disk full"); });

    let result: ReturnType<typeof runRetrain> | undefined;
    expect(() => { result = runRetrain(mockVault, () => {}); }).not.toThrow();

    expect(result).toMatchObject({ ran: true, swapped: false, reason: "write failed, restored previous" });
    expect(vi.mocked(restorePreviousHeads)).toHaveBeenCalledOnce();
  });
});
