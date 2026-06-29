import { describe, it, expect } from "vitest";
import { stratifiedKFold, trainStackedHeadsFromRows, selectTrainingPositives } from "@/pipeline/train-head";
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

const P = (category: string, ts: number, source?: "correction" | "confirm") => ({ category, ts, source });

it("admits all correction positives, uncapped", () => {
  const positives = { a: P("Tech", 1), b: P("Tech", 2), c: P("Tech", 3) };
  const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
  expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
});

it("caps confirms at ratio × corrections per class", () => {
  // Tech: 1 correction → cap = 2 confirms admitted out of 4
  const positives = {
    k: P("Tech", 1, "correction"),
    a: P("Tech", 2, "confirm"), b: P("Tech", 3, "confirm"),
    c: P("Tech", 4, "confirm"), d: P("Tech", 5, "confirm"),
  };
  const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
  const confirms = out.filter((r) => r.id !== "k");
  expect(out.some((r) => r.id === "k")).toBe(true); // correction always admitted
  expect(confirms.length).toBe(2);                  // 2.0 × 1 correction
});

it("a class with 0 corrections admits 0 confirms (cannot build a class alone)", () => {
  const positives = { a: P("Art", 1, "confirm"), b: P("Art", 2, "confirm") };
  const out = selectTrainingPositives(positives, new Set(["Art"]), 2.0);
  expect(out).toEqual([]);
});

it("excludes positives whose category is not eligible", () => {
  const positives = { a: P("Tech", 1, "correction"), b: P("Rare", 2, "correction") };
  const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
  expect(out.map((r) => r.id)).toEqual(["a"]);
});

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
