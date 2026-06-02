import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import {
  galleryFilterLayoutState,
  galleryFilterMatchState,
  isGalleryFolderFilter,
  tryApplyGalleryFolderFilter,
} from "../gallery-filter-apply";

function mkEntry(i: number, fm: Record<string, unknown>): BasesEntry {
  return {
    file: { path: `Bookmarks/X/${i}.md` },
    getValue: (key: string) => fm[key],
  } as unknown as BasesEntry;
}

describe("galleryFilterMatchState", () => {
  it("clears match state when filter is null", () => {
    expect(galleryFilterMatchState(null)).toEqual({
      matchedRoostIds: null,
      matchDetailMap: null,
    });
  });
});

describe("isGalleryFolderFilter", () => {
  it("is true when folders array is non-empty", () => {
    expect(
      isGalleryFolderFilter({
        folders: [{ name: "A", itemIds: ["x"] }],
      } as never),
    ).toBe(true);
  });

  it("is false for empty folders or null filter", () => {
    expect(isGalleryFolderFilter({ folders: [] } as never)).toBe(false);
    expect(isGalleryFolderFilter(null)).toBe(false);
  });
});

describe("tryApplyGalleryFolderFilter", () => {
  it("returns null when filter has no folders", () => {
    const container = document.createElement("div");
    expect(
      tryApplyGalleryFolderFilter(null, container, {
        cardSize: 180,
        entries: [],
        imagePropId: "note.cover",
        resolveImageUrl: () => null,
        onFolderClick: () => {},
      }),
    ).toBeNull();
  });
});

describe("galleryFilterLayoutState", () => {
  it("pins matching ids to the front", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "a", "note.platform": "tiktok" }),
      mkEntry(1, { "note.roost_id": "b", "note.platform": "tiktok" }),
      mkEntry(2, { "note.roost_id": "c", "note.platform": "tiktok" }),
    ];
    const layout = galleryFilterLayoutState(
      entries,
      { itemIds: ["a", "b", "c"] },
      null,
      null,
      new Set(["c"]),
    );
    expect(layout.filteredIndices).toEqual([2, 0, 1]);
  });
});
