import { describe, it, expect } from "vitest";
import golden from "./fixtures/parity-golden.json";
import { trainStackedHeadsFromRows } from "@/pipeline/train-head";
import { classifyStacked } from "@/pipeline/classifier-head";

describe("TS trainer parity vs sklearn golden", () => {
  // TrainingRow requires an id field; add synthetic ids since trainStackedHeadsFromRows doesn't use them.
  const rows = golden.rows.map((r, i) => ({ ...r, id: String(i) }));
  const ts = trainStackedHeadsFromRows(rows)!;

  it("base-head weights match sklearn within tolerance", () => {
    const maxAbs = (A: number[][], B: number[][]) => {
      let m = 0;
      for (let i = 0; i < A.length; i++) for (let j = 0; j < A[i].length; j++)
        m = Math.max(m, Math.abs(A[i][j] - B[i][j]));
      return m;
    };
    expect(ts.text.classes).toEqual(golden.python.text.classes);
    expect(maxAbs(ts.text.W, golden.python.text.W)).toBeLessThan(0.05);
    expect(maxAbs(ts.vision.W, golden.python.vision.W)).toBeLessThan(0.05);
  });

  it("stacked predictions agree with the sklearn head on >= 99% of rows", () => {
    const tsMem = {
      text: { classes: ts.text.classes, W: ts.text.W, b: ts.text.b, dim: ts.text.dim },
      vision: { classes: ts.vision.classes, W: ts.vision.W, b: ts.vision.b, dim: ts.vision.dim },
      meta: { classes: ts.meta.classes, W: ts.meta.W, b: ts.meta.b, inDim: ts.meta.inDim },
    };
    const pyMem = {
      text: { classes: golden.python.text.classes, W: golden.python.text.W, b: golden.python.text.b, dim: golden.python.text.dim },
      vision: { classes: golden.python.vision.classes, W: golden.python.vision.W, b: golden.python.vision.b, dim: golden.python.vision.dim },
      meta: { classes: golden.python.meta.classes, W: golden.python.meta.W, b: golden.python.meta.b, inDim: golden.python.meta.inDim },
    };
    let agree = 0;
    for (const r of rows) {
      const a = classifyStacked(r.vecText, r.vecVision, tsMem).category;
      const b = classifyStacked(r.vecText, r.vecVision, pyMem).category;
      if (a === b) agree++;
    }
    expect(agree / rows.length).toBeGreaterThanOrEqual(0.99);
  });
});
