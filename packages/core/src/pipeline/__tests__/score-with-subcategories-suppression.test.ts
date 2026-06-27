import { describe, it, expect, beforeEach } from "vitest";
import { scoreWithSubcategories } from "@/pipeline/score-with-subcategories";
import { __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

function unit(i: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
}

describe("scoreWithSubcategories forwards suppression to pass 1", () => {
  beforeEach(() => __resetScoreCacheForTests());
  it("a suppressed class is not assigned in pass 1", async () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vision: null, vec: unit(0), summary: "s", category: "c", vecText: null },
    };
    const cats: CategoryDef[] = [{ name: "Tech", description: "", centroid: unit(0) }];
    const res = await scoreWithSubcategories({
      itemIds: ["x"], cache, topLevelCategories: cats, embeddingOnly: true,
      subcatsByParent: new Map(),
      suppressedClasses: new Map([["x", new Set(["Tech"])]]),
    });
    // When the only candidate is suppressed, the item should be unmatched (not assigned).
    expect(res.assignments.get("x")).toBeUndefined();
    expect(res.unmatched).toContain("x");
  });
});
