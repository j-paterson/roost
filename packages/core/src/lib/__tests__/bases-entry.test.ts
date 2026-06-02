import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import {
  safeGetValue,
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
