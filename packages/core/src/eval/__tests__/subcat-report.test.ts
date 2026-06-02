import { describe, it, expect } from "vitest";
import {
  bestPerMethod, paretoFilter,
  calibrationBuckets,
  type CellSummary,
  type PerItemRow,
} from "@/eval/subcat-report";
import type { Method } from "@/eval/subcat-methods";

const C = (
  method: "cosine" | "t1" | "ensemble",
  floor: number,
  combined: number,
  msPer1k: number,
  llmPer1k = 0,
  positive = combined,
  compliance = combined,
): CellSummary => ({
  method, floor, secondaryThreshold: null,
  positiveAccuracy: positive, floorCompliance: compliance,
  combinedAccuracy: combined, msPer1k, llmPer1k,
});

describe("bestPerMethod", () => {
  it("picks the highest combined accuracy per method", () => {
    const cells = [
      C("cosine", 0.55, 0.81, 1),
      C("cosine", 0.60, 0.85, 1),
      C("cosine", 0.65, 0.83, 1),
      C("t1", 0.55, 0.88, 30000),
      C("t1", 0.60, 0.91, 30000),
    ];
    const best = bestPerMethod(cells);
    expect(best.find(c => c.method === "cosine")?.floor).toBe(0.60);
    expect(best.find(c => c.method === "t1")?.floor).toBe(0.60);
  });

  it("breaks ties on lower cost", () => {
    const cells = [
      C("cosine", 0.55, 0.85, 5),
      C("cosine", 0.60, 0.85, 1),  // same accuracy, lower ms/1k → wins
    ];
    const best = bestPerMethod(cells);
    expect(best[0].floor).toBe(0.60);
  });

  it("returns empty when input is empty", () => {
    expect(bestPerMethod([])).toEqual([]);
  });

  it("preserves secondaryThreshold on CellSummary objects passed through bestPerMethod", () => {
    const cells: CellSummary[] = [
      { method: "t1-margin" as Method, floor: 0.55, secondaryThreshold: 0.10,
        positiveAccuracy: 0.9, floorCompliance: 0.5, combinedAccuracy: 0.78,
        msPer1k: 1000, llmPer1k: 1000 },
      { method: "t1-margin" as Method, floor: 0.55, secondaryThreshold: 0.20,
        positiveAccuracy: 0.85, floorCompliance: 0.6, combinedAccuracy: 0.76,
        msPer1k: 1000, llmPer1k: 1000 },
    ];
    const best = bestPerMethod(cells);
    expect(best).toHaveLength(1);
    expect(best[0].secondaryThreshold).toBe(0.10);
  });
});

describe("paretoFilter", () => {
  it("drops cells dominated on both accuracy and cost", () => {
    const cells = [
      C("cosine", 0.65, 0.88, 1),
      C("cosine", 0.70, 0.85, 5),    // dominated by 0.65 cosine (lower acc, higher cost)
      C("t1", 0.60, 0.91, 30000),
      C("ensemble", 0.55, 0.92, 78000),
    ];
    const pareto = paretoFilter(cells);
    const keys = pareto.map(c => `${c.method}@${c.floor}`).sort();
    expect(keys).toEqual(["cosine@0.65", "ensemble@0.55", "t1@0.6"]);
  });

  it("keeps everything when no cell dominates another", () => {
    const cells = [
      C("cosine", 0.65, 0.88, 1),
      C("t1", 0.60, 0.91, 30000),
    ];
    const pareto = paretoFilter(cells);
    expect(pareto).toHaveLength(2);
  });

  it("returns empty for empty input", () => {
    expect(paretoFilter([])).toEqual([]);
  });
});

const I = (predicted: string | null, trueLabel: string | null, sim: number): PerItemRow => ({
  itemId: `i${Math.random()}`, parent: "X", predicted, trueLabel, sim,
});

describe("calibrationBuckets", () => {
  it("buckets per-item predictions on right-open sim intervals", () => {
    const rows: PerItemRow[] = [
      I("A", "A", 0.55), // [0.5,0.6) — correct
      I("A", "B", 0.59), // [0.5,0.6) — wrong
      I("A", "A", 0.65), // [0.6,0.7) — correct
      I("A", "A", 0.99), // [0.9,1.0]  — correct
      I("A", "A", 1.00), // [0.9,1.0]  — correct (boundary)
    ];
    const out = calibrationBuckets(rows);
    expect(out).toEqual([
      { bucket: "[0.5-0.6)", n: 2, accuracy: 0.5 },
      { bucket: "[0.6-0.7)", n: 1, accuracy: 1.0 },
      { bucket: "[0.7-0.8)", n: 0, accuracy: 0 },
      { bucket: "[0.8-0.9)", n: 0, accuracy: 0 },
      { bucket: "[0.9-1.0]",  n: 2, accuracy: 1.0 },
    ]);
  });

  it("treats null predictions as wrong for positives, correct for negatives", () => {
    const rows: PerItemRow[] = [
      I(null, "A", 0.4), // positive routed to parent → wrong
      I(null, null, 0.4), // negative routed to parent → correct
    ];
    const out = calibrationBuckets(rows);
    // Both fall below the lowest tracked bucket (0.5) — they're not counted.
    expect(out.every(b => b.n === 0)).toBe(true);
  });

  it("returns empty buckets for empty input", () => {
    const out = calibrationBuckets([]);
    expect(out.every(b => b.n === 0)).toBe(true);
    expect(out).toHaveLength(5);
  });
});
