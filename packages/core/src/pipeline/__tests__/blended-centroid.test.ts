import { describe, it, expect } from "vitest";
import { buildCategoryDefs, hashCategoryDefs } from "../evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

function vec(value: number, dim = 4): number[] {
  return new Array(dim).fill(value);
}

function entry(v: number): EmbeddingCacheEntry {
  return { vision: null, summary: null, category: null, vec: vec(v), vecText: null };
}

describe("buildCategoryDefs blended centroid", () => {
  it("returns pure name vector when collection has zero items", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    const collections = { Music: [] };
    const nameEmbeddings = new Map<string, number[]>([["music", vec(0.7)]]);
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Music");
    // L2-normalized vec(0.7) at dim=4 → [0.5, 0.5, 0.5, 0.5]
    for (const x of defs[0].centroid) expect(x).toBeCloseTo(0.5, 5);
  });

  it("name vector dominates at n=5 with realistic vectors", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    // 5 items pointing in +x direction
    for (let i = 0; i < 5; i++) cache[`a${i}`] = entry(1.0);
    const collections = { Music: ["a0", "a1", "a2", "a3", "a4"] };
    // Name vector pointing in -x direction (opposite)
    const nameEmbeddings = new Map<string, number[]>([["music", vec(-1.0)]]);
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    // w_items ≈ 0.2403, w_name ≈ 0.7597. Net direction is -x.
    expect(defs[0].centroid[0]).toBeLessThan(0);
  });

  it("item centroid dominates at n=200", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    for (let i = 0; i < 200; i++) cache[`a${i}`] = entry(1.0);
    const collections = { Music: Array.from({ length: 200 }, (_, i) => `a${i}`) };
    const nameEmbeddings = new Map<string, number[]>([["music", vec(-1.0)]]);
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    // w_items = sqrt(200) / (sqrt(200) + sqrt(50)) ≈ 0.667. Net +x (items dominate).
    expect(defs[0].centroid[0]).toBeGreaterThan(0);
  });

  it("falls back to pure-item centroid when name embedding is missing", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    cache["a0"] = entry(1.0);
    const collections = { Music: ["a0"] };
    const nameEmbeddings = new Map<string, number[]>(); // empty
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    // Pure item: [1,1,1,1] (no normalization in legacy path)
    expect(defs[0].centroid).toEqual(vec(1.0));
  });

  it("skips collections with no items AND no name embedding", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    const collections = { Music: [] };
    const nameEmbeddings = new Map<string, number[]>();
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    expect(defs).toEqual([]);
  });

  it("uses lowercase name for nameEmbeddings lookup", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    const collections = { "Video Game": [] };
    const nameEmbeddings = new Map<string, number[]>([["video game", vec(0.5)]]);
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Video Game");
  });

  it("output centroid is L2-normalized when blending occurred", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    for (let i = 0; i < 5; i++) cache[`a${i}`] = entry(2.0); // big magnitude items
    const collections = { Music: ["a0", "a1", "a2", "a3", "a4"] };
    const nameEmbeddings = new Map<string, number[]>([["music", vec(3.0)]]);
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    const norm = Math.sqrt(defs[0].centroid.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("preserves backward compatibility — works without nameEmbeddings parameter", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    for (let i = 0; i < 5; i++) cache[`a${i}`] = entry(1.0);
    const collections = { Music: ["a0", "a1", "a2", "a3", "a4"] };
    const defs = buildCategoryDefs(collections, new Map(), cache);
    // Without nameEmbeddings, behaves like today: pure-item centroid, no normalization.
    expect(defs).toHaveLength(1);
    expect(defs[0].centroid).toEqual(vec(1.0));
  });
});

describe("hashCategoryDefs (score-cache key invalidation)", () => {
  it("differs when centroid bytes differ", () => {
    const a = [{ name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: undefined }];
    const b = [{ name: "Music", centroid: [9, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: undefined }];
    expect(hashCategoryDefs(a, "model", "promptv1")).not.toEqual(
      hashCategoryDefs(b, "model", "promptv1")
    );
  });

  it("matches when only ordering of categories differs (sorted by name)", () => {
    const a = [
      { name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: undefined },
      { name: "Anime", centroid: [4, 5, 6, 7, 8, 9, 0, 1], description: "e", notDescription: undefined },
    ];
    const b = [...a].reverse();
    expect(hashCategoryDefs(a, "model", "promptv1")).toEqual(
      hashCategoryDefs(b, "model", "promptv1")
    );
  });

  it("differs when the model or prompt version changes", () => {
    const defs = [{ name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: undefined }];
    expect(hashCategoryDefs(defs, "modelA", "v1")).not.toEqual(hashCategoryDefs(defs, "modelB", "v1"));
    expect(hashCategoryDefs(defs, "modelA", "v1")).not.toEqual(hashCategoryDefs(defs, "modelA", "v2"));
  });

  it("differs when description or notDescription changes", () => {
    const a = [{ name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: undefined }];
    const b = [{ name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "different", notDescription: undefined }];
    expect(hashCategoryDefs(a, "model", "v1")).not.toEqual(hashCategoryDefs(b, "model", "v1"));

    const c = [{ name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: "no" }];
    expect(hashCategoryDefs(a, "model", "v1")).not.toEqual(hashCategoryDefs(c, "model", "v1"));
  });

  it("matches when called twice with identical input", () => {
    const defs = [{ name: "Music", centroid: [1, 2, 3, 4, 5, 6, 7, 8], description: "d", notDescription: undefined }];
    expect(hashCategoryDefs(defs, "model", "v1")).toEqual(hashCategoryDefs(defs, "model", "v1"));
  });
});
