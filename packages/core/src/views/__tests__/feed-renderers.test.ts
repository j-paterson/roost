import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { inferFeedPlatform } from "@/views/feed/feed-renderers";

function makeEntry(values: Record<string, unknown>): BasesEntry {
  return { getValue: (k: string) => values[k] ?? null, file: { basename: "x" } } as unknown as BasesEntry;
}

describe("inferFeedPlatform", () => {
  it("returns tiktok for note.platform === 'tiktok'", () => {
    expect(inferFeedPlatform(makeEntry({ "note.platform": "tiktok" }))).toBe("tiktok");
  });

  it("returns x for note.platform === 'twitter'", () => {
    expect(inferFeedPlatform(makeEntry({ "note.platform": "twitter" }))).toBe("x");
  });

  it("returns default for other or missing platforms", () => {
    expect(inferFeedPlatform(makeEntry({ "note.platform": "youtube" }))).toBe("default");
    expect(inferFeedPlatform(makeEntry({}))).toBe("default");
  });
});
