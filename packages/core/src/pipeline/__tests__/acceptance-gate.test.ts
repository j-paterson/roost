import { describe, it, expect } from "vitest";
import { evaluateGate, type GateSample } from "@/pipeline/acceptance-gate";
import type { StackedHeads } from "@/pipeline/classifier-head";

// Head over 2-D, classes A/B; `boost` controls how decisively it favors the right axis.
function head(boost: number): StackedHeads {
  const base = { classes: ["A", "B"], W: [[boost, 0], [0, boost]], b: [0, 0], dim: 2 };
  const meta = { classes: ["A", "B"], W: [[boost, 0, boost, 0], [0, boost, 0, boost]], b: [0, 0], inDim: 4 };
  return { text: base, vision: base, meta };
}
// helper: N samples of a class at its axis
function samples(nA: number, nB: number): GateSample[] {
  const s: GateSample[] = [];
  for (let i = 0; i < nA; i++) s.push({ vecText: [1, 0], vecVision: [1, 0], truth: "A" });
  for (let i = 0; i < nB; i++) s.push({ vecText: [0, 1], vecVision: [0, 1], truth: "B" });
  return s;
}

describe("evaluateGate (overall+macro, catastrophic guard)", () => {
  const S = samples(30, 30);
  it("passes when both heads classify all correctly (no regression)", () => {
    const r = evaluateGate(head(5), head(5), S);
    expect(r.pass).toBe(true);
    expect(r.macroCandidate).toBeCloseTo(1, 5);
  });
  it("rejects when overall regresses", () => {
    // candidate boost 0 → ties → argmax picks index 0 ('A') → all B wrong → overall & macro down
    const r = evaluateGate(head(5), head(0), S);
    expect(r.pass).toBe(false);
  });
  it("does NOT veto a small per-class dip that isn't catastrophic and keeps macro up", () => {
    // current and candidate identical here → no regression; sanity that a tie passes
    const r = evaluateGate(head(5), head(5), S);
    expect(r.catastrophic).toEqual([]);
    expect(r.pass).toBe(true);
  });
  it("rejects a catastrophic single-class collapse on a well-supported class", () => {
    // 30 B samples (>=GATE_MIN_SUPPORT). candidate(0) sends all B→A: B recall 1→0 (>0.15 drop) → catastrophic
    const r = evaluateGate(head(5), head(0), samples(30, 30));
    expect(r.catastrophic).toContain("B");
    expect(r.pass).toBe(false);
  });
  it("exempts a tiny class (< GATE_MIN_SUPPORT) from the catastrophic guard", () => {
    // 30 A, 3 B. Candidate keeps A perfect, drops B (3 items < 20 support → not catastrophic).
    // Build a candidate that's perfect on A, wrong on B but overall+macro still ok? Use head(5) vs a head
    // that only knows A: W=[[5,0],[0,0]] → B ties → picks A. B recall 1→0 but exempt; macro 1→0.5, overall down.
    const onlyA: StackedHeads = {
      text: { classes: ["A","B"], W: [[5,0],[0,0]], b:[0,0], dim:2 },
      vision: { classes: ["A","B"], W: [[5,0],[0,0]], b:[0,0], dim:2 },
      meta: { classes:["A","B"], W:[[5,0,5,0],[0,0,0,0]], b:[0,0], inDim:4 },
    };
    const r = evaluateGate(head(5), onlyA, samples(30, 3));
    // B (3 items) is exempt from catastrophic, BUT macro still regressed (1→0.5) → rejected by the macro rule.
    expect(r.catastrophic).not.toContain("B");
    expect(r.pass).toBe(false);
  });
});
