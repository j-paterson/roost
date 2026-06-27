import { describe, it, expect, beforeEach } from "vitest";
import { scoreAgainstCategories, __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

function unit(i: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
}

describe("scoreAgainstCategories suppression (centroid tier)", () => {
  beforeEach(() => __resetScoreCacheForTests());

  it("does not assign a suppressed class even when it is the nearest centroid", async () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vision: null, vec: unit(0), summary: "s", category: "c", vecText: null },
    };
    const cats: CategoryDef[] = [
      { name: "Tech", description: "", centroid: unit(0) },   // nearest
      { name: "Food", description: "", centroid: unit(1) },
    ];
    const res = await scoreAgainstCategories({
      itemIds: ["x"], cache, categories: cats, embeddingOnly: true,
      suppressedClasses: new Map([["x", new Set(["Tech"])]]),
    });
    // Tech suppressed → x must NOT be assigned Tech; it is below CENTROID_REJECT_TAU for Food → unmatched
    expect(res.assignments.get("x")).not.toBe("Tech");
    expect(res.unmatched).toContain("x");
  });
});
