import { describe, it, expect } from "vitest";
import type { App, TFile, BasesEntry } from "obsidian";
import { TFile as RealTFile } from "obsidian";
import { resolveImageUrl, resolveVideoUrl, getCoverFolder, isRasterizedTextCover } from "@/views/feed/card-helpers";

function makeApp(files: Record<string, "file" | null>): App {
  return {
    vault: {
      getAbstractFileByPath: (p: string) => {
        const kind = files[p];
        if (kind === "file") {
          const f = Object.create(RealTFile.prototype) as TFile;
          (f as unknown as { path: string }).path = p;
          return f;
        }
        return null;
      },
      getResourcePath: (f: TFile) => `app://local/${(f as unknown as { path: string }).path}`,
    },
  } as unknown as App;
}

function makeEntry(values: Record<string, unknown>): BasesEntry {
  return { getValue: (k: string) => values[k] ?? null, file: { basename: "x" } } as unknown as BasesEntry;
}

describe("getCoverFolder", () => {
  it("strips the filename and any wikilink wrapping", () => {
    const entry = makeEntry({ "note.cover": "[[Bookmarks/TikTok/tiktok-ABC/1.jpg]]" });
    expect(getCoverFolder(entry)).toBe("Bookmarks/TikTok/tiktok-ABC");
  });

  it("returns null when there is no cover", () => {
    expect(getCoverFolder(makeEntry({}))).toBeNull();
  });
});

describe("resolveVideoUrl", () => {
  it("returns a resource path when media.mp4 exists", () => {
    const app = makeApp({ "Bookmarks/TikTok/tiktok-ABC/media.mp4": "file" });
    const entry = makeEntry({ "note.cover": "Bookmarks/TikTok/tiktok-ABC/1.jpg" });
    expect(resolveVideoUrl(app, entry)).toBe("app://local/Bookmarks/TikTok/tiktok-ABC/media.mp4");
  });

  it("returns null when no video file is present", () => {
    const app = makeApp({});
    const entry = makeEntry({ "note.cover": "Bookmarks/TikTok/tiktok-ABC/1.jpg" });
    expect(resolveVideoUrl(app, entry)).toBeNull();
  });
});

describe("isRasterizedTextCover", () => {
  it("treats a card.png cover as a generated text card", () => {
    const app = makeApp({});
    const entry = makeEntry({ "note.cover": "[[Bookmarks/X/x-ABC/card.png]]" });
    expect(isRasterizedTextCover(app, entry)).toBe(true);
  });

  it("treats real downloaded media (jpg) as NOT a text card", () => {
    const app = makeApp({});
    const entry = makeEntry({ "note.cover": "Bookmarks/X/x-ABC/1.jpg" });
    expect(isRasterizedTextCover(app, entry)).toBe(false);
  });

  it("treats a threaded numbered .png cover as a text card when thread.json exists", () => {
    const app = makeApp({ "Bookmarks/X/x-ABC/thread.json": "file" });
    const entry = makeEntry({ "note.cover": "Bookmarks/X/x-ABC/1.png" });
    expect(isRasterizedTextCover(app, entry)).toBe(true);
  });

  it("does NOT treat a numbered .png cover as a text card without thread.json", () => {
    const app = makeApp({});
    const entry = makeEntry({ "note.cover": "Bookmarks/X/x-ABC/1.png" });
    expect(isRasterizedTextCover(app, entry)).toBe(false);
  });

  it("returns false when there is no cover", () => {
    expect(isRasterizedTextCover(makeApp({}), makeEntry({}))).toBe(false);
  });
});

describe("resolveImageUrl", () => {
  it("returns a vault resource path when the cover is a vault file", () => {
    const app = makeApp({ "Bookmarks/X/x-ABC/1.jpg": "file" });
    const entry = makeEntry({ "note.cover": "[[Bookmarks/X/x-ABC/1.jpg]]" });
    expect(resolveImageUrl(app, entry, "note.cover")).toBe("app://local/Bookmarks/X/x-ABC/1.jpg");
  });

  it("returns the URL as-is for http covers", () => {
    const app = makeApp({});
    const entry = makeEntry({ "note.cover": "https://example.com/img.jpg" });
    expect(resolveImageUrl(app, entry, "note.cover")).toBe("https://example.com/img.jpg");
  });

  it("returns null for missing or empty covers", () => {
    const app = makeApp({});
    expect(resolveImageUrl(app, makeEntry({}), "note.cover")).toBeNull();
    expect(resolveImageUrl(app, makeEntry({ "note.cover": "" }), "note.cover")).toBeNull();
  });
});
