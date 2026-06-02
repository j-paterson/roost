import { describe, it, expect } from "vitest";
import { groupBySubcategory } from "@/ui/lib/group-by-subcategory";

describe("groupBySubcategory", () => {
  it("groups items by their assigned subcategory", () => {
    const groups = groupBySubcategory(
      ["a", "b", "c", "d"],
      new Map<string, string | null>([
        ["a", "Italian"],
        ["b", "French"],
        ["c", "Italian"],
        ["d", null],
      ]),
    );
    expect(groups).toEqual([
      { subcategory: "French", itemIds: ["b"] },
      { subcategory: "Italian", itemIds: ["a", "c"] },
      { subcategory: null, itemIds: ["d"] },
    ]);
  });

  it("places [no subcategory] last", () => {
    const groups = groupBySubcategory(
      ["a", "b"],
      new Map<string, string | null>([
        ["a", null],
        ["b", "Italian"],
      ]),
    );
    expect(groups[0].subcategory).toBe("Italian");
    expect(groups[1].subcategory).toBe(null);
  });

  it("returns single [no subcategory] group when no items have subcategories", () => {
    const groups = groupBySubcategory(
      ["a", "b"],
      new Map(),
    );
    expect(groups).toEqual([{ subcategory: null, itemIds: ["a", "b"] }]);
  });

  it("returns empty array for empty input", () => {
    expect(groupBySubcategory([], new Map())).toEqual([]);
  });
});
