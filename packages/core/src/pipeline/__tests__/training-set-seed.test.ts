import { describe, it, expect } from "vitest";
import { seedPositives, humanLabelsFromFrontmatter } from "@/pipeline/training-set-seed";
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

describe("humanLabelsFromFrontmatter", () => {
  it("keeps human items with a roost_id and non-empty category", () => {
    const out = humanLabelsFromFrontmatter([
      { roost_id: "a", roost_category: "Tech", roost_assigned_by: "human" },
      { roost_id: "b", roost_category: "Art", roost_assigned_by: "human" },
    ]);
    expect(out).toEqual([{ id: "a", category: "Tech" }, { id: "b", category: "Art" }]);
  });

  it("drops non-human, missing-id, and empty/sentinel categories", () => {
    const out = humanLabelsFromFrontmatter([
      { roost_id: "auto", roost_category: "Tech", roost_assigned_by: "auto" }, // not human
      { roost_category: "Tech", roost_assigned_by: "human" },                  // no roost_id
      { roost_id: "e1", roost_category: "  ", roost_assigned_by: "human" },     // empty
      { roost_id: "e2", roost_category: "null", roost_assigned_by: "human" },   // sentinel
      { roost_id: "e3", roost_assigned_by: "human" },                          // absent category
      undefined,                                                               // no frontmatter
    ]);
    expect(out).toEqual([]);
  });

  it("trims the category", () => {
    expect(humanLabelsFromFrontmatter([{ roost_id: "a", roost_category: " Tech ", roost_assigned_by: "human" }]))
      .toEqual([{ id: "a", category: "Tech" }]);
  });
});
