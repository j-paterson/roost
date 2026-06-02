import { describe, it, expect } from "vitest";
import { suggestNeighbors } from "./suggest-neighbors";
import type { EmbeddingCacheEntry } from "@/types/roost";

function entry(vec: number[], clipVec?: number[]): EmbeddingCacheEntry {
  return { vision: null, summary: null, category: null, vec, clipVec: clipVec ?? null };
}

describe("suggestNeighbors", () => {
  it("suggests items closer to target than source", () => {
    // target group is at [1,0], source group is at [0,1]
    // candidate item3 is at [0.8, 0.2] — closer to target
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: entry([1, 0]),
      target1: entry([0.9, 0.1]),
      source1: entry([0, 1]),
      source2: entry([0.1, 0.9]),
      item3: entry([0.8, 0.2]),   // should be suggested
      item4: entry([0.1, 0.95]),  // should NOT be suggested
    };

    const result = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1", "source2", "item3", "item4"] },
      targetGroupItemIds: ["moved1", "target1"],
      cache,
    });

    const suggested = result.map(s => s.itemId);
    expect(suggested).toContain("item3");
    expect(suggested).not.toContain("item4");
  });

  it("returns empty when no items meet minDelta", () => {
    // All items are equally close to both centroids
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: entry([1, 0]),
      target1: entry([0.5, 0.5]),
      source1: entry([0.5, 0.5]),
    };

    const result = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1"] },
      targetGroupItemIds: ["moved1", "target1"],
      cache,
      minDelta: 0.5, // high bar
    });

    expect(result).toHaveLength(0);
  });

  it("uses CLIP fusion when clipVec is available", () => {
    // text vectors say item3 is equidistant between target and source
    // but CLIP vectors say item3 is clearly target-like
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: entry([1, 0], [1, 0]),
      target1: entry([0.9, 0.1], [0.95, 0.05]),
      source1: entry([0, 1], [0, 1]),
      source2: entry([0.1, 0.9], [0.05, 0.95]),
      // text: midpoint between target/source. clip: strongly target-like
      item3: entry([0.5, 0.5], [0.9, 0.1]),
    };

    const resultWithClip = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1", "source2", "item3"] },
      targetGroupItemIds: ["moved1", "target1"],
      cache,
      minDelta: 0.02,
    });

    // With CLIP fusion, item3's CLIP vector should push it toward target
    expect(resultWithClip.map(s => s.itemId)).toContain("item3");
  });

  it("falls back to text-only when clipVec is missing", () => {
    // item3 is clearly closer to target by text alone
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: entry([1, 0]),
      target1: entry([0.9, 0.1]),
      source1: entry([0, 1]),
      item3: entry([0.85, 0.15]), // no clipVec, clearly target-like
    };

    const result = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1", "item3"] },
      targetGroupItemIds: ["moved1", "target1"],
      cache,
    });

    expect(result.map(s => s.itemId)).toContain("item3");
    expect(result[0].delta).toBeGreaterThan(0);
  });

  it("returns empty when target has no vectors", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: { vision: null, summary: null, category: null, vec: null, clipVec: null },
      source1: entry([0, 1]),
    };

    const result = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1"] },
      targetGroupItemIds: ["moved1"],
      cache,
    });

    expect(result).toHaveLength(0);
  });

  it("respects maxSuggestions", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: entry([1, 0]),
      target1: entry([0.9, 0.1]),
      source1: entry([0, 1]),
      item1: entry([0.8, 0.2]),
      item2: entry([0.7, 0.3]),
      item3: entry([0.6, 0.4]),
    };

    const result = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1", "item1", "item2", "item3"] },
      targetGroupItemIds: ["moved1", "target1"],
      cache,
      maxSuggestions: 2,
    });

    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("sorts by delta descending", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      moved1: entry([1, 0]),
      target1: entry([0.95, 0.05]),
      source1: entry([-0.1, 1]),  // clearly source-like
      item1: entry([0.8, 0.2]),   // moderate delta toward target
      item2: entry([0.95, 0.05]), // high delta toward target
    };

    const result = suggestNeighbors({
      movedItemIds: ["moved1"],
      sourceGroupItemIds: { srcGroup: ["source1", "item1", "item2"] },
      targetGroupItemIds: ["moved1", "target1"],
      cache,
      minDelta: 0.02,
    });

    expect(result.length).toBe(2);
    expect(result[0].delta).toBeGreaterThanOrEqual(result[1].delta);
    expect(result[0].itemId).toBe("item2");
  });
});
