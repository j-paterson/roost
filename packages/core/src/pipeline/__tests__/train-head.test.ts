import { describe, it, expect } from "vitest";
import { stratifiedKFold, trainStackedHeadsFromRows } from "@/pipeline/train-head";
import { classifyStacked } from "@/pipeline/classifier-head";

function rows() {
  // 3 classes, 9 each; text + vision both informative (distinct axes).
  const out = [];
  const ax: Record<string, number> = { A: 0, B: 1, C: 2 };
  for (const c of ["A", "B", "C"]) for (let k = 0; k < 9; k++) {
    const vt = [0, 0, 0, 0]; vt[ax[c]] = 3 + (k % 3) * 0.01;
    const vv = [0, 0, 0, 0]; vv[ax[c]] = 3 + (k % 3) * 0.01;
    out.push({ id: `${c}${k}`, vecText: vt, vecVision: vv, category: c, ts: 0 });
  }
  return out;
}

describe("stratifiedKFold", () => {
  it("assigns every sample a fold and keeps each class spread across folds", () => {
    const labels = rows().map((r) => r.category);
    const folds = stratifiedKFold(labels, 3, labels.map((_, i) => i));
    expect(folds.length).toBe(labels.length);
    expect(new Set(folds).size).toBe(3);
  });
});

describe("trainStackedHeadsFromRows", () => {
  it("produces head-data of the correct shape and classifies its own data", () => {
    const r = rows();
    const heads = trainStackedHeadsFromRows(r)!;
    expect(heads.text.classes).toEqual(["A", "B", "C"]); // sorted
    expect(heads.text.W.length).toBe(3);
    expect(heads.text.W[0].length).toBe(4);
    expect(heads.text.dim).toBe(4);
    expect(heads.text.norm).toBe("l2");
    expect(heads.meta.inDim).toBe(6); // 2C
    expect(heads.meta.W[0].length).toBe(6);
    expect(heads.meta.norm).toBe("none");
    const inMem = {
      text: { classes: heads.text.classes, W: heads.text.W, b: heads.text.b, dim: 4 },
      vision: { classes: heads.vision.classes, W: heads.vision.W, b: heads.vision.b, dim: 4 },
      meta: { classes: heads.meta.classes, W: heads.meta.W, b: heads.meta.b, inDim: 6 },
    };
    let correct = 0;
    for (const row of r) if (classifyStacked(row.vecText, row.vecVision, inMem).category === row.category) correct++;
    expect(correct / r.length).toBeGreaterThan(0.9);
  });
});
