import { describe, it, expect } from "vitest";
import path from "node:path";
import { isExcluded } from "./scanner";

describe("isExcluded (recursive)", () => {
  it("excludes a top-level Archive directory", () => {
    expect(isExcluded(path.join("Archive", "old.md"))).toBe(true);
  });

  it("excludes a nested .obsidian directory", () => {
    expect(isExcluded(path.join("ObsidianVault", ".obsidian", "config.json"))).toBe(true);
  });

  it("excludes a deeply nested templates directory", () => {
    expect(isExcluded(path.join("Vaults", "VaultA", "templates", "daily.md"))).toBe(true);
  });

  it("does NOT exclude a regular nested file", () => {
    expect(isExcluded(path.join("ObsidianVault", "Dashboard", "note.md"))).toBe(false);
  });

  it("excludes any segment starting with a dot", () => {
    expect(isExcluded(path.join("ObsidianBookmarks", ".trash", "x.md"))).toBe(true);
  });

  it("does NOT exclude files where '.' appears mid-name (e.g. note.archive.md)", () => {
    expect(isExcluded(path.join("ObsidianVault", "note.archive.md"))).toBe(false);
  });

  it("excludes Synology Drive sync-conflict folders (any depth)", () => {
    expect(isExcluded(path.join("ObsidianVault_Jesses-MBP.localdomain_May-01-005444-2026_Conflict", "x.md"))).toBe(true);
    expect(isExcluded(path.join("ObsidianBookmarks", "Bookmarks_2026_Conflict", "x.md"))).toBe(true);
    // But not arbitrary uses of the word "Conflict" inside a normal name
    expect(isExcluded(path.join("Notes", "Conflict Resolution.md"))).toBe(false);
  });
});
