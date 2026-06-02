import { describe, it, expect } from "vitest";
import { subcategoriesForFolder } from "@/ui/lib/group-by-subcategory";

describe("subcategoriesForFolder", () => {
  it("returns non-null subcategory buckets in alphabetical order", () => {
    const items = ["a", "b", "c", "d"];
    const assigned = new Map<string, string | null>([
      ["a", "Italian"],
      ["b", "French"],
      ["c", "Italian"],
      ["d", null],
    ]);
    const result = subcategoriesForFolder(items, assigned, []);
    expect(result).toEqual([
      { name: "French", itemIds: ["b"] },
      { name: "Italian", itemIds: ["a", "c"] },
    ]);
  });

  it("includes empty subcategories from the explicit list", () => {
    const items = ["a"];
    const assigned = new Map<string, string | null>([["a", "Italian"]]);
    const result = subcategoriesForFolder(items, assigned, ["French", "Korean"]);
    expect(result).toEqual([
      { name: "French", itemIds: [] },
      { name: "Italian", itemIds: ["a"] },
      { name: "Korean", itemIds: [] },
    ]);
  });

  it("does not duplicate subcats already present in items", () => {
    const items = ["a"];
    const assigned = new Map<string, string | null>([["a", "Italian"]]);
    const result = subcategoriesForFolder(items, assigned, ["Italian", "French"]);
    expect(result).toEqual([
      { name: "French", itemIds: [] },
      { name: "Italian", itemIds: ["a"] },
    ]);
  });

  it("returns empty array when no items have a subcategory and no empties given", () => {
    const items = ["a", "b"];
    const assigned = new Map<string, string | null>([["a", null], ["b", null]]);
    expect(subcategoriesForFolder(items, assigned, [])).toEqual([]);
  });

  it("returns empty array when items is empty and no empties given", () => {
    expect(subcategoriesForFolder([], new Map(), [])).toEqual([]);
  });
});
