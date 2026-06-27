import { describe, it, expect } from "vitest";
import { evaluateGate, type GateSample } from "@/pipeline/acceptance-gate";
import type { StackedHeads } from "@/pipeline/classifier-head";

// Identity-ish heads over 2-D, 2 classes; helper builds a head that favors axis i.
function head(boost: number): StackedHeads {
  const base = { classes: ["A", "B"], W: [[boost, 0], [0, boost]], b: [0, 0], dim: 2 };
  const meta = { classes: ["A", "B"], W: [[boost, 0, boost, 0], [0, boost, 0, boost]], b: [0, 0], inDim: 4 };
  return { text: base, vision: base, meta };
}
const samples: GateSample[] = [
  { vecText: [1, 0], vecVision: [1, 0], truth: "A" },
  { vecText: [0, 1], vecVision: [0, 1], truth: "B" },
];

describe("evaluateGate", () => {
  it("passes when candidate matches or beats current overall and per-class", () => {
    const r = evaluateGate(head(5), head(5), samples);
    expect(r.pass).toBe(true);
    expect(r.overallCandidate).toBeGreaterThanOrEqual(r.overallCurrent);
  });

  it("fails when the candidate regresses a class beyond the margin", () => {
    // current classifies both right; candidate (boost 0 → ties → argmax picks class 0 'A')
    // misclassifies the B sample → class B regresses 100pp.
    const r = evaluateGate(head(5), head(0), samples, 0.05);
    expect(r.pass).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("evaluateGate with empty samples returns pass:true with no NaN", () => {
    const r = evaluateGate(head(5), head(5), []);
    expect(r.pass).toBe(true);
    expect(Number.isNaN(r.overallCurrent)).toBe(false);
    expect(Number.isNaN(r.overallCandidate)).toBe(false);
    expect(r.failures).toHaveLength(0);
  });
});
