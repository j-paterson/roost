/**
 * Integration: gatherVaultCollections + CollectionAliasMap. Pins the bug
 * scenario — rename "Finance Tips" → "Finances"; a new import from the old
 * TikTok collection must NOT re-create the old category node.
 */
import { describe, it, expect } from "vitest";
import { gatherVaultCollections } from "../vault-utils";
import type { CollectionAliasMap } from "../collection-aliases";
import type { App, TFile } from "obsidian";

type Fm = Record<string, unknown>;
function mkApp(files: { path: string; fm: Fm }[]): App {
  const fileObjs = files.map(f => ({ path: f.path } as TFile));
  const fmByPath = new Map(files.map(f => [f.path, f.fm]));
  return {
    vault: { getMarkdownFiles: () => fileObjs },
    metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: fmByPath.get(f.path) }) },
  } as unknown as App;
}

describe("collection alias end-to-end: phantom category prevention", () => {
  it("new import from same TikTok collection resolves to renamed category", () => {
    const app = mkApp([
      { path: "Bookmarks/TikTok/a.md", fm: { roost_id: "tiktok:1", platform: "tiktok", roost_category: "Finances", collection: "Finance Tips" } },
      { path: "Bookmarks/TikTok/b.md", fm: { roost_id: "tiktok:2", platform: "tiktok", roost_category: "Finances", collection: "Finance Tips" } },
      { path: "Bookmarks/TikTok/c.md", fm: { roost_id: "tiktok:3", platform: "tiktok", collection: "Finance Tips" } },
    ]);
    const aliases: CollectionAliasMap = { "tiktok:Finance Tips": "Finances" };
    const result = gatherVaultCollections(app, "Bookmarks", undefined, aliases);
    expect(result.itemCollections.get("tiktok:3")).toBe("Finances");
    expect(Object.keys(result.collections).sort()).toEqual(["Finances"]);
    expect(result.collections["Finances"]).toHaveLength(3);
    expect(result.collections["Finance Tips"]).toBeUndefined();
  });

  it("without alias map, baseline: new import creates a separate node", () => {
    const app = mkApp([
      { path: "Bookmarks/TikTok/a.md", fm: { roost_id: "tiktok:1", platform: "tiktok", roost_category: "Finances" } },
      { path: "Bookmarks/TikTok/c.md", fm: { roost_id: "tiktok:3", platform: "tiktok", collection: "Finance Tips" } },
    ]);
    const result = gatherVaultCollections(app, "Bookmarks");
    expect(Object.keys(result.collections).sort()).toEqual(["Finance Tips", "Finances"]);
  });
});
