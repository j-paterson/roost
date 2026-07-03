// @vitest-environment node
import { describe, it, expect } from "vitest";
import { emptyTrainingSet, markBelongsNothing, isBelongsNothing, addRejection, suppressionMap } from "@/pipeline/training-set";
import { BELONGS_NOTHING } from "@/config";

describe("belongs-nothing sentinel", () => {
  it("marks + reads a terminal reject", () => {
    const ts = markBelongsNothing(emptyTrainingSet(), "id1");
    expect(isBelongsNothing(ts, "id1")).toBe(true);
    expect(ts.rejections["id1"]).toContain(BELONGS_NOTHING);
  });
  it("subsumes per-category rejections for that id", () => {
    const ts = emptyTrainingSet();
    addRejection(ts, "id1", "Food");
    markBelongsNothing(ts, "id1");
    expect(ts.rejections["id1"]).toEqual([BELONGS_NOTHING]);
  });
  it("suppressionMap does not surface the sentinel as a category", () => {
    const ts = markBelongsNothing(emptyTrainingSet(), "id1");
    expect(suppressionMap(ts).get("id1")?.has(BELONGS_NOTHING)).toBeFalsy();
  });
});
