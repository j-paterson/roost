/**
 * Characterization tests for VaultWriter.resyncRecord — the re-sync path
 * reached when writeBatch encounters a record whose id is already in existingIds.
 *
 * These tests pin the observable output of the resync branch so that Phase 5
 * (plan 026, extracting resyncRecord into ResyncRunner) produces a red test
 * rather than silent vault corruption if behaviour drifts.
 *
 * DECOMPOSITION SURVIVAL CONTRACT:
 *   All assertions are on writeBatch output — the files map (text content)
 *   and binaryFiles map (attachment paths). No assertion touches internal
 *   method names or call counts. The suite survives Phase 5 unchanged.
 *
 * Surprising behaviour is annotated with `// CHARACTERIZATION:` — do NOT
 * "fix" it here.
 *
 * See plans/025-resync-characterization.md for the full plan.
 */
import { describe, it, expect, vi } from "vitest";

// ── Stub the low-level download module (the single network seam) ──────────────
// Must appear before any non-mock import that pulls the real modules.
// vi.mock is hoisted to the top of the file by Vitest.
vi.mock("../media-downloader", () => {
  const tinyBuf = () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
  return {
    downloadTwitterImage:   vi.fn(async (_url: string) => tinyBuf()),
    downloadTwitterVideo:   vi.fn(async (_url: string) => tinyBuf()),
    downloadTikTokImage:    vi.fn(async (_url: string) => tinyBuf()),
    downloadTikTokVideo:    vi.fn(async (_wc: unknown, _url: string) => tinyBuf()),
    downloadTikTokSubtitle: vi.fn(async (_url: string) =>
      "WEBVTT\n\n00:00.000 --> 00:02.000\nhello world this is a transcript line\n"),
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
// Wraps makeFakeVault() locally so the shared fake-vault.ts is untouched and
// vault-writer.test.ts / note-file-writer.test.ts stay byte-unchanged.
// Adds createBinary (needed by downloadAndSave) and delete (needed by
// clearLegacyCarousel) — the only two methods the media write paths need
// beyond what makeFakeVault already provides.
function makeBinaryVault() {
  const base = makeFakeVault();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const vault = Object.assign(base.vault, {
    createBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      binaryFiles.set(path, data);
      // Also mark the path in the text files map so getAbstractFileByPath and
      // skip-if-exists checks in downloadAndSave can find the file.
      base.files.set(path, `[binary:${path}]`);
    },
    delete: async (_file: unknown): Promise<void> => { /* no-op in tests */ },
  });
  return { ...base, vault, binaryFiles };
}

// ── Record factories ───────────────────────────────────────────────────────────

/**
 * TikTok carousel record for resync testing.
 * desc → title update; imagePost.images → 1.jpg re-download;
 * stats → all five stats_* fields.
 * No video.subtitleInfos so subtitle path is skipped (keeps Suite A minimal).
 */
function makeTikTokResyncRecord(): NormalizedRecord {
  return {
    id: "tiktok:999",
    platform: "tiktok",
    itemId: "999",
    rawData: {
      id: "999",
      desc: "resync test post #newtag",
      author: { uniqueId: "resyncuser", nickname: "ResyncUser" },
      imagePost: {
        images: [
          { imageURL: "https://p.tiktok.com/resync1" },
        ],
      },
      stats: {
        playCount: 500,
        diggCount: 42,
        commentCount: 7,
        shareCount: 3,
        collectCount: 12,
      },
    },
    saved_at: "2026-06-01T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

/**
 * Twitter photo record (non-threaded) for resync testing.
 */
function makeTwitterResyncRecord(): NormalizedRecord {
  return {
    id: "twitter:777",
    platform: "twitter",
    itemId: "777",
    rawData: {
      rest_id: "777",
      core: {
        user_results: {
          result: { core: { name: "ResyncPerson", screen_name: "resyncer" } },
        },
      },
      legacy: {
        full_text: "updated tweet text",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/resync1" },
          ],
        },
      },
    },
    saved_at: "2026-06-02T00:00:00.000Z",
    published_at: "2026-06-01T10:00:00.000Z",
    captured_via: "test",
  };
}

/**
 * Threaded Twitter record for resync testing.
 * Two main-thread segments:
 *   seg0 (rest_id "8001", focal): 1 photo → page 1
 *   seg1 (rest_id "8002"):        1 photo → page 2
 * record.rawData.rest_id = "8001" (matches seg0.rest_id) so focalId = "8001" → focalIndex = 1.
 * record.id = "twitter:888" / itemId = "888" so the note path is twitter-888.
 * Expected: pageCount = 2, focalIndex = 1, cover = 1.jpg
 */
function makeThreadedTwitterResyncRecord(): NormalizedRecord {
  const seg0: ThreadSegment = {
    rest_id: "8001",
    raw: {
      rest_id: "8001",
      legacy: {
        full_text: "first resync thread tweet",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/rseg1p1" },
          ],
        },
      },
      core: {
        user_results: {
          result: { core: { name: "ThreadResync", screen_name: "threadresyncer" } },
        },
      },
    },
  };

  const seg1: ThreadSegment = {
    rest_id: "8002",
    raw: {
      rest_id: "8002",
      legacy: {
        full_text: "second resync thread tweet",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/rseg2p1" },
          ],
        },
      },
      core: {
        user_results: {
          result: { core: { name: "ThreadResync", screen_name: "threadresyncer" } },
        },
      },
    },
  };

  return {
    id: "twitter:888",
    platform: "twitter",
    itemId: "888",
    rawData: {
      // rest_id MUST match seg0.rest_id so renderThreadPages derives focalId = "8001"
      // and seg0 becomes the focal segment (isFocal = true → cover = page 1).
      rest_id: "8001",
      core: {
        user_results: {
          result: {
            core: { name: "ThreadResync", screen_name: "threadresyncer" },
          },
        },
      },
      legacy: {
        full_text: "first resync thread tweet",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/rseg1p1" },
          ],
        },
      },
      _thread: [seg0, seg1],
    },
    saved_at: "2026-06-03T00:00:00.000Z",
    published_at: "2026-06-02T10:00:00.000Z",
    captured_via: "test",
  };
}

