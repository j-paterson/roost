import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { computeGalleryFilterIndices } from "../gallery-filter-indices";

function mkEntry(i: number, fm: Record<string, unknown>): BasesEntry {
  return {
    file: { path: `Bookmarks/X/${i}.md` },
    getValue: (key: string) => fm[key],
  } as unknown as BasesEntry;
}

describe("computeGalleryFilterIndices", () => {
  it("filters by platform when filter is null", () => {
    const entries = [
      mkEntry(0, { "note.platform": "tiktok" }),
      mkEntry(1, { "note.platform": "twitter" }),
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: null,
      activePlatformFilter: "tiktok",
      matchDetailMap: null,
    });
    expect(result.filteredIndices).toEqual([0]);
  });

  it("filters by itemIds", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "a" }),
      mkEntry(1, { "note.roost_id": "b" }),
      mkEntry(2, { "note.roost_id": "c" }),
    ];
    const result = computeGalleryFilterIndices({
      entries,
      filter: { itemIds: ["b", "a"] },
      activePlatformFilter: null,
      matchDetailMap: null,
    });
    expect(result.filteredIndices?.sort()).toEqual([0, 1]);
  });
});
