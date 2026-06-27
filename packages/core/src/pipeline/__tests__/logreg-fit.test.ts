import { describe, it, expect } from "vitest";
import { fitLogReg } from "@/pipeline/logreg-fit";
import { classifyWithHead } from "@/pipeline/classifier-head";

// Build a linearly-separable 3-class set in 4-D (axis-aligned clusters).
function dataset() {
  const X: number[][] = []; const y: string[] = [];
  const centers: Record<string, number[]> = {
    A: [3, 0, 0, 0], B: [0, 3, 0, 0], C: [0, 0, 3, 0],
  };
  const classes = ["A", "B", "C"];
  for (const c of classes) for (let k = 0; k < 10; k++) {
    const v = centers[c].map((x, i) => x + ((k % 3) - 1) * 0.01 * (i + 1));
    X.push(v); y.push(c);
  }
  return { X, y, classes };
}

describe("fitLogReg", () => {
  it("learns a separable problem (every training point classified correctly)", () => {
    const { X, y, classes } = dataset();
    const { W, b } = fitLogReg(X, y, classes, { C: 1, balanced: true });
    expect(W.length).toBe(3);
    expect(W[0].length).toBe(4);
    expect(b.length).toBe(3);
    const head = { classes, W, b, dim: 4 };
    let correct = 0;
    for (let i = 0; i < X.length; i++) if (classifyWithHead(X[i], head).category === y[i]) correct++;
    expect(correct).toBe(X.length);
  });

  it("balanced weighting recovers a rare class a majority would swamp", () => {
    // 30 of A, 2 of B at distinct centers; balanced must still classify the B points.
    const classes = ["A", "B"];
    const X: number[][] = []; const y: string[] = [];
    for (let k = 0; k < 30; k++) { X.push([2, 0]); y.push("A"); }
    for (let k = 0; k < 2; k++) { X.push([0, 2]); y.push("B"); }
    const head = { ...fitLogReg(X, y, classes, { C: 1, balanced: true }), dim: 2 };
    expect(classifyWithHead([0, 2], head).category).toBe("B");
  });

  it("is deterministic (same input → identical weights)", () => {
    const { X, y, classes } = dataset();
    const a = fitLogReg(X, y, classes, { C: 1, balanced: true });
    const b = fitLogReg(X, y, classes, { C: 1, balanced: true });
    expect(a.W).toEqual(b.W);
  });
});