// ── Suite A — TikTok resync ───────────────────────────────────────────────────

describe("VaultWriter.resyncRecord — TikTok carousel (via writeBatch two-call)", () => {
  it("STOP-CONDITION GUARD: writeBatch returns resynced:1 confirming resyncRecord ran", async () => {
    const { vault } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTikTokResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const result = await w2.writeBatch([makeTikTokResyncRecord()]);

    // If this fails (resynced stays 0), the seeding failed and ALL other resync
    // tests in this suite are invalid. Fix the seeding before proceeding.
    expect(result).toEqual({ pushed: 0, skipped: 1, resynced: 1 });
  });

  it("updates title, url, cover, and stats_* frontmatter fields", async () => {
    const { vault, files } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTikTokResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeTikTokResyncRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/TikTok/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    // CHARACTERIZATION: title contains "#" — updateNoteFrontmatter calls yamlStr
    // which double-quotes values containing "#". Pin the quoted form.
    expect(note).toContain('title: "resync test post #newtag"');
    expect(note).toContain('url: "https://www.tiktok.com/@resyncuser/video/999"');
    // CHARACTERIZATION: cover wikilink starts with "[" → double-quoted.
    expect(note).toContain('cover: "[[Bookmarks/TikTok/tiktok-999/1.jpg]]"');
    expect(note).toContain("stats_plays: 500");
    expect(note).toContain("stats_likes: 42");
    expect(note).toContain("stats_comments: 7");
    expect(note).toContain("stats_shares: 3");
    expect(note).toContain("stats_saves: 12");
  });

  it("re-writes the image attachment and raw.json sidecar", async () => {
    const { vault, files, binaryFiles } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTikTokResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeTikTokResyncRecord()]);

    // CHARACTERIZATION: downloadAndSave is called with overwrite=true on the
    // resync path, so 1.jpg is re-written even when it already exists from the
    // first write. raw.json is also re-written (writeSidecar uses modify when
    // the file exists, create when new).
    expect(files.has("Bookmarks/TikTok/tiktok-999/1.jpg")).toBe(true);
    expect(binaryFiles.has("Bookmarks/TikTok/tiktok-999/1.jpg")).toBe(true);
    expect(files.has("Bookmarks/TikTok/tiktok-999/raw.json")).toBe(true);
    const sidecar = JSON.parse(files.get("Bookmarks/TikTok/tiktok-999/raw.json")!);
    expect(sidecar.id).toBe("999");
  });
});

// ── Suite B — Twitter non-threaded resync ─────────────────────────────────────

