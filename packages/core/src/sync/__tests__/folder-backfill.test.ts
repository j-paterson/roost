import { describe, it, expect } from "vitest";
import { folderFrontmatterPatch, parseFolderTweetMap } from "../folder-backfill";

const V = 1;
const stamp = "enrichment_v_folder";

describe("folderFrontmatterPatch", () => {
  it("in a folder: sets collection + human provenance + stamp", () => {
    const patch = folderFrontmatterPatch(true, "Cooking", {}, V);
    expect(patch).toEqual({ collection: "Cooking", roost_assigned_by: "human", [stamp]: V });
  });

  it("in a folder, prior AUTO category: clears roost_category", () => {
    const patch = folderFrontmatterPatch(true, "Cooking", { roost_category: "Food", roost_assigned_by: "auto" }, V);
    expect(patch).toEqual({ collection: "Cooking", roost_assigned_by: "human", roost_category: null, [stamp]: V });
  });

  it("in a folder, prior HUMAN category: leaves roost_category untouched", () => {
    const patch = folderFrontmatterPatch(true, "Cooking", { roost_category: "Food", roost_assigned_by: "human" }, V);
    expect(patch).toEqual({ collection: "Cooking", roost_assigned_by: "human", [stamp]: V });
    expect("roost_category" in patch).toBe(false);
  });

  it("not in a folder: stamps only", () => {
    const patch = folderFrontmatterPatch(false, null, { roost_category: "Food", roost_assigned_by: "auto" }, V);
    expect(patch).toEqual({ [stamp]: V });
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
  it("recovers dirty state, preserves correct/human notes, stamps the rest", async () => {
    // roost_id is platform-prefixed in the vault ("twitter:<rest_id>"); folderByTweet
    // keys are the BARE rest_id — the lookup must strip the prefix (this is the bug
    // that produced applied:0 live, missed because the empty fixture vault has no notes).
    const files = [
      { path: "Bookmarks/a.md", fm: { platform: "twitter", roost_id: "twitter:a", enrichment_v_folder: 1 } },               // stamped by a prior run but never tagged + in folder
      { path: "Bookmarks/b.md", fm: { platform: "twitter", roost_id: "twitter:b", collection: "Recipes", enrichment_v_folder: 1 } }, // already correct
      { path: "Bookmarks/c.md", fm: { platform: "twitter", roost_id: "twitter:c" } },                                       // not in folder, unstamped
      { path: "Bookmarks/d.md", fm: { platform: "twitter", roost_id: "twitter:d", roost_category: "Old", roost_assigned_by: "auto", enrichment_v_folder: 1 } }, // in folder, auto cat
      { path: "Bookmarks/e.md", fm: { platform: "tiktok", roost_id: "tiktok:e" } },                                         // non-twitter
    ];
    const folderByTweet = new Map([["a", "Recipes"], ["b", "Recipes"], ["d", "AI"]]);
    const res = await applyFolderMapToNotes(stubApp(files), "Bookmarks", folderByTweet);

    expect(res).toEqual({ tagged: 2, clearedAuto: 1, stampedOnly: 1 });
    expect(files[0].fm).toEqual({ platform: "twitter", roost_id: "twitter:a", collection: "Recipes", roost_assigned_by: "human", enrichment_v_folder: 1 });
    expect(files[1].fm).toEqual({ platform: "twitter", roost_id: "twitter:b", collection: "Recipes", enrichment_v_folder: 1 }); // untouched
    expect(files[2].fm).toEqual({ platform: "twitter", roost_id: "twitter:c", enrichment_v_folder: 1 });                       // stamp only
    expect(files[3].fm).toEqual({ platform: "twitter", roost_id: "twitter:d", roost_assigned_by: "human", collection: "AI", enrichment_v_folder: 1 }); // auto cat cleared
    expect(files[4].fm).toEqual({ platform: "tiktok", roost_id: "tiktok:e" });                                               // skipped
  });
});
