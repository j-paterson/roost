import { describe, it, expect } from "vitest";
import { buildCategoryDefs } from "./evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

/** Helper to make a cache entry with optional clipVec. */
function entry(vec: number[], clipVec?: number[]): EmbeddingCacheEntry {
  return { vision: null, summary: null, category: null, vec, clipVec: clipVec ?? null, vecText: null };
}

describe("buildCategoryDefs", () => {
  const descriptions = new Map([["catA", "Category A"], ["catB", "Category B"]]);

  it("computes text centroid from item vectors", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry([1, 0, 0]),
      a2: entry([0, 1, 0]),
    };
    const defs = buildCategoryDefs({ catA: ["a1", "a2"] }, descriptions, cache);
    expect(defs).toHaveLength(1);
    expect(defs[0].centroid[0]).toBeCloseTo(0.5);
    expect(defs[0].centroid[1]).toBeCloseTo(0.5);
    expect(defs[0].centroid[2]).toBeCloseTo(0);
  });

  it("computes clipCentroid when items have clipVec", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry([1, 0, 0], [0.8, 0.2, 0]),
      a2: entry([0, 1, 0], [0.2, 0.8, 0]),
    };
    const defs = buildCategoryDefs({ catA: ["a1", "a2"] }, descriptions, cache);
    expect(defs[0].clipCentroid).toBeDefined();
    expect(defs[0].clipCentroid![0]).toBeCloseTo(0.5);
    expect(defs[0].clipCentroid![1]).toBeCloseTo(0.5);
  });

  it("sets clipCentroid undefined when no items have clipVec", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry([1, 0, 0]),
      a2: entry([0, 1, 0]),
    };
    const defs = buildCategoryDefs({ catA: ["a1", "a2"] }, descriptions, cache);
    expect(defs[0].clipCentroid).toBeUndefined();
  });

  it("computes clipCentroid from partial coverage", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry([1, 0, 0], [0.6, 0.4, 0]),
      a2: entry([0, 1, 0]), // no clip vec
    };
    const defs = buildCategoryDefs({ catA: ["a1", "a2"] }, descriptions, cache);
    // clipCentroid computed only from a1
    expect(defs[0].clipCentroid).toBeDefined();
    expect(defs[0].clipCentroid![0]).toBeCloseTo(0.6);
    expect(defs[0].clipCentroid![1]).toBeCloseTo(0.4);
  });

  it("skips categories with no valid text vectors", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: { vision: null, summary: null, category: null, vec: null, clipVec: null, vecText: null },
    };
    const defs = buildCategoryDefs({ catA: ["a1"] }, descriptions, cache);
    expect(defs).toHaveLength(0);
  });

  it("builds defs for multiple categories independently", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry([1, 0], [1, 0]),
      b1: entry([0, 1]), // no clip
    };
    const defs = buildCategoryDefs(
      { catA: ["a1"], catB: ["b1"] },
      descriptions,
      cache,
    );
    expect(defs).toHaveLength(2);
    const defA = defs.find(d => d.name === "catA")!;
    const defB = defs.find(d => d.name === "catB")!;
    expect(defA.clipCentroid).toBeDefined();
    expect(defB.clipCentroid).toBeUndefined();
  });
});
