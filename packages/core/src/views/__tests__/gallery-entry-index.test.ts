import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { galleryEntryAtIndex, galleryEntryCount } from "../gallery-entry-index";
import { findNeighborRoostId } from "../gallery-expand-focus";

function mkEntry(path: string, roostId: string): BasesEntry {
  return {
    file: { path },
    getValue: (key: string) => (key === "note.roost_id" ? roostId : undefined),
  } as unknown as BasesEntry;
}

describe("galleryEntryCount", () => {
  it("returns filteredIndices.length for filtered case", () => {
    const a = mkEntry("a.md", "a");
    const b = mkEntry("b.md", "b");
    const c = mkEntry("c.md", "c");
    expect(galleryEntryCount({ data: [a, b, c] }, [0, 2])).toBe(2);
  });

  it("returns sum of group.entries.length for grouped case (≥2 groups)", () => {
    const a = mkEntry("a.md", "a");
    const b = mkEntry("b.md", "b");
    const c = mkEntry("c.md", "c");
    const d = mkEntry("d.md", "d");
    const source = {
      data: [a, b, c, d],
      groupedData: [
        { groupValue: "g1", entries: [a, b] },
        { groupValue: "g2", entries: [c, d] },
      ],
    } as unknown as Parameters<typeof galleryEntryCount>[0];
    expect(galleryEntryCount(source, null)).toBe(4);
  });

  it("returns data.length for plain (unfiltered, ungrouped) case", () => {
    const a = mkEntry("a.md", "a");
    const b = mkEntry("b.md", "b");
    expect(galleryEntryCount({ data: [a, b] }, null)).toBe(2);
  });

  it("filtered takes precedence over grouped", () => {
    const a = mkEntry("a.md", "a");
    const b = mkEntry("b.md", "b");
    const c = mkEntry("c.md", "c");
    const source = {
      data: [a, b, c],
      groupedData: [
        { groupValue: "g1", entries: [a, b, c] },
      ],
    } as unknown as Parameters<typeof galleryEntryCount>[0];
    // filteredIndices=[0] should win over groupedData sum=3
    expect(galleryEntryCount(source, [0])).toBe(1);
  });
});

describe("galleryEntryAtIndex", () => {
  it("maps through filtered indices", () => {
    const a = mkEntry("a.md", "a");
    const b = mkEntry("b.md", "b");
    expect(
      galleryEntryAtIndex({ data: [a, b] }, [1], 0),
    ).toBe(b);
  });
});

describe("findNeighborRoostId", () => {
  it("returns the next item id in filter order", () => {
    const entries = [
      mkEntry("0.md", "a"),
      mkEntry("1.md", "b"),
      mkEntry("2.md", "c"),
    ];
    expect(findNeighborRoostId(entries, [0, 2], "a")).toBe("c");
  });

  it("falls back to previous when deleting last", () => {
    const entries = [mkEntry("0.md", "a"), mkEntry("1.md", "b")];
    expect(findNeighborRoostId(entries, [0, 1], "b")).toBe("a");
  });
});
