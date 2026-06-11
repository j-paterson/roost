import { describe, it, expect } from "vitest";
import { dedupDiscoveredByCentroid, CENTROID_DEDUP_THRESHOLD } from "../dedup-discovered";
import type { EmbeddingCacheEntry } from "@/types/roost";

/** Build a flat embedding vector: all dims set to `value`. Default dim=768 */
function vec(value: number, dim = 768): number[] {
  return new Array(dim).fill(value);
}

/** Build a one-hot vector at position `pos` with `dim` total dimensions. */
function oneHot(pos: number, dim = 768): number[] {
  const v = new Array(dim).fill(0);
  v[pos] = 1;
  return v;
}

function entry(v: number[] | null): EmbeddingCacheEntry {
  return { vision: null, summary: null, category: null, vec: v };
}

describe("dedupDiscoveredByCentroid", () => {
  it("exports CENTROID_DEDUP_THRESHOLD = 0.90", () => {
    expect(CENTROID_DEDUP_THRESHOLD).toBe(0.90);
  });

  it("case 1: merges two near-identical categories (identical vecs)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry(vec(1)),
      a2: entry(vec(1)),
      b1: entry(vec(1)),
    };
    const A = { name: "Alpha", itemIds: ["a1", "a2"] };
    const B = { name: "Beta", itemIds: ["b1"] };
    const result = dedupDiscoveredByCentroid([A, B], cache);

    expect(result.mergedCount).toBe(1);
    expect(result.discovered).toHaveLength(1);
    // The survivor is the larger category (A, size 2)
    expect(result.discovered[0].name).toBe("Alpha");
    // itemIds contains all three
    expect(result.discovered[0].itemIds.sort()).toEqual(["a1", "a2", "b1"]);
    // mergeLog has one entry
    expect(result.mergeLog).toHaveLength(1);
    expect(result.mergeLog[0]).toContain("merged Beta");
  });

  it("case 2: does not merge dissimilar categories (orthogonal one-hot vecs)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry(oneHot(0)),
      b1: entry(oneHot(1)),
    };
    const A = { name: "Alpha", itemIds: ["a1"] };
    const B = { name: "Beta", itemIds: ["b1"] };
    const result = dedupDiscoveredByCentroid([A, B], cache);

    expect(result.mergedCount).toBe(0);
    expect(result.discovered).toHaveLength(2);
    expect(result.mergeLog).toHaveLength(0);
    // itemIds must be untouched
    expect(A.itemIds).toEqual(["a1"]);
    expect(B.itemIds).toEqual(["b1"]);
  });

  it("case 3: skips categories with no embeddings in cache (no crash)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry(vec(1)),
      // "x1" is absent — no vec available
    };
    const A = { name: "Alpha", itemIds: ["a1"] };
    const X = { name: "NoVec", itemIds: ["x1"] };
    const result = dedupDiscoveredByCentroid([A, X], cache);

    // X has no usable vector — should never cause a merge
    expect(result.mergedCount).toBe(0);
    expect(result.discovered).toHaveLength(2);
  });

  it("case 4: single category is a no-op", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry(vec(1)),
    };
    const A = { name: "Alpha", itemIds: ["a1"] };
    const result = dedupDiscoveredByCentroid([A], cache);

    expect(result.mergedCount).toBe(0);
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]).toBe(A); // same reference
  });

  it("case 5: largest absorbs multiple (A size 3, B size 2, C size 1, all identical vecs)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a1: entry(vec(1)), a2: entry(vec(1)), a3: entry(vec(1)),
      b1: entry(vec(1)), b2: entry(vec(1)),
      c1: entry(vec(1)),
    };
    const A = { name: "Alpha", itemIds: ["a1", "a2", "a3"] };
    const B = { name: "Beta", itemIds: ["b1", "b2"] };
    const C = { name: "Gamma", itemIds: ["c1"] };
    const result = dedupDiscoveredByCentroid([A, B, C], cache);

    expect(result.mergedCount).toBe(2);
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].name).toBe("Alpha");
    expect(result.discovered[0].itemIds).toHaveLength(6);
    expect(result.discovered[0].itemIds.sort()).toEqual(["a1", "a2", "a3", "b1", "b2", "c1"]);
  });

  it("case 6: de-dups overlapping itemIds on merge", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: entry(vec(1)),
      y: entry(vec(1)),
      z: entry(vec(1)),
    };
    // keeper has ["x", "y"], absorbed has ["y", "z"] — "y" must not appear twice
    const keeper = { name: "Keeper", itemIds: ["x", "y"] };
    const absorbed = { name: "Absorbed", itemIds: ["y", "z"] };
    // Make keeper larger so it wins the sort (already size 2 > 1... wait, absorbed is size 2 too)
    // Ensure Keeper is size 2 and Absorbed is size 2 but Keeper sorts first (stable sort preserves order for equal sizes)
    // Actually let's make Keeper have 3 items to be unambiguous
    const cache2: Record<string, EmbeddingCacheEntry> = {
      x: entry(vec(1)),
      y: entry(vec(1)),
      z: entry(vec(1)),
      w: entry(vec(1)),
    };
    const k2 = { name: "Keeper", itemIds: ["x", "y", "w"] };
    const a2 = { name: "Absorbed", itemIds: ["y", "z"] };
    const result = dedupDiscoveredByCentroid([k2, a2], cache2);

    expect(result.mergedCount).toBe(1);
    expect(result.discovered).toHaveLength(1);
    const survivorIds = result.discovered[0].itemIds.sort();
    // "y" appears only once
    expect(survivorIds).toEqual(["w", "x", "y", "z"]);
    expect(survivorIds.filter(id => id === "y")).toHaveLength(1);
  });
});
