/**
 * Unit tests for nsfw-image-detector.ts
 *
 * Covers:
 *   classifyNsfwImage
 *     - returns max nsfw_score across all paths
 *     - returns 0 on empty paths
 *     - returns 0 when sidecar is unreachable (fetch throws)
 *     - returns 0 when fetch returns non-ok status
 *     - returns 0 when results array is empty
 *     - returns 0 when all nsfw_score values are malformed
 *     - handles a single path correctly
 *     - deduplicates the max across multiple results
 *
 *   nsfwEnsemble — OR truth table
 *     - false when both below threshold
 *     - true when image fires, text does not
 *     - true when text fires, image does not
 *     - true when both fire
 *     - boundary: image exactly at threshold fires
 *     - boundary: text exactly at threshold fires
 *     - boundary: image just below threshold does not fire (text also below)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  classifyNsfwImage,
  nsfwEnsemble,
  resolveAttachmentImagePaths,
  type NoteImageInfo,
} from "@/pipeline/nsfw-image-detector";

// ── classifyNsfwImage tests ──────────────────────────────────────────────────

const NSFW_ENDPOINT = "http://127.0.0.1:11435/classify-nsfw";

describe("classifyNsfwImage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(body: unknown, ok = true, status = 200): void {
    globalThis.fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it("returns 0 when coverPaths is empty (no fetch call)", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const score = await classifyNsfwImage([]);
    expect(score).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the max nsfw_score from a multi-result response", async () => {
    mockFetch({
      results: [
        { path: "/abs/cover.jpg", nsfw_score: 0.3 },
        { path: "/abs/1.jpg", nsfw_score: 0.85 },
        { path: "/abs/2.jpg", nsfw_score: 0.6 },
      ],
    });
    const score = await classifyNsfwImage(["/abs/cover.jpg", "/abs/1.jpg", "/abs/2.jpg"]);
    expect(score).toBeCloseTo(0.85, 5);
  });

  it("returns the single nsfw_score when only one path is provided", async () => {
    mockFetch({ results: [{ path: "/abs/cover.jpg", nsfw_score: 0.42 }] });
    const score = await classifyNsfwImage(["/abs/cover.jpg"]);
    expect(score).toBeCloseTo(0.42, 5);
  });

  it("returns 0 when fetch throws (sidecar unreachable)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const score = await classifyNsfwImage(["/abs/cover.jpg"]);
    expect(score).toBe(0);
  });

  it("returns 0 when response is not ok (e.g. 500)", async () => {
    mockFetch({ error: "internal server error" }, false, 500);
    const score = await classifyNsfwImage(["/abs/cover.jpg"]);
    expect(score).toBe(0);
  });

  it("returns 0 when results array is empty", async () => {
    mockFetch({ results: [] });
    const score = await classifyNsfwImage(["/abs/cover.jpg"]);
    expect(score).toBe(0);
  });

  it("returns 0 when all nsfw_score values are non-numeric", async () => {
    mockFetch({
      results: [
        { path: "/abs/cover.jpg", nsfw_score: null },
        { path: "/abs/1.jpg", nsfw_score: "high" },
      ],
    });
    const score = await classifyNsfwImage(["/abs/cover.jpg", "/abs/1.jpg"]);
    expect(score).toBe(0);
  });

  it("returns 0 when response has no results field", async () => {
    mockFetch({ error: "bad format" });
    const score = await classifyNsfwImage(["/abs/cover.jpg"]);
    expect(score).toBe(0);
  });

  it("posts to the correct NSFW endpoint with the correct body", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ path: "/abs/cover.jpg", nsfw_score: 0.7 }] }),
    })) as unknown as typeof fetch;
    globalThis.fetch = spy;

    await classifyNsfwImage(["/abs/cover.jpg"]);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = (spy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(NSFW_ENDPOINT);
    expect((init as RequestInit).method).toBe("POST");
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed.paths).toEqual(["/abs/cover.jpg"]);
  });

  it("video.mp4 path is passed through to the sidecar (sidecar handles keyframes)", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ path: "/abs/tiktok-123/video.mp4", nsfw_score: 0.91 }],
      }),
    })) as unknown as typeof fetch;
    globalThis.fetch = spy;

    const score = await classifyNsfwImage(["/abs/tiktok-123/video.mp4"]);
    expect(score).toBeCloseTo(0.91, 5);
    const [, init] = (spy as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed.paths).toContain("/abs/tiktok-123/video.mp4");
  });
});

// ── nsfwEnsemble OR truth table ─────────────────────────────────────────────

describe("nsfwEnsemble — OR truth table", () => {
  const IMG_THR = 0.5;
  const TEXT_THR = 0.4;

  it("returns false when both scores are below their thresholds", () => {
    expect(nsfwEnsemble(0.3, 0.2, IMG_THR, TEXT_THR)).toBe(false);
  });

  it("returns true when image score meets threshold, text does not", () => {
    expect(nsfwEnsemble(0.6, 0.1, IMG_THR, TEXT_THR)).toBe(true);
  });

  it("returns true when text score meets threshold, image does not", () => {
    expect(nsfwEnsemble(0.1, 0.5, IMG_THR, TEXT_THR)).toBe(true);
  });

  it("returns true when both scores meet their thresholds", () => {
    expect(nsfwEnsemble(0.8, 0.9, IMG_THR, TEXT_THR)).toBe(true);
  });

  it("image exactly at threshold fires (>= is inclusive)", () => {
    expect(nsfwEnsemble(IMG_THR, 0.0, IMG_THR, TEXT_THR)).toBe(true);
  });

  it("text exactly at threshold fires (>= is inclusive)", () => {
    expect(nsfwEnsemble(0.0, TEXT_THR, IMG_THR, TEXT_THR)).toBe(true);
  });

  it("image just below threshold does not fire when text is also below", () => {
    expect(nsfwEnsemble(IMG_THR - 0.001, TEXT_THR - 0.001, IMG_THR, TEXT_THR)).toBe(false);
  });

  it("uses default imgThr of 0.5 when explicitly passed as 0.5", () => {
    // Verify the documented default value (0.5) matches the behaviour
    expect(nsfwEnsemble(0.49, 0.0, 0.5, 0.9)).toBe(false);
    expect(nsfwEnsemble(0.5, 0.0, 0.5, 0.9)).toBe(true);
  });

  it("scores of 0 / 0 return false", () => {
    expect(nsfwEnsemble(0, 0, IMG_THR, TEXT_THR)).toBe(false);
  });

  it("scores of 1 / 1 return true", () => {
    expect(nsfwEnsemble(1, 1, IMG_THR, TEXT_THR)).toBe(true);
  });
});

// ── resolveAttachmentImagePaths tests ─────────────────────────────────────────────

describe("resolveAttachmentImagePaths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-spicy-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeNote(overrides: Partial<NoteImageInfo> = {}): NoteImageInfo {
    return {
      vaultPath: tmpDir,
      notePath: "Bookmarks/TikTok/some-note.md",
      roostId: "tiktok:7123456789",
      ...overrides,
    };
  }

  function attachDir(): string {
    return path.join(tmpDir, "Bookmarks", "TikTok", "tiktok-7123456789");
  }

  function touch(relPath: string): string {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
    return abs;
  }

  it("returns empty array when no files exist", () => {
    const result = resolveAttachmentImagePaths(makeNote());
    expect(result).toHaveLength(0);
  });

  it("includes cover.jpg from the attachment folder", () => {
    touch("Bookmarks/TikTok/tiktok-7123456789/cover.jpg");
    const result = resolveAttachmentImagePaths(makeNote());
    expect(result).toContain(path.join(attachDir(), "cover.jpg"));
  });

  it("includes video-poster.jpg from the attachment folder", () => {
    touch("Bookmarks/TikTok/tiktok-7123456789/video-poster.jpg");
    const result = resolveAttachmentImagePaths(makeNote());
    expect(result).toContain(path.join(attachDir(), "video-poster.jpg"));
  });

  it("includes numbered images (1.jpg … 11.jpg)", () => {
    for (let i = 1; i <= 3; i++) {
      touch(`Bookmarks/TikTok/tiktok-7123456789/${i}.jpg`);
    }
    const result = resolveAttachmentImagePaths(makeNote());
    expect(result).toContain(path.join(attachDir(), "1.jpg"));
    expect(result).toContain(path.join(attachDir(), "2.jpg"));
    expect(result).toContain(path.join(attachDir(), "3.jpg"));
    expect(result).not.toContain(path.join(attachDir(), "4.jpg"));
  });

  it("includes video.mp4 from the attachment folder", () => {
    touch("Bookmarks/TikTok/tiktok-7123456789/video.mp4");
    const result = resolveAttachmentImagePaths(makeNote());
    expect(result).toContain(path.join(attachDir(), "video.mp4"));
  });

  it("resolves cover from wikilink frontmatter and de-duplicates against attachment folder", () => {
    touch("Bookmarks/TikTok/tiktok-7123456789/cover.jpg");
    const note = makeNote({
      cover: "[[Bookmarks/TikTok/tiktok-7123456789/cover.jpg]]",
    });
    const result = resolveAttachmentImagePaths(note);
    // cover.jpg appears only once despite being in both wikilink and named scan
    const count = result.filter(p => p === path.join(attachDir(), "cover.jpg")).length;
    expect(count).toBe(1);
  });

  it("resolves cover from bare vault-relative path", () => {
    touch("Bookmarks/TikTok/tiktok-7123456789/cover.jpg");
    const note = makeNote({
      cover: "Bookmarks/TikTok/tiktok-7123456789/cover.jpg",
    });
    const result = resolveAttachmentImagePaths(note);
    expect(result).toContain(path.join(tmpDir, "Bookmarks/TikTok/tiktok-7123456789/cover.jpg"));
  });

  it("does not include non-existent paths", () => {
    // Nothing is created on disk — result must be empty
    const note = makeNote({ cover: "[[Bookmarks/TikTok/tiktok-7123456789/cover.jpg]]" });
    const result = resolveAttachmentImagePaths(note);
    expect(result).toHaveLength(0);
  });

  it("handles roostId without a colon gracefully (no attachment folder scanned)", () => {
    touch("Bookmarks/TikTok/tiktok-7123456789/cover.jpg");
    const note = makeNote({ roostId: "badrootid" });
    // No platform:id split → no attachment folder — returns empty (no cover in frontmatter either)
    const result = resolveAttachmentImagePaths(note);
    expect(result).toHaveLength(0);
  });
});
