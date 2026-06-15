import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { frontmatterToSearchableText } from "./chunker";

describe("frontmatterToSearchableText", () => {
  it("extracts subtitle (the TikTok transcript carrier)", () => {
    expect(frontmatterToSearchableText({ subtitle: "Hello there, friend." }))
      .toBe("Hello there, friend.");
  });

  it("joins multiple known fields with newlines", () => {
    const out = frontmatterToSearchableText({
      subtitle: "transcript here",
      url: "https://example.com/post/123",
      platform: "tiktok",
    });
    expect(out).toContain("transcript here");
    expect(out).toContain("https://example.com/post/123");
    expect(out).toContain("tiktok");
  });

  it("strips wikilink brackets so 'author: [[People/@foo]]' becomes 'People/@foo'", () => {
    expect(frontmatterToSearchableText({ author: "[[People/@foo]]" }))
      .toBe("People/@foo");
  });

  it("ignores fields not in the searchable list", () => {
    const out = frontmatterToSearchableText({
      title: "Should NOT appear",   // already in context prefix
      tags: ["should-not-appear"],  // already in context prefix
      roost_id: "tiktok:1234",      // metadata, not semantic
      stats_plays: 100,             // numeric metadata
    });
    expect(out).toBe("");
  });

  it("ignores non-string values (numbers, objects, arrays)", () => {
    const out = frontmatterToSearchableText({
      subtitle: 42 as unknown as string,
      url: { not: "a string" } as unknown as string,
    });
    expect(out).toBe("");
  });

  it("trims and skips empty strings", () => {
    expect(frontmatterToSearchableText({ subtitle: "   ", description: "real" }))
      .toBe("real");
  });
});

describe("chunkFile — bookmark-style frontmatter is searchable", () => {
  let tmpVault: string;
  const originalVaultPath = process.env.VAULT_PATH;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-chunker-"));
    process.env.VAULT_PATH = tmpVault;
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
    if (originalVaultPath === undefined) delete process.env.VAULT_PATH;
    else process.env.VAULT_PATH = originalVaultPath;
  });

  it("TikTok-style file: subtitle text appears in the chunk content", async () => {
    fs.writeFileSync(path.join(tmpVault, "tiktok-1.md"), `---
title: "Wholesome moment"
platform: tiktok
url: https://example.com/post/1
subtitle: "Hey man. Look at that rock. Millions of years to take shape."
tags:
  - tiktok
  - wholesome
---

#wholesome
`);
    vi.resetModules();
    const { chunkFile } = await import("./chunker");
    const result = chunkFile("tiktok-1.md");
    expect(result.chunks).toHaveLength(1);
    const joined = result.chunks.map((c) => c.content).join("\n");
    // Subtitle words should now be searchable
    expect(joined).toContain("Millions");
    expect(joined).toContain("rock");
    // URL should be searchable
    expect(joined).toContain("https://example.com/post/1");
  });

  it("note-style file (no special frontmatter): chunk content unchanged", async () => {
    fs.writeFileSync(path.join(tmpVault, "note.md"), `---
title: "Some Note"
tags:
  - dashboard
---

# Heading

This is the body content.
`);
    vi.resetModules();
    const { chunkFile } = await import("./chunker");
    const result = chunkFile("note.md");
    const joined = result.chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("This is the body content");
    // No spurious frontmatter fields injected (lowercase 'subtitle:' / 'description:' shouldn't appear)
    expect(joined).not.toMatch(/^subtitle:/m);
    expect(joined).not.toMatch(/^description:/m);
  });
});

describe("EXCLUDE_DIRS additions for ObsidianBookmarks", () => {
  it("excludes People, Pipelines, _embed-job, .SynologyWorkingDirectory at any depth", async () => {
    const { isExcluded } = await import("./scanner");
    expect(isExcluded(path.join("People", "@foo.md"))).toBe(true);
    expect(isExcluded(path.join("Pipelines", "x.md"))).toBe(true);
    expect(isExcluded(path.join("_embed-job", "log.md"))).toBe(true);
    expect(isExcluded(path.join(".SynologyWorkingDirectory", "x.md"))).toBe(true);

    // Nested still excluded
    expect(isExcluded(path.join("ObsidianBookmarks", "People", "@foo.md"))).toBe(true);
    expect(isExcluded(path.join("ObsidianBookmarks", "_embed-job", "log.md"))).toBe(true);

    // Bookmarks subdir still included
    expect(isExcluded(path.join("ObsidianBookmarks", "Bookmarks", "TikTok", "x.md"))).toBe(false);
  });
});
