/**
 * Characterization tests for TwitterRecordWriter folder support.
 * Pins that a Twitter record with _bookmark_folder produces:
 *   - collection: <name> frontmatter field
 *   - collection/<sanitized-name> tag
 * And that a record without a folder omits both.
 *
 * Pattern mirrors write-paths-characterization.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../media-downloader", () => {
  const tinyBuf = () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
  return {
    downloadTwitterImage: vi.fn(async (_url: string) => tinyBuf()),
    downloadTwitterVideo: vi.fn(async (_url: string) => tinyBuf()),
    downloadTikTokImage: vi.fn(async (_url: string) => tinyBuf()),
    downloadTikTokVideo: vi.fn(async (_wc: unknown, _url: string) => tinyBuf()),
    downloadTikTokSubtitle: vi.fn(async (_url: string) => "WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n"),
  };
});

vi.mock("../card-renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../card-renderer")>();
  return {
    ...actual,
    renderCardAsync: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer),
  };
});

import { VaultWriter } from "../vault-writer";
import { makeFakeVault } from "./fake-vault";
import type { NormalizedRecord } from "@/lib/normalize";

function makeBinaryVault() {
  const base = makeFakeVault();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const vault = Object.assign(base.vault, {
    createBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      binaryFiles.set(path, data);
      base.files.set(path, `[binary:${path}]`);
    },
    delete: async (_file: unknown): Promise<void> => {},
  });
  return { ...base, vault, binaryFiles };
}

/** Twitter text record WITH a bookmark folder */
function makeTwitterFolderRecord(): NormalizedRecord {
  return {
    id: "twitter:555",
    platform: "twitter",
    itemId: "555",
    rawData: {
      rest_id: "555",
      core: {
        user_results: {
          result: { core: { name: "Alice", screen_name: "alice" } },
        },
      },
      legacy: { full_text: "a tweet in a folder" },
      _bookmark_folder: "My Reads",
    },
    saved_at: "2026-06-01T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

/** Twitter text record WITHOUT a bookmark folder */
function makeTwitterNoFolderRecord(): NormalizedRecord {
  return {
    id: "twitter:666",
    platform: "twitter",
    itemId: "666",
    rawData: {
      rest_id: "666",
      core: {
        user_results: {
          result: { core: { name: "Bob", screen_name: "bob" } },
        },
      },
      legacy: { full_text: "a tweet with no folder" },
    },
    saved_at: "2026-06-02T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

/** Twitter text record with a folder name that requires sanitization */
function makeTwitterFolderSpecialCharsRecord(): NormalizedRecord {
  return {
    id: "twitter:777",
    platform: "twitter",
    itemId: "777",
    rawData: {
      rest_id: "777",
      core: {
        user_results: {
          result: { core: { name: "Charlie", screen_name: "charlie" } },
        },
      },
      legacy: { full_text: "a tweet in a special folder" },
      _bookmark_folder: "Tech/AI: 2026",
    },
    saved_at: "2026-06-03T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

describe("TwitterRecordWriter — bookmark folder stamping", () => {
  it("record with _bookmark_folder: collection field present in frontmatter", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    await writer.writeBatch([makeTwitterFolderRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    expect(note).toContain("collection: My Reads");
  });

  it("record with _bookmark_folder: collection/<name> tag present in tags array", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    await writer.writeBatch([makeTwitterFolderRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    const note = files.get(notePath!)!;
    expect(note).toContain("collection/My Reads");
  });

  it("record without _bookmark_folder: no collection field in frontmatter", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    await writer.writeBatch([makeTwitterNoFolderRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;
    expect(note).not.toContain("collection:");
  });

  it("record without _bookmark_folder: no collection/ tag", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    await writer.writeBatch([makeTwitterNoFolderRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    const note = files.get(notePath!)!;
    expect(note).not.toContain("collection/");
  });

  it("record with special chars in folder name: sanitizeFilename applied to tag", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    await writer.writeBatch([makeTwitterFolderSpecialCharsRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    const note = files.get(notePath!)!;
    // collection field: raw name preserved (buildFrontmatter quotes strings with special chars)
    expect(note).toContain('collection: "Tech/AI: 2026"');
    // tag: sanitizeFilename replaces / and : with _, so "Tech/AI: 2026" → "Tech_AI_ 2026"
    // The tag should NOT contain the raw "/" from "Tech/AI" which would create nested Obsidian tags
    expect(note).not.toMatch(/collection\/Tech\/AI/);
    // The sanitized tag should be present
    expect(note).toContain("collection/Tech_AI_ 2026");
  });
});
