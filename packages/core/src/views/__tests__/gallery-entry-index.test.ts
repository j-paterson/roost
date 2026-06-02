import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { galleryEntryAtIndex } from "../gallery-entry-index";
import { findNeighborRoostId } from "../gallery-expand-focus";

function mkEntry(path: string, roostId: string): BasesEntry {
  return {
    file: { path },
    getValue: (key: string) => (key === "note.roost_id" ? roostId : undefined),
  } as unknown as BasesEntry;
}

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
