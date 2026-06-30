import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import {
  safeGetValue,
  safeGetString,
  getRoostId,
  stripAuthorWiki,
  parseEntryTags,
  entryStatsFromBases,
} from "../bases-entry";

function mkEntry(values: Record<string, unknown>, basename = "note.md"): BasesEntry {
  return {
    file: { basename, path: `Bookmarks/X/${basename}` },
    getValue: (key: string) => {
      const v = values[key];
      if (v === "__throw__") throw new Error("null frontmatter");
      return v;
    },
  } as unknown as BasesEntry;
}

describe("safeGetValue", () => {
  it("returns value when present", () => {
    const e = mkEntry({ "note.title": "Hello" });
    expect(safeGetValue(e, "note.title")).toBe("Hello");
  });

  it("returns null when getValue throws", () => {
    const e = mkEntry({ "note.title": "__throw__" });
    expect(safeGetValue(e, "note.title")).toBeNull();
  });
});

describe("safeGetString", () => {
  it("returns the string when present", () => {
    expect(safeGetString(mkEntry({ "note.link_url": "https://x.com/a" }), "note.link_url")).toBe("https://x.com/a");
  });

  it("collapses the Base null-wrapper sentinel \"null\" to null (absent column on a note)", () => {
    // A Bases column the note lacks hands back a wrapper whose toString() is "null".
    const wrapper = { toString: () => "null" };
    expect(safeGetString(mkEntry({ "note.link_url": wrapper }), "note.link_url")).toBeNull();
  });

  it("collapses \"undefined\" and empty string to null", () => {
    expect(safeGetString(mkEntry({ "note.link_site": "undefined" }), "note.link_site")).toBeNull();
    expect(safeGetString(mkEntry({ "note.link_site": "" }), "note.link_site")).toBeNull();
  });

  it("returns null for real null/undefined and on throw", () => {
    expect(safeGetString(mkEntry({ "note.link_url": null }), "note.link_url")).toBeNull();
    expect(safeGetString(mkEntry({}), "note.link_url")).toBeNull();
    expect(safeGetString(mkEntry({ "note.link_url": "__throw__" }), "note.link_url")).toBeNull();
  });
});

describe("getRoostId", () => {
  it("reads note.roost_id", () => {
    const e = mkEntry({ "note.roost_id": "twitter:123" });
    expect(getRoostId(e)).toBe("twitter:123");
  });

  it("falls back to basename", () => {
    const e = mkEntry({}, "fallback.md");
    expect(getRoostId(e)).toBe("fallback.md");
  });
});

describe("stripAuthorWiki", () => {
  it("strips People wikilink brackets", () => {
    expect(stripAuthorWiki("[[People/@user]]")).toBe("@user");
  });

  it("returns null for nullish", () => {
    expect(stripAuthorWiki(null)).toBeNull();
  });
});

describe("parseEntryTags", () => {
  it("splits comma-separated tags", () => {
    const e = mkEntry({ "note.tags": "a, b , c" });
    expect(parseEntryTags(e)).toEqual(["a", "b", "c"]);
  });

  it("returns undefined when empty", () => {
    const e = mkEntry({});
    expect(parseEntryTags(e)).toBeUndefined();
  });
});

describe("entryStatsFromBases", () => {
  it("coerces numeric stats", () => {
    const e = mkEntry({
      "note.stats_plays": "1000",
      "note.stats_likes": 5,
    });
    expect(entryStatsFromBases(e)).toEqual({ plays: 1000, likes: 5 });
  });
});
