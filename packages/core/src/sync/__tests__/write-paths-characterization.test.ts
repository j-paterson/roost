/**
 * Characterization tests for VaultWriter's Twitter and TikTok write paths.
 *
 * These tests pin the observable output of `writeBatch` for the twitter and
 * tiktok platform branches so that any behavioral drift during Phase 4 of the
 * VaultWriter decomposition (extracting TwitterRecordWriter / TikTokRecordWriter)
 * shows up as a red test rather than silent vault corruption.
 *
 * DECOMPOSITION SURVIVAL CONTRACT:
 *   All assertions are on `writeBatch` output — the `files` map (text content)
 *   and `binaryFiles` map (attachment paths). No assertion touches internal
 *   method names or call counts. The suite therefore survives Phase 4 moving
 *   `writeTwitterRecord`, `writeTikTokRecord`, and `renderThreadPages` into
 *   `TwitterRecordWriter` / `TikTokRecordWriter` collaborators without change.
 *
 * Surprising behavior is annotated with `// CHARACTERIZATION:` and documents
 * observed behavior, not an endorsement of it. Do NOT "fix" it here.
 *
 * See plans/018-write-paths-characterization.md for the full plan.
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
      "WEBVTT\n\n00:00.000 --> 00:02.000\nhello world this is a transcript line\n"),
  };
});

// ── Stub card rendering only for the twitter text/card path ───────────────────
// happy-dom has no OffscreenCanvas, so the real renderCardAsync returns null
// (it catches the OffscreenCanvas error and returns null). We mock it to return
// a tiny PNG buffer so the text/card path deterministically writes card.png.
// IMPORTANT: photo and carousel tests must NOT override this mock — they don't
// reach renderCardAsync, and leaving the mock active there would only hide a
// regression if the code accidentally fell through to card rendering.
vi.mock("../card-renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../card-renderer")>();
  return {
    ...actual, // keep pure exported helpers intact
    renderCardAsync: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer),
  };
});

import { VaultWriter } from "../vault-writer";
import { makeFakeVault } from "./fake-vault";
import type { NormalizedRecord } from "@/lib/normalize";

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

// ── Synthetic record factories ─────────────────────────────────────────────────

/**
 * Twitter photo record.
 * Media lives at rawData.legacy.extended_entities.media[] with type "photo".
 * Author at rawData.core.user_results.result.core.screen_name (+.name).
 * One photo at array index 0 → cover file name "1.jpg".
 */
function makeTwitterPhotoRecord(): NormalizedRecord {
  return {
    id: "twitter:111",
    platform: "twitter",
    itemId: "111",
    rawData: {
      rest_id: "111",
      core: {
        user_results: {
          result: {
            core: { name: "Ada", screen_name: "ada" },
          },
        },
      },
      legacy: {
        full_text: "a photo tweet #cats",
        extended_entities: {
          media: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/p1" },
          ],
        },
      },
    },
    saved_at: "2026-02-03T00:00:00.000Z",
    published_at: "2026-02-01T12:00:00.000Z",
    captured_via: "test",
  };
}

/**
 * Twitter text-only record (no media).
 * Exercises the renderCardAsync branch (mocked to return a 4-byte PNG buffer)
 * which writes card.png and sets it as cover.
 */
