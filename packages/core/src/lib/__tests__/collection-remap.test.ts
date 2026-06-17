import { describe, it, expect } from "vitest";
import {
  suggestCollectionMappings,
  type CollectionInput,
  type CategoryCentroid,
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
});
