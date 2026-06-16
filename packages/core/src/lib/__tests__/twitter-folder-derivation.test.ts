/**
 * Derivation proof: Twitter notes with platform:"twitter" + collection:"<folder>"
 * participate in gatherVaultCollections + alias resolution with no downstream changes.
 *
 * This test mirrors collection-aliases-integration.test.ts but for Twitter.
 * It proves the alias key "twitter:My Reads" is built from fm.platform (not hardcoded "tiktok").
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

describe("Twitter bookmark folder → category derivation via alias map", () => {
  it("Twitter note with collection resolves via alias when platform is 'twitter'", () => {
    const app = mkApp([
      {
        path: "Bookmarks/X/a.md",
        fm: {
          roost_id: "twitter:1",
          platform: "twitter",
          collection: "My Reads",
        },
      },
    ]);
    const aliases: CollectionAliasMap = { "twitter:My Reads": "Reading List" };
    const result = gatherVaultCollections(app, "Bookmarks", undefined, aliases);
    expect(result.itemCollections.get("twitter:1")).toBe("Reading List");
    expect(Object.keys(result.collections)).toEqual(["Reading List"]);
  });

  it("Twitter note with roost_category overrides collection (same precedence as TikTok)", () => {
    const app = mkApp([
      {
        path: "Bookmarks/X/b.md",
        fm: {
          roost_id: "twitter:2",
          platform: "twitter",
          roost_category: "Curated Reads",
          collection: "My Reads",
        },
      },
    ]);
    const aliases: CollectionAliasMap = { "twitter:My Reads": "Reading List" };
    const result = gatherVaultCollections(app, "Bookmarks", undefined, aliases);
    // roost_category wins over alias
    expect(result.itemCollections.get("twitter:2")).toBe("Curated Reads");
  });

  it("Twitter note without alias falls back to raw collection name", () => {
    const app = mkApp([
      {
        path: "Bookmarks/X/c.md",
        fm: {
          roost_id: "twitter:3",
          platform: "twitter",
          collection: "Tech Stuff",
        },
      },
    ]);
    const result = gatherVaultCollections(app, "Bookmarks");
    expect(result.itemCollections.get("twitter:3")).toBe("Tech Stuff");
    expect(result.collections["Tech Stuff"]).toContain("twitter:3");
  });

  it("mixed vault: TikTok and Twitter notes each resolve via their own platform namespace", () => {
    const app = mkApp([
      {
        path: "Bookmarks/TikTok/a.md",
        fm: {
          roost_id: "tiktok:1",
          platform: "tiktok",
          collection: "Finance Tips",
        },
      },
      {
        path: "Bookmarks/X/b.md",
        fm: {
          roost_id: "twitter:2",
          platform: "twitter",
          collection: "Finance Tips",
        },
      },
    ]);
    // Each platform has its OWN alias for the same collection name
    const aliases: CollectionAliasMap = {
      "tiktok:Finance Tips": "Finances TT",
      "twitter:Finance Tips": "Finances TW",
    };
    const result = gatherVaultCollections(app, "Bookmarks", undefined, aliases);
    expect(result.itemCollections.get("tiktok:1")).toBe("Finances TT");
    expect(result.itemCollections.get("twitter:2")).toBe("Finances TW");
  });
});