function makeTwitterTextRecord(): NormalizedRecord {
  return {
    id: "twitter:222",
    platform: "twitter",
    itemId: "222",
    rawData: {
      rest_id: "222",
      core: {
        user_results: {
          result: { core: { name: "Bob", screen_name: "bob" } },
        },
      },
      legacy: { full_text: "just some words from @alice about #pasta" },
    },
    saved_at: "2026-02-04T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

/**
 * TikTok image carousel record.
 * Images at rawData.imagePost.images[] with imageURL as a plain string (one of
 * three supported shapes — string | {urlList} | {url}).
 * Two images at indices 0 and 1 → filenames 1.jpg and 2.jpg; cover = 1.jpg.
 */
function makeTikTokCarouselRecord(): NormalizedRecord {
  return {
    id: "tiktok:333",
    platform: "tiktok",
    itemId: "333",
    rawData: {
      id: "333",
      desc: "carousel post #fyp",
      author: { uniqueId: "creator", nickname: "Creator" },
      imagePost: {
        images: [
          { imageURL: "https://p.tiktok.com/img0" },
          { imageURL: "https://p.tiktok.com/img1" },
        ],
      },
      challenges: [{ title: "fyp" }],
      stats: {
        playCount: 10,
        diggCount: 5,
        commentCount: 2,
        shareCount: 1,
        collectCount: 3,
      },
    },
    saved_at: "2026-02-05T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

/**
 * TikTok video record without an Electron webview.
 * video.playAddr is present but NOT downloaded (VaultWriter guards on
 * `this.tiktokWc` being set — tests never inject a webview).
 * video.originCover → cover.jpg; video.subtitleInfos → subtitle.vtt sidecar
 * and subtitle frontmatter field.
 */
function makeTikTokVideoRecord(): NormalizedRecord {
  return {
    id: "tiktok:444",
    platform: "tiktok",
    itemId: "444",
    rawData: {
      id: "444",
      desc: "a video post",
      author: { uniqueId: "vidmaker", nickname: "VidMaker" },
      video: {
        playAddr: "https://v.tiktok.com/play/444",        // present but NOT downloaded (no webview)
        originCover: "https://p.tiktok.com/cover444",      // → cover.jpg
        subtitleInfos: [
          {
            Url: "https://sub.tiktok.com/444.vtt",
            Source: "creator",
            LanguageCodeName: "eng-US",
          },
        ],
      },
      stats: { playCount: 100, diggCount: 50, commentCount: 10, shareCount: 5, collectCount: 20 },
    },
    saved_at: "2026-02-06T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VaultWriter.writeBatch — Twitter photo record", () => {
  it("writes note + photo attachment + raw.json sidecar + author note; cover → 1.jpg", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      onLog: () => {},
    });

    const result = await writer.writeBatch([makeTwitterPhotoRecord()]);

    // Counter semantics
    expect(result).toEqual({ pushed: 1, skipped: 0, resynced: 0 });

    // Note lives under Bookmarks/X/
    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    // Core frontmatter fields
    // CHARACTERIZATION: roost_id values containing ":" are YAML-quoted by
    // buildFrontmatter because ":" triggers needsQuoting. Pin the quoted form.
    expect(note).toContain('roost_id: "twitter:111"');
    expect(note).toContain("platform: twitter");

    // CHARACTERIZATION: author wikilink contains "[" which triggers needsQuoting.
    // buildFrontmatter emits: author: "[[People/@ada]]"
    expect(note).toContain('author: "[[People/@ada]]"');

    // URL contains ":" → also YAML-quoted
    expect(note).toContain('url: "https://x.com/ada/status/111"');

    // Cover points at 1.jpg (media-array index 0 + 1)
    // CHARACTERIZATION: cover wikilink starts with "[" → quoted.
    expect(note).toContain('cover: "[[Bookmarks/X/twitter-111/1.jpg]]"');

    // Hashtag #cats promoted to the tags array
    expect(note).toContain("cats");

    // Published date truncated to date portion
    expect(note).toContain("published: 2026-02-01");

    // The photo attachment and sidecar were written
    expect(files.has("Bookmarks/X/twitter-111/1.jpg")).toBe(true);
    expect(files.has("Bookmarks/X/twitter-111/raw.json")).toBe(true);

    // Author note created at People/@ada.md
    expect(files.has("People/@ada.md")).toBe(true);
  });
});

describe("VaultWriter.writeBatch — Twitter text/card record", () => {
  it("writes note + card.png (mocked renderCardAsync); cover → card.png", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      onLog: () => {},
    });

    const result = await writer.writeBatch([makeTwitterTextRecord()]);

    // Counter semantics
    expect(result).toEqual({ pushed: 1, skipped: 0, resynced: 0 });

    // Note lives under Bookmarks/X/
    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/X/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    expect(note).toContain('roost_id: "twitter:222"');
    expect(note).toContain("platform: twitter");
    // title stays the plain single-line text (newlines flattened to spaces).
    // The leading "#" makes buildFrontmatter YAML-quote the value.
    expect(note).toContain('title: "just some words from @alice about #pasta"');

    // NEW (plan 031): the note body is now the rendered markdown — non-empty
    // and carrying the linkified tweet text (@mention + #hashtag as real links).
    const bodyStart = note.indexOf("\n---\n");
    const body = note.slice(bodyStart + 5);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body).toContain("[@alice](https://x.com/alice)");
    expect(body).toContain("[#pasta](https://x.com/hashtag/pasta)");
    // The enrichment version is stamped at write time so the note isn't
    // re-flagged by the first-rollout detection predicate.
    expect(note).toContain("enrichment_v_tweetBody: 1");

    // CHARACTERIZATION: in a real Obsidian/Electron environment renderCardAsync
    // uses OffscreenCanvas to produce a PNG card. In happy-dom, OffscreenCanvas is
    // undefined so the real implementation catches the error and returns null —
    // meaning no card.png would be written and cover would be absent. The test mocks
    // renderCardAsync to return a 4-byte PNG buffer so the card write path is
    // deterministic. This assertion pins that a text-only tweet with a successful
    // card render writes card.png and sets it as cover.
    expect(note).toContain('cover: "[[Bookmarks/X/twitter-222/card.png]]"');
    expect(files.has("Bookmarks/X/twitter-222/card.png")).toBe(true);

    // raw.json sidecar always written
    expect(files.has("Bookmarks/X/twitter-222/raw.json")).toBe(true);

    // Author note created
    expect(files.has("People/@bob.md")).toBe(true);
  });
});

