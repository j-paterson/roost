import { describe, it, expect } from "vitest";
import {
  suggestCollectionMappings,
  applyResolvedMappings,
  buildCategoryCentroids,
  type CollectionInput,
  type CategoryCentroid,
  type ResolvedMapping,
} from "../collection-remap";

const cats: CategoryCentroid[] = [
  { name: "Recipes", centroid: [1, 0] },
  { name: "Travel", centroid: [0, 1] },
];

describe("suggestCollectionMappings", () => {
  it("maps a collection whose member-centroid is near an existing category", () => {
    const cols: CollectionInput[] = [{ platform: "twitter", name: "Cooking ideas", memberVecs: [[0.9, 0.1], [1, 0]] }];
    const out = suggestCollectionMappings(cols, cats, {}, 0.8);
    expect(out[0]).toMatchObject({ action: "map", target: "Recipes" });
    expect(out[0].sim).toBeGreaterThan(0.8);
  });

  it("creates a new category (named after the collection) when nothing clears the threshold", () => {
    const cols: CollectionInput[] = [{ platform: "twitter", name: "Woodworking", memberVecs: [[-1, 0]] }];
    const out = suggestCollectionMappings(cols, cats, {}, 0.8);
    expect(out[0]).toMatchObject({ action: "create", target: "Woodworking" });
  });

  it("skips a collection that is already in the alias map", () => {
    const cols: CollectionInput[] = [{ platform: "tiktok", name: "Recipes", memberVecs: [[1, 0]] }];
    const out = suggestCollectionMappings(cols, cats, { "tiktok:Recipes": "Recipes" }, 0.8);
    expect(out[0]).toMatchObject({ action: "skip", target: "Recipes", sim: null });
  });

  it("creates (never crashes) when a collection has no member vectors", () => {
    const cols: CollectionInput[] = [{ platform: "twitter", name: "Empty", memberVecs: [] }];
    const out = suggestCollectionMappings(cols, cats, {}, 0.8);
    expect(out[0]).toMatchObject({ action: "create", target: "Empty", sim: null });
  });

  it("creates when there are no existing categories", () => {
    const cols: CollectionInput[] = [{ platform: "twitter", name: "Anything", memberVecs: [[1, 0]] }];
    const out = suggestCollectionMappings(cols, [], {}, 0.8);
    expect(out[0]).toMatchObject({ action: "create", target: "Anything", sim: null });
  });

  it("never self-matches: excludes the collection's own resolved category so cross-source merges surface", () => {
    // The X folder "Immersive (AR/VR)" resolves (via the collection fallback) to a
    // same-named category whose members ARE this collection's members -> cosine ~1.0.
    // Without the self-match guard the engine maps it to itself and never proposes the
    // real cross-source merge into TikTok's "VR".
    const catsWithSelf: CategoryCentroid[] = [
      { name: "Immersive (AR/VR)", centroid: [1, 0] }, // self (identical members)
      { name: "VR", centroid: [0.9, 0.1] }, // genuine cross-source target, above threshold
    ];
    const cols: CollectionInput[] = [
      { platform: "twitter", name: "Immersive (AR/VR)", memberVecs: [[1, 0]] },
    ];
    const out = suggestCollectionMappings(cols, catsWithSelf, {}, 0.8);
    expect(out[0]).toMatchObject({ action: "map", target: "VR" });
  });

  it("creates (own name) when the only candidate is the collection's own category", () => {
    const catsOnlySelf: CategoryCentroid[] = [{ name: "Loner", centroid: [1, 0] }];
    const cols: CollectionInput[] = [{ platform: "twitter", name: "Loner", memberVecs: [[1, 0]] }];
    const out = suggestCollectionMappings(cols, catsOnlySelf, {}, 0.8);
    expect(out[0]).toMatchObject({ action: "create", target: "Loner" });
  });
});

describe("applyResolvedMappings", () => {
  it("adds resolved mappings keyed by platform:collection, preserving existing entries", () => {
    const start = { "tiktok:Old": "Kept" };
    const resolved: ResolvedMapping[] = [
      { platform: "twitter", collection: "Cooking ideas", target: "Recipes" },
      { platform: "twitter", collection: "Woodworking", target: "Woodworking" }, // create => self-map
    ];
    const out = applyResolvedMappings(start, resolved);
    expect(out).toEqual({
      "tiktok:Old": "Kept",
      "twitter:Cooking ideas": "Recipes",
      "twitter:Woodworking": "Woodworking",
    });
    expect(start).toEqual({ "tiktok:Old": "Kept" }); // input not mutated
  });
});

describe("buildCategoryCentroids", () => {
  it("computes a mean centroid per category and drops categories with no cached vectors", () => {
    const categories = { Recipes: ["a", "b"], Empty: ["missing"] };
    const cache = { a: { vec: [2, 0] }, b: { vec: [0, 2] } } as Record<string, { vec: number[] }>;
    const out = buildCategoryCentroids(categories, cache);
    expect(out).toEqual([{ name: "Recipes", centroid: [1, 1] }]);
  });
});