describe("VaultWriter.resyncRecord — Twitter photo record (non-threaded, via writeBatch two-call)", () => {
  it("STOP-CONDITION GUARD: writeBatch returns resynced:1 confirming resyncRecord ran", async () => {
    const { vault } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTwitterResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const result = await w2.writeBatch([makeTwitterResyncRecord()]);

    expect(result).toEqual({ pushed: 0, skipped: 1, resynced: 1 });
  });

  it("updates title, url, cover frontmatter fields after resync", async () => {
    const { vault, files } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTwitterResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeTwitterResyncRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    // title: no special chars → unquoted
    expect(note).toContain("title: updated tweet text");
    // url contains ":" → quoted
    expect(note).toContain('url: "https://x.com/resyncer/status/777"');
    // cover wikilink starts with "[" → quoted
    expect(note).toContain('cover: "[[Bookmarks/X/twitter-777/1.jpg]]"');
    // platform unchanged, confirms frontmatter preserved and updated in-place
    expect(note).toContain("platform: twitter");
  });

  it("re-writes raw.json and media file", async () => {
    const { vault, files } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTwitterResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeTwitterResyncRecord()]);

    expect(files.has("Bookmarks/X/twitter-777/1.jpg")).toBe(true);
    expect(files.has("Bookmarks/X/twitter-777/raw.json")).toBe(true);
    const sidecar = JSON.parse(files.get("Bookmarks/X/twitter-777/raw.json")!);
    expect(sidecar.rest_id).toBe("777");
  });
});

// ── Suite C — Twitter threaded resync ─────────────────────────────────────────

describe("VaultWriter.resyncRecord — threaded Twitter record (via writeBatch two-call)", () => {
  it("STOP-CONDITION GUARD: writeBatch returns resynced:1 confirming resyncRecord ran", async () => {
    const { vault } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeThreadedTwitterResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const result = await w2.writeBatch([makeThreadedTwitterResyncRecord()]);

    expect(result).toEqual({ pushed: 0, skipped: 1, resynced: 1 });
  });

  it("refreshes thread.json with correct shape (success, pageCount, focalIndex)", async () => {
    const { vault, files } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeThreadedTwitterResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeThreadedTwitterResyncRecord()]);

    const raw = files.get("Bookmarks/X/twitter-888/thread.json");
    expect(raw).toBeDefined();
    const meta = JSON.parse(raw!);

    // CHARACTERIZATION: resync passes skipIfExists: true to renderThreadPages,
    // so page images from call 1 are NOT re-downloaded. thread.json IS always
    // re-written via writeSidecar after threadMeta is returned.
    expect(meta.success).toBe(true);
    expect(meta.pageCount).toBe(2);
    expect(meta.focalIndex).toBe(1);
  });

  it("note frontmatter has thread_length, focal_index, and cover after resync", async () => {
    const { vault, files } = makeBinaryVault();
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeThreadedTwitterResyncRecord()]);

    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeThreadedTwitterResyncRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    expect(note).toContain("thread_length: 2");
    expect(note).toContain("focal_index: 1");
    // CHARACTERIZATION: cover wikilink starts with "[" → double-quoted.
    // cover points at the first page of the focal segment (focalSeg.pages[0] = 1 → 1.jpg).
    expect(note).toContain('cover: "[[Bookmarks/X/twitter-888/1.jpg]]"');
  });
});

// ── Suite D — roost_category / roost_assigned_by preservation on TikTok resync ─

describe("VaultWriter.resyncRecord — TikTok user-assigned category preserved", () => {
  it("CHARACTERIZATION: resync does not clobber roost_category or roost_assigned_by", async () => {
    const { vault, files } = makeBinaryVault();

    // First write seeds the note.
    const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w1.writeBatch([makeTikTokResyncRecord()]);

    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/TikTok/") && p.endsWith(".md"),
    );
    expect(notePath).toBeDefined();

    // Simulate post-rename curation: inject the user-assigned fields into the
    // seeded note's frontmatter (just after the opening fence).
    const original = files.get(notePath!)!;
    const patched = original.replace(
      /^---\n/,
      "---\nroost_category: Finances\nroost_assigned_by: human\n",
    );
    expect(patched).not.toBe(original); // sanity: the fence was found + replaced
    files.set(notePath!, patched);

    // Resync.
    const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    await w2.writeBatch([makeTikTokResyncRecord()]);

    const note = files.get(notePath!)!;
    // Resync refreshes title/url/cover/stats only — the curated fields survive.
    expect(note).toContain("roost_category: Finances");
    expect(note).toContain("roost_assigned_by: human");
  });
});
