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
