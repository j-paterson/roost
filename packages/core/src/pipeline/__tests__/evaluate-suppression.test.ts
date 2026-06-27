import { describe, it, expect, beforeEach } from "vitest";
import { scoreAgainstCategories, __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";
import { mkStackedHeads } from "./helpers-stacked";

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

describe("scoreAgainstCategories suppression (head tier)", () => {
  beforeEach(() => __resetScoreCacheForTests());

  it("does not assign a suppressed class when the stacked head confidently predicts it; falls through to centroid fallback", async () => {
    // Stacked head with classes ["A","B","C"]: item vec at dim-0 fires "A" with
    // conf ≈ 1.0, well above HEAD_REJECT_TAU=0.6149.
    const stacked = mkStackedHeads(["A", "B", "C"]);

    // Item "x": unit vector at dim 0 → head emits "A" confidently.
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vision: null, vec: [9, 0, 0, 0], vecText: [9, 0, 0, 0], summary: "s", category: null },
    };

    // Categories: "A" (same centroid direction as item) and "B" (fallback).
    // Both centroids align with item so after "A" is suppressed from ranked,
    // "B" remains at sim=1.0 ≥ CENTROID_REJECT_TAU=0.50 → centroid fallback.
    const cats: CategoryDef[] = [
      { name: "A", description: "", centroid: unit(0) },
      { name: "B", description: "", centroid: unit(0) },
    ];

    // Control: WITHOUT suppression → head tier fires and assigns "A".
    const resControl = await scoreAgainstCategories({
      itemIds: ["x"], cache, categories: cats,
      embeddingOnly: true, stackedHeads: stacked,
    });
    expect(resControl.assignments.get("x")).toBe("A");

    // WITH suppression: "A" is banned for item "x".
    // Head emits "A" → suppression drops it → centroid tier picks "B" → assigned "B".
    const res = await scoreAgainstCategories({
      itemIds: ["x"], cache, categories: cats,
      embeddingOnly: true, stackedHeads: stacked,
      suppressedClasses: new Map([["x", new Set(["A"])]]),
    });
    expect(res.assignments.get("x")).not.toBe("A");
    expect(res.assignments.get("x")).toBe("B");
    expect(res.unmatched).not.toContain("x");
  });
});
