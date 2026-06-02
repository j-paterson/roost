import { describe, it, expect } from "vitest";
import type { App, TFile, BasesEntry } from "obsidian";
import { TFile as RealTFile } from "obsidian";
import {
  sourceUrlFromFrontmatter,
  digestMediaResolvers,
  digestCardContext,
  entryToExpandedCardData,
  frontmatterBasesEntry,
} from "@/views/entry-to-expanded-card";

describe("sourceUrlFromFrontmatter", () => {
  it("prefers explicit url", () => {
    expect(
      sourceUrlFromFrontmatter(
        { url: "https://example.com/p", roost_id: "twitter:1" },
        "@user",
      ),
    ).toBe("https://example.com/p");
  });

  it("builds twitter status URL from roost_id", () => {
    expect(sourceUrlFromFrontmatter({ roost_id: "twitter:99" }, null)).toBe(
      "https://x.com/i/status/99",
    );
  });

  it("builds tiktok URL when author handle is present", () => {
    expect(
      sourceUrlFromFrontmatter({ roost_id: "tiktok:abc" }, "@chef"),
    ).toBe("https://www.tiktok.com/@chef/video/abc");
  });
});

function makeApp(files: Record<string, "file" | null>): App {
  return {
    vault: {
      getAbstractFileByPath: (p: string) => {
        if (files[p] === "file") {
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

function makeFile(basename = "note"): TFile {
  return { basename, path: `Bookmarks/X/${basename}.md` } as TFile;
}

describe("digest media + frontmatter entry", () => {
  it("skips numbered PNGs in carousel when thread.json exists", () => {
    const app = makeApp({
      "Bookmarks/X/x-ABC/thread.json": "file",
      "Bookmarks/X/x-ABC/1.jpg": "file",
      "Bookmarks/X/x-ABC/2.png": "file",
    });
    const fm = { cover: "Bookmarks/X/x-ABC/1.jpg" };
    const entry = frontmatterBasesEntry(makeFile(), fm);
    const resolvers = digestMediaResolvers(app);
    expect(resolvers.resolveAllImages(entry)).toEqual([
      "app://local/Bookmarks/X/x-ABC/1.jpg",
    ]);
  });

  it("marks hideMediaPanel when only rasterized cover and no video", () => {
    const app = makeApp({
      "Bookmarks/X/x-ABC/card.png": "file",
    });
    const fm = { cover: "Bookmarks/X/x-ABC/card.png" };
    const entry = frontmatterBasesEntry(makeFile(), fm);
    const resolvers = digestMediaResolvers(app);
    const ctx = digestCardContext(app, entry, resolvers);
    expect(ctx.hasTextBody).toBe(true);
    expect(ctx.hideMediaPanel).toBe(true);
    expect(resolvers.resolveImageUrl(entry, "note.cover")).toBeNull();
  });

  it("entryToExpandedCardData uses digest resolvers and frontmatter scalars", () => {
    const app = makeApp({ "Bookmarks/X/x-ABC/1.jpg": "file" });
    const fm = {
      title: "Hello",
      platform: "twitter",
      author: "[[People/@op]]",
      tags: ["a", "b"],
      cover: "Bookmarks/X/x-ABC/1.jpg",
      roost_id: "twitter:42",
    };
    const entry = frontmatterBasesEntry(makeFile("x-ABC"), fm);
    const data = entryToExpandedCardData(entry, digestMediaResolvers(app));
    expect(data.title).toBe("Hello");
    expect(data.author).toBe("@op");
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.url).toBe("https://x.com/i/status/42");
    expect(data.coverUrl).toBe("app://local/Bookmarks/X/x-ABC/1.jpg");
  });
});
