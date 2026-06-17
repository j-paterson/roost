import { describe, it, expect } from "vitest";
import { gatherSourceCollections } from "../collection-remap-inputs";
import type { App, TFile } from "obsidian";

// Minimal stub app: two twitter files in one folder, one tiktok file, one unsorted.
function stubApp(): App {
  const files = [
    { path: "Bookmarks/a.md", fm: { roost_id: "a", platform: "twitter", collection: "Cooking ideas" } },
    { path: "Bookmarks/b.md", fm: { roost_id: "b", platform: "twitter", collection: "Cooking ideas" } },
    { path: "Bookmarks/c.md", fm: { roost_id: "c", platform: "tiktok", collection: "Recipes" } },
    { path: "Bookmarks/d.md", fm: { roost_id: "d", platform: "twitter" } }, // no collection -> ignored
  ];
  return {
    vault: { getMarkdownFiles: () => files.map((f) => ({ path: f.path } as TFile)) },
    metadataCache: {
      getFileCache: (file: TFile) => ({ frontmatter: files.find((f) => f.path === file.path)!.fm }),
    },
  } as unknown as App;
}

describe("gatherSourceCollections", () => {
  it("groups roost_ids by (platform, collection) within the sync folder", () => {
    const out = gatherSourceCollections(stubApp(), "Bookmarks");
    expect(out).toEqual([
      { platform: "twitter", name: "Cooking ideas", memberIds: ["a", "b"] },
      { platform: "tiktok", name: "Recipes", memberIds: ["c"] },
    ]);
  });
});
