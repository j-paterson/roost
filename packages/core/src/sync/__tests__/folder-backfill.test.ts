import { describe, it, expect } from "vitest";
import { folderFrontmatterPatch, parseFolderTweetMap } from "../folder-backfill";

describe("folderFrontmatterPatch", () => {
  it("in a folder: sets collection + human provenance, no stamp", () => {
    expect(folderFrontmatterPatch(true, "Cooking", {})).toEqual({
      collection: "Cooking",
      roost_assigned_by: "human",
    });
  });

  it("in a folder, prior AUTO category: clears roost_category", () => {
    expect(folderFrontmatterPatch(true, "Cooking", { roost_category: "Food", roost_assigned_by: "auto" })).toEqual({
      collection: "Cooking",
      roost_assigned_by: "human",
      roost_category: null,
    });
  });

  it("in a folder, prior HUMAN category: leaves roost_category untouched", () => {
    const patch = folderFrontmatterPatch(true, "Cooking", { roost_category: "Food", roost_assigned_by: "human" });
    expect(patch).toEqual({ collection: "Cooking", roost_assigned_by: "human" });
    expect("roost_category" in patch).toBe(false);
  });

  it("not in a folder: empty patch (nothing to write)", () => {
    expect(folderFrontmatterPatch(false, null, { roost_category: "Food", roost_assigned_by: "auto" })).toEqual({});
  });
});

describe("parseFolderTweetMap", () => {
  it("maps tweetId -> folder for entries with _bookmark_folder, ignoring the rest", () => {
    const json = JSON.stringify({
      "1": { _bookmark_folder: "Cooking" },
      "2": { _bookmark_folder: "Travel" },
      "3": { someOtherField: true },
      "4": { _bookmark_folder: "" },
    });
    const map = parseFolderTweetMap(json);
    expect(map.get("1")).toBe("Cooking");
    expect(map.get("2")).toBe("Travel");
    expect(map.has("3")).toBe(false);
    expect(map.has("4")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("returns an empty map on malformed JSON", () => {
    expect(parseFolderTweetMap("not json").size).toBe(0);
    expect(parseFolderTweetMap("[]").size).toBe(0);
  });
});

import { applyFolderMapToNotes } from "../folder-backfill";
import type { App } from "obsidian";

/** fs-free App stub: processFrontMatter mutates the same fm object getFileCache returns,
 *  so we assert the post-run state directly on the `files` array. */
function stubApp(files: { path: string; fm: Record<string, unknown> }[]): App {
  const byPath = new Map(files.map((f) => [f.path, f.fm]));
  return {
    vault: { getMarkdownFiles: () => files.map((f) => ({ path: f.path })) },
    metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: byPath.get(file.path) }) },
    fileManager: {
      processFrontMatter: async (file: { path: string }, fn: (fm: Record<string, unknown>) => void) => { fn(byPath.get(file.path)!); },
    },
  } as unknown as App;
}

describe("applyFolderMapToNotes", () => {
  it("tags in-folder notes, skips already-correct + not-in-folder by data (stamp-independent)", async () => {
    const files = [
      { path: "Bookmarks/a.md", fm: { platform: "twitter", roost_id: "twitter:a" } },                               // in folder, untagged -> tag
      { path: "Bookmarks/b.md", fm: { platform: "twitter", roost_id: "twitter:b", collection: "Recipes", enrichment_v_folder: 1 } }, // already correct (orphan stamp ignored) -> skip
      { path: "Bookmarks/c.md", fm: { platform: "twitter", roost_id: "twitter:c" } },                               // not in folder -> skip (no write)
      { path: "Bookmarks/d.md", fm: { platform: "twitter", roost_id: "twitter:d", roost_category: "Old", roost_assigned_by: "auto" } }, // in folder, auto cat -> tag + clear
      { path: "Bookmarks/e.md", fm: { platform: "tiktok", roost_id: "tiktok:e" } },                                 // non-twitter -> skip
    ];
    const folderByTweet = new Map([["a", "Recipes"], ["b", "Recipes"], ["d", "AI"]]);
    const res = await applyFolderMapToNotes(stubApp(files), "Bookmarks", folderByTweet);

    expect(res).toEqual({ tagged: 2, clearedAuto: 1 });
    expect(files[0].fm).toEqual({ platform: "twitter", roost_id: "twitter:a", collection: "Recipes", roost_assigned_by: "human" });
    expect(files[1].fm).toEqual({ platform: "twitter", roost_id: "twitter:b", collection: "Recipes", enrichment_v_folder: 1 }); // untouched
    expect(files[2].fm).toEqual({ platform: "twitter", roost_id: "twitter:c" });                                    // untouched, no write
    expect(files[3].fm).toEqual({ platform: "twitter", roost_id: "twitter:d", roost_assigned_by: "human", collection: "AI" }); // cat cleared
    expect(files[4].fm).toEqual({ platform: "tiktok", roost_id: "tiktok:e" });                                      // skipped
  });
});
