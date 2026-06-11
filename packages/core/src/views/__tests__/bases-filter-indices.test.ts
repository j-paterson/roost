import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { computeExplorerFolderIndices } from "../bases-filter-indices";

function mkEntry(path: string, parentPath?: string): BasesEntry {
  return {
    file: {
      path,
      parent: parentPath ? { path: parentPath } : null,
    },
  } as unknown as BasesEntry;
}

describe("computeExplorerFolderIndices", () => {
  it("includes entries that start with folderPath/ prefix", () => {
    const entries = [
      mkEntry("Notes/a.md", "Notes"),
      mkEntry("Notes/sub/b.md", "Notes/sub"),
      mkEntry("Other/c.md", "Other"),
    ];
    const result = computeExplorerFolderIndices(entries, "Notes");
    expect(result).toEqual([0, 1]);
  });

  it("includes entry whose parent.path equals folderPath even if path doesn't start with prefix", () => {
    // "a.md" does NOT start with "Notes/" but its parent is "Notes"
    const entries = [
      mkEntry("a.md", "Notes"),
    ];
    const result = computeExplorerFolderIndices(entries, "Notes");
    expect(result).toEqual([0]);
  });

  it("returns empty array when no entries match folderPath", () => {
    const entries = [
      mkEntry("Notes/a.md", "Notes"),
      mkEntry("Notes/sub/b.md", "Notes/sub"),
      mkEntry("Other/c.md", "Other"),
    ];
    const result = computeExplorerFolderIndices(entries, "Missing");
    expect(result).toEqual([]);
  });

  it("does NOT match entries under a folder that shares a prefix but is not the folder", () => {
    // folderPath "Note" must not match "Notes/a.md" (prefix is "Note/", parent is "Notes")
    const entries = [
      mkEntry("Notes/a.md", "Notes"),
    ];
    const result = computeExplorerFolderIndices(entries, "Note");
    expect(result).toEqual([]);
  });
});
