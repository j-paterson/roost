import { describe, it, expect } from "vitest";
import {
  resolveCollectionAlias,
  makeAliasKey,
  type CollectionAliasMap,
} from "../collection-aliases";

describe("makeAliasKey", () => {
  it("produces tiktok-prefixed key", () => {
    expect(makeAliasKey("tiktok", "My Collection")).toBe("tiktok:My Collection");
  });
  it("preserves spaces and capitalisation", () => {
    expect(makeAliasKey("tiktok", "Funny Pets 2024")).toBe("tiktok:Funny Pets 2024");
  });
});

describe("resolveCollectionAlias", () => {
  it("returns the mapped category when key exists", () => {
    const map: CollectionAliasMap = { "tiktok:Finance Tips": "Finances" };
    expect(resolveCollectionAlias(map, "tiktok", "Finance Tips")).toBe("Finances");
  });
  it("returns undefined when key is absent", () => {
    expect(resolveCollectionAlias({}, "tiktok", "Unknown")).toBeUndefined();
  });
  it("returns undefined when collectionName is null/undefined", () => {
    const map: CollectionAliasMap = { "tiktok:X": "Y" };
    expect(resolveCollectionAlias(map, "tiktok", null)).toBeUndefined();
    expect(resolveCollectionAlias(map, "tiktok", undefined)).toBeUndefined();
  });
  it("returns undefined when map is null/undefined", () => {
    expect(resolveCollectionAlias(undefined, "tiktok", "Finance Tips")).toBeUndefined();
    expect(resolveCollectionAlias(null as unknown as CollectionAliasMap, "tiktok", "Finance Tips")).toBeUndefined();
  });
});