describe("VaultWriter.writeBatch — TikTok carousel record", () => {
  it("writes note + 2 carousel images + raw.json + author note; cover → 1.jpg; stats + tag", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      onLog: () => {},
    });

    const result = await writer.writeBatch([makeTikTokCarouselRecord()]);

    // Counter semantics
    expect(result).toEqual({ pushed: 1, skipped: 0, resynced: 0 });

    // Note lives under Bookmarks/TikTok/
    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/TikTok/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    expect(note).toContain('roost_id: "tiktok:333"');
    expect(note).toContain("platform: tiktok");
    // CHARACTERIZATION: title contains "#" which triggers needsQuoting in
    // buildFrontmatter, so the value is YAML-double-quoted.
    expect(note).toContain('title: "carousel post #fyp"');

    // URL contains special chars → quoted
    expect(note).toContain('url: "https://www.tiktok.com/@creator/video/333"');

    // Cover = first carousel image (index 0 + 1 = 1.jpg)
    expect(note).toContain('cover: "[[Bookmarks/TikTok/tiktok-333/1.jpg]]"');

    // Both carousel images written
    expect(files.has("Bookmarks/TikTok/tiktok-333/1.jpg")).toBe(true);
    expect(files.has("Bookmarks/TikTok/tiktok-333/2.jpg")).toBe(true);

    // Sidecar and author note
    expect(files.has("Bookmarks/TikTok/tiktok-333/raw.json")).toBe(true);
    expect(files.has("People/@creator.md")).toBe(true);

    // Stats frontmatter fields
    expect(note).toContain("stats_plays: 10");
    expect(note).toContain("stats_likes: 5");
    expect(note).toContain("stats_comments: 2");
    expect(note).toContain("stats_shares: 1");
    expect(note).toContain("stats_saves: 3");

    // Challenge/hashtag promoted to tags
    expect(note).toContain("fyp");
  });
});

describe("VaultWriter.writeBatch — TikTok video record (no webview)", () => {
  it("writes cover.jpg + subtitle.vtt; NO video.mp4 (webview guard); subtitle in frontmatter", async () => {
    const { vault, files } = makeBinaryVault();
    const writer = new VaultWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      onLog: () => {},
      // No tiktokWebview injected — simulates the non-Electron test environment
    });

    const result = await writer.writeBatch([makeTikTokVideoRecord()]);

    // Counter semantics
    expect(result).toEqual({ pushed: 1, skipped: 0, resynced: 0 });

    // Note lives under Bookmarks/TikTok/
    const notePath = [...files.keys()].find(
      p => p.startsWith("Bookmarks/TikTok/") && p.endsWith(".md")
    );
    expect(notePath).toBeDefined();
    const note = files.get(notePath!)!;

    expect(note).toContain('roost_id: "tiktok:444"');
    expect(note).toContain("platform: tiktok");

    // CHARACTERIZATION: with no Electron webview injected, the TikTok video
    // download branch is guarded by `media.videoUrl && this.tiktokWc`. Without
    // a webview, the guard fails and execution falls through to the cover-only
    // branch (video.originCover → cover.jpg). The note is still valid; only the
    // video bytes are skipped. This pins that a webview-less environment produces
    // a complete note from cover + subtitle, and writes NO video.mp4.
    expect(note).toContain('cover: "[[Bookmarks/TikTok/tiktok-444/cover.jpg]]"');
    expect(files.has("Bookmarks/TikTok/tiktok-444/cover.jpg")).toBe(true);

    // video.mp4 must NOT be written (no webview → video download skipped)
    expect(files.has("Bookmarks/TikTok/tiktok-444/video.mp4")).toBe(false);

    // Subtitle VTT sidecar written (raw VTT cached before parsing)
    expect(files.has("Bookmarks/TikTok/tiktok-444/subtitle.vtt")).toBe(true);

    // CHARACTERIZATION: the mock downloadTikTokSubtitle returns a VTT string
    // whose parsed text ("hello world this is a transcript line") is 47 chars
    // which is > 10, so the `subtitle` frontmatter field is set.
    expect(note).toContain("subtitle:");

    // raw.json sidecar + author note
    expect(files.has("Bookmarks/TikTok/tiktok-444/raw.json")).toBe(true);
    expect(files.has("People/@vidmaker.md")).toBe(true);
  });
});
