import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { computeGalleryFilterIndices, sinkGreenIndices } from "../gallery-filter-indices";

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

describe("sinkGreenIndices", () => {
  it("returns indices unchanged when humanIds is empty", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "blue1" }),
      mkEntry(1, { "note.roost_id": "blue2" }),
    ];
    expect(sinkGreenIndices([0, 1], entries, new Set())).toEqual([0, 1]);
  });

  it("sinks human-assigned (green) indices after non-human (blue) indices", () => {
    // Entry indices in matched (blue) order: [0=blue1, 1=green1, 2=blue2, 3=green2]
    // Human set: green1, green2
    // Expected: [0=blue1, 2=blue2, 1=green1, 3=green2]
    const entries = [
      mkEntry(0, { "note.roost_id": "blue1" }),
      mkEntry(1, { "note.roost_id": "green1" }),
      mkEntry(2, { "note.roost_id": "blue2" }),
      mkEntry(3, { "note.roost_id": "green2" }),
    ];
    const result = sinkGreenIndices([0, 1, 2, 3], entries, new Set(["green1", "green2"]));
    expect(result).toEqual([0, 2, 1, 3]);
  });

  it("preserves blue ordering and green ordering within their respective groups", () => {
    // Simulate: matched items [2, 0] (sorted by score) with [1, 3] human-assigned
    const entries = [
      mkEntry(0, { "note.roost_id": "blue2" }),
      mkEntry(1, { "note.roost_id": "green1" }),
      mkEntry(2, { "note.roost_id": "blue1" }),
      mkEntry(3, { "note.roost_id": "green2" }),
    ];
    const result = sinkGreenIndices([2, 0, 1, 3], entries, new Set(["green1", "green2"]));
    // Blue: indices 2 (blue1), 0 (blue2) — input order preserved
    // Green: indices 1 (green1), 3 (green2) — input order preserved
    expect(result).toEqual([2, 0, 1, 3]);
  });

  it("treats entries without a roostId as non-human (blue)", () => {
    const entries = [
      mkEntry(0, {}),                              // no roostId → blue
      mkEntry(1, { "note.roost_id": "green1" }),   // human → green
    ];
    const result = sinkGreenIndices([0, 1], entries, new Set(["green1"]));
    expect(result).toEqual([0, 1]);
  });
});
