/**
 * Characterization tests for VaultWriter's threaded-tweet write path.
 *
 * Pins the observable output of `writeBatch` for a record whose rawData
 * carries `_thread: ThreadSegment[]`. This is the safety net for Phase 4
 * of the VaultWriter decomposition (plan 021), which moves `renderThreadPages`
 * into `TwitterRecordWriter`.
 *
 * See plans/022-thread-path-characterization.md for the full plan.
 */
import { describe, it, expect, vi } from "vitest";

// ── Stub the low-level download module (the single network seam) ──────────────
// Must appear before any non-mock import that pulls the real modules.
// vi.mock is hoisted to the top of the file by Vitest.
vi.mock("../media-downloader", () => {
  const tinyBuf = () => new Uint8Array([0xff, 0xd8, 0xff]).buffer; // 3-byte fake JPEG
  return {
    downloadTwitterImage: vi.fn(async (_url: string) => tinyBuf()),
    downloadTwitterVideo: vi.fn(async (_url: string) => tinyBuf()),
    downloadTikTokImage:  vi.fn(async (_url: string) => tinyBuf()),
    downloadTikTokVideo:  vi.fn(async (_wc: unknown, _url: string) => tinyBuf()),
    downloadTikTokSubtitle: vi.fn(async (_url: string) =>
      "WEBVTT\n\n00:00.000 --> 00:02.000\nhello world\n"),
  };
});

// ── Stub card rendering ───────────────────────────────────────────────────────
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
import type { ThreadSegment } from "../thread-fetcher";

// ── Local binary-capable vault wrapper ────────────────────────────────────────
function makeBinaryVault() {
  const base = makeFakeVault();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const vault = Object.assign(base.vault, {
    createBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      binaryFiles.set(path, data);
      base.files.set(path, `[binary:${path}]`);
    },
    delete: async (_file: unknown): Promise<void> => { /* no-op */ },
  });
  return { ...base, vault, binaryFiles };
}

// ── Synthetic record factory ───────────────────────────────────────────────────

/**
 * Threaded Twitter record.
 *
 * Two main-thread segments:
 *   seg0 (rest_id "1001", focal): 1 photo → page 1
 *   seg1 (rest_id "1002"):        2 photos → pages 2 and 3
 *
 * record.rawData.rest_id = "1001" so renderThreadPages derives focalId = "1001"
 * which matches seg0.rest_id — making seg0 the focal segment.
 *
 * Expected: 3 page images, focalIndex = 1, pageCount = 3, cover = 1.jpg
 */
function makeThreadedTwitterRecord(): NormalizedRecord {
  const seg0: ThreadSegment = {
    rest_id: "1001",
    raw: {
      rest_id: "1001",
      legacy: {
        full_text: "first tweet in thread",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/seg1p1" },
          ],
        },
      },
      core: {
        user_results: {
          result: { core: { name: "Alice", screen_name: "alice" } },
        },
      },
    },
  };

  const seg1: ThreadSegment = {
    rest_id: "1002",
    raw: {
      rest_id: "1002",
      legacy: {
        full_text: "second tweet in thread",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/seg2p1" },
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/seg2p2" },
          ],
        },
      },
      core: {
        user_results: {
          result: { core: { name: "Alice", screen_name: "alice" } },
        },
      },
    },
  };

  return {
    id: "twitter:1001",
    platform: "twitter",
    itemId: "1001",
    rawData: {
      rest_id: "1001",          // focalId derived from here — must match seg0.rest_id
      core: {
        user_results: {
          result: {
            core: { name: "Alice", screen_name: "alice" },
          },
        },
      },
      legacy: {
        full_text: "first tweet in thread #threadtest",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/seg1p1" },
          ],
        },
      },
      _thread: [seg0, seg1],    // drives isThreaded = true
    },
    saved_at: "2026-06-01T00:00:00.000Z",
    published_at: "2026-05-30T10:00:00.000Z",
    captured_via: "test",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VaultWriter.writeBatch — threaded Twitter record (photo segments)", () => {
  it("writes 3 numbered page images (1.jpg, 2.jpg, 3.jpg) for a 2-segment thread", async () => {
    const { vault, files, binaryFiles } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await writer.writeBatch([makeThreadedTwitterRecord()]);

    // CHARACTERIZATION: page numbering is global across segments; each
    // downloadAndSave call receives the next pageCounter as the filename,
    // regardless of which segment the photo belongs to.
    expect(files.has("Bookmarks/X/twitter-1001/1.jpg")).toBe(true);  // seg0's 1 photo
    expect(files.has("Bookmarks/X/twitter-1001/2.jpg")).toBe(true);  // seg1's 1st photo
    expect(files.has("Bookmarks/X/twitter-1001/3.jpg")).toBe(true);  // seg1's 2nd photo
    // binaryFiles also has them (same underlying data)
    expect(binaryFiles.has("Bookmarks/X/twitter-1001/1.jpg")).toBe(true);
    expect(binaryFiles.has("Bookmarks/X/twitter-1001/2.jpg")).toBe(true);
    expect(binaryFiles.has("Bookmarks/X/twitter-1001/3.jpg")).toBe(true);
  });

  it("writes thread.json sidecar with correct shape", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await writer.writeBatch([makeThreadedTwitterRecord()]);

    const raw = files.get("Bookmarks/X/twitter-1001/thread.json");
    expect(raw).toBeDefined();
    const meta = JSON.parse(raw!);

    expect(meta.success).toBe(true);
    expect(meta.pageCount).toBe(3);
    expect(meta.focalIndex).toBe(1);
    expect(meta.segments).toHaveLength(2);

    const s0 = meta.segments[0];
    expect(s0.rest_id).toBe("1001");
    expect(s0.isFocal).toBe(true);
    expect(s0.isQuoted).toBe(false);
    expect(s0.pages).toEqual([1]);

    const s1 = meta.segments[1];
    expect(s1.rest_id).toBe("1002");
    expect(s1.isFocal).toBe(false);
    expect(s1.isQuoted).toBe(false);
    expect(s1.pages).toEqual([2, 3]);
  });

  it("note frontmatter has thread_length, focal_index, and cover pointing at the focal page", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await writer.writeBatch([makeThreadedTwitterRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    expect(note).toContain("thread_length: 3");
    expect(note).toContain("focal_index: 1");
    // CHARACTERIZATION: cover wikilink starts with "[" which triggers needsQuoting
    // in buildFrontmatter, so it is YAML-double-quoted.
    // cover points at the first page of the focal segment (focalSeg.pages[0] = 1 → 1.jpg).
    expect(note).toContain('cover: "[[Bookmarks/X/twitter-1001/1.jpg]]"');
  });

  it("writeBatch counter: pushed=1, skipped=0, resynced=0", async () => {
    const { vault } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const result = await writer.writeBatch([makeThreadedTwitterRecord()]);
    expect(result).toEqual({ pushed: 1, skipped: 0, resynced: 0 });
  });

  it("writes raw.json sidecar and author note", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await writer.writeBatch([makeThreadedTwitterRecord()]);

    expect(files.has("Bookmarks/X/twitter-1001/raw.json")).toBe(true);
    expect(files.has("People/@alice.md")).toBe(true);
  });
});
