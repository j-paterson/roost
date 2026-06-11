import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { computeGalleryFilterIndices } from "../gallery-filter-indices";

function mkEntry(i: number, fm: Record<string, unknown>): BasesEntry {
  return {
    file: { path: `Bookmarks/X/${i}.md` },
    getValue: (key: string) => fm[key],
  } as unknown as BasesEntry;
}

describe("computeGalleryFilterIndices — category cross-product branch", () => {
  it("category-only filter: includes matching entries with roost_id, excludes mismatched and missing roost_id", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "id0", "note.roost_category": "Food" }),           // match
      mkEntry(1, { "note.roost_id": "id1", "note.roost_category": "Travel" }),         // wrong category
      mkEntry(2, { "note.roost_category": "Food" }),                                   // no roost_id → excluded
      mkEntry(3, { "note.roost_id": "id3", "note.roost_category": "Food" }),           // match
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: { category: "Food" },
      activePlatformFilter: null,
      matchDetailMap: null,
    });
    expect(result.filteredIndices).toEqual([0, 3]);
    expect(result.splitMode).toBe(false);
  });

  it("category + subcategory filter: only exact subcategory match passes", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "id0", "note.roost_category": "Food", "note.roost_subcategory": "Ramen" }),   // match
      mkEntry(1, { "note.roost_id": "id1", "note.roost_category": "Food", "note.roost_subcategory": "Sushi" }),   // wrong subcat
      mkEntry(2, { "note.roost_id": "id2", "note.roost_category": "Food" }),                                      // no subcat → excluded
      mkEntry(3, { "note.roost_id": "id3", "note.roost_category": "Food", "note.roost_subcategory": "Ramen" }),   // match
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: { category: "Food", subcategory: "Ramen" },
      activePlatformFilter: null,
      matchDetailMap: null,
    });
    expect(result.filteredIndices).toEqual([0, 3]);
  });

  it("null-category filter: includes only entries with roost_id and NO category", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "id0" }),                                          // no category → match
      mkEntry(1, { "note.roost_id": "id1", "note.roost_category": "Food" }),           // has category → excluded
      mkEntry(2, { "note.roost_id": "id2" }),                                          // no category → match
      mkEntry(3, {}),                                                                   // no roost_id → excluded
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: { category: null },
      activePlatformFilter: null,
      matchDetailMap: null,
    });
    expect(result.filteredIndices).toEqual([0, 2]);
  });

  it("platform overlay on category branch: excludes entries on different platform", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "id0", "note.roost_category": "Food", "note.platform": "tiktok" }),   // match
      mkEntry(1, { "note.roost_id": "id1", "note.roost_category": "Food", "note.platform": "twitter" }),  // wrong platform
      mkEntry(2, { "note.roost_id": "id2", "note.roost_category": "Food", "note.platform": "tiktok" }),   // match
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: { category: "Food" },
      activePlatformFilter: "tiktok",
      matchDetailMap: null,
    });
    expect(result.filteredIndices).toEqual([0, 2]);
  });

  it("split mode: entries in certainItemIds → certain, uncertainItemIds → uncertain, in itemIds but neither → certain", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "a" }),   // certain
      mkEntry(1, { "note.roost_id": "b" }),   // uncertain
      mkEntry(2, { "note.roost_id": "c" }),   // in itemIds but neither set → certain
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: {
        itemIds: ["a", "b", "c"],
        certainItemIds: ["a"],
        uncertainItemIds: ["b"],
      },
      activePlatformFilter: null,
      matchDetailMap: null,
    });
    expect(result.splitMode).toBe(true);
    // a (idx 0) and c (idx 2) are certain; b (idx 1) is uncertain
    expect(result.certainIndicesSplit).toContain(0);
    expect(result.certainIndicesSplit).toContain(2);
    expect(result.uncertainIndicesSplit).toContain(1);
    // filteredIndices = certain first, then uncertain
    expect(result.filteredIndices).toEqual([...(result.certainIndicesSplit ?? []), ...(result.uncertainIndicesSplit ?? [])]);
    // uncertainRoostIds is a Set containing "b"
    expect(result.uncertainRoostIds).toBeInstanceOf(Set);
    expect(result.uncertainRoostIds?.has("b")).toBe(true);
    expect(result.uncertainRoostIds?.has("a")).toBe(false);
  });
});
