import { describe, it, expect } from "vitest";
import { seedPositives } from "@/pipeline/training-set-seed";
import { emptyTrainingSet, addRejection } from "@/pipeline/training-set";

describe("seedPositives", () => {
  it("seeds each label as a correction positive at seedTs", () => {
    const { ts, seeded, byClass } = seedPositives(
      [{ id: "a", category: "Tech" }, { id: "b", category: "Art" }],
      emptyTrainingSet(), 1,
    );
    expect(seeded).toBe(2);
    expect(ts.positives["a"]).toEqual({ category: "Tech", ts: 1 }); // no source key = correction
    expect(ts.positives["b"]).toEqual({ category: "Art", ts: 1 });
    expect(byClass).toEqual({ Tech: 1, Art: 1 });
  });

  it("skips labels whose category trims to empty", () => {
    const { ts, seeded } = seedPositives([{ id: "a", category: "  " }], emptyTrainingSet(), 1);
    expect(seeded).toBe(0);
    expect(ts.positives["a"]).toBeUndefined();
  });

  it("is idempotent by id (re-seeding does not duplicate)", () => {
    const ts0 = emptyTrainingSet();
    seedPositives([{ id: "a", category: "Tech" }], ts0, 1);
    const { ts, seeded } = seedPositives([{ id: "a", category: "Tech" }], ts0, 1);
    expect(seeded).toBe(1);
    expect(Object.keys(ts.positives)).toEqual(["a"]);
  });

  it("preserves existing rejections and overwrites a prior confirm with correction", () => {
    const ts0 = emptyTrainingSet();
    ts0.positives["a"] = { category: "Spicy", ts: 99, source: "confirm" };
    addRejection(ts0, "z", "Spicy");
    seedPositives([{ id: "a", category: "Spicy" }], ts0, 1);
    expect(ts0.positives["a"]).toEqual({ category: "Spicy", ts: 1 }); // promoted to correction (no source)
    expect(ts0.rejections["z"]).toEqual(["Spicy"]); // rejection untouched
  });
});
