/**
 * Unit tests for the two pure pieces of media-backfill: the filesystem-truth
 * completeness check (fsIncompleteReason) and the dead-URL skip decision
 * (isDeadSkip).
 *
 * The heavy parts of runMediaBackfill (walkDir, VaultWriter, resyncRecord) are
 * not driven here; only the extracted pure helpers are exercised, so the
 * dead-skip / freshness logic is verified without the full backfill machinery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fsIncompleteReason, isDeadSkip, migrateLegacyTwitterMedia } from "../media-backfill";

describe("fsIncompleteReason", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-mediabf-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'no-media' for an empty folder", () => {
    expect(fsIncompleteReason(dir, "twitter")).toBe("no-media");
  });

  it("returns null when a folder has 1.jpg (complete)", () => {
    fs.writeFileSync(path.join(dir, "1.jpg"), "x");
    expect(fsIncompleteReason(dir, "twitter")).toBeNull();
  });

  it("returns 'legacy-no-1jpg' for a twitter folder with media.jpg but no 1.jpg", () => {
    fs.writeFileSync(path.join(dir, "media.jpg"), "x");
    expect(fsIncompleteReason(dir, "twitter")).toBe("legacy-no-1jpg");
  });

  it("returns 'video-no-poster' for a twitter folder with video.mp4 and no poster", () => {
    fs.writeFileSync(path.join(dir, "video.mp4"), "x");
    expect(fsIncompleteReason(dir, "twitter")).toBe("video-no-poster");
  });

  it("returns null for a PNG carousel that also has a stray media.jpg (not legacy)", () => {
    fs.writeFileSync(path.join(dir, "1.png"), "x");
    fs.writeFileSync(path.join(dir, "2.png"), "x");
    fs.writeFileSync(path.join(dir, "media.jpg"), "x");
    expect(fsIncompleteReason(dir, "twitter")).toBeNull();
  });

  it("returns null for a video note (video.mp4 + poster + thumb), not legacy-no-1jpg", () => {
    fs.writeFileSync(path.join(dir, "video.mp4"), "x");
    fs.writeFileSync(path.join(dir, "video-poster.jpg"), "x");
    fs.writeFileSync(path.join(dir, "thumb.png"), "x");
    expect(fsIncompleteReason(dir, "twitter")).toBeNull();
  });

  it("returns null for a thumb-only folder (thumb cover, not incomplete)", () => {
    fs.writeFileSync(path.join(dir, "thumb.png"), "x");
    expect(fsIncompleteReason(dir, "twitter")).toBeNull();
  });

  it("returns 'folder-missing' for a path that does not exist", () => {
    expect(fsIncompleteReason(path.join(dir, "nope"), "twitter")).toBe("folder-missing");
  });
});

describe("migrateLegacyTwitterMedia", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-mediabf-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies media.jpg -> 1.jpg for a genuine legacy single (returns true)", () => {
    fs.writeFileSync(path.join(dir, "media.jpg"), "hello");
    expect(migrateLegacyTwitterMedia(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "1.jpg"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "1.jpg"), "utf8")).toBe("hello");
  });

  it("is a no-op when 1.jpg already exists (returns false)", () => {
    fs.writeFileSync(path.join(dir, "media.jpg"), "x");
    fs.writeFileSync(path.join(dir, "1.jpg"), "existing");
    expect(migrateLegacyTwitterMedia(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "1.jpg"), "utf8")).toBe("existing");
  });

  it("is a no-op when 1.png (carousel) is present (returns false)", () => {
    fs.writeFileSync(path.join(dir, "media.jpg"), "x");
    fs.writeFileSync(path.join(dir, "1.png"), "x");
    expect(migrateLegacyTwitterMedia(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "1.jpg"))).toBe(false);
  });

  it("is a no-op when video.mp4 is present (returns false)", () => {
    fs.writeFileSync(path.join(dir, "media.jpg"), "x");
    fs.writeFileSync(path.join(dir, "video.mp4"), "x");
    expect(migrateLegacyTwitterMedia(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "1.jpg"))).toBe(false);
  });

  it("is a no-op when no media.jpg is present (returns false)", () => {
    fs.writeFileSync(path.join(dir, "thumb.png"), "x");
    expect(migrateLegacyTwitterMedia(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "1.jpg"))).toBe(false);
  });
});

describe("isDeadSkip", () => {
  it("returns false for a fresh item (undefined entry)", () => {
    expect(isDeadSkip(undefined, 100)).toBe(false);
  });

  it("returns false for an ok item", () => {
    expect(isDeadSkip({ ok: true, attempts: 9, fetchedAt: 100 }, 50)).toBe(false);
  });

  it("returns false for a failed item below the attempt budget", () => {
    expect(isDeadSkip({ ok: false, attempts: 2, fetchedAt: 100 }, 50)).toBe(false);
  });

  it("returns true for a failed item at/over budget with stale raw.json (mtime <= fetchedAt)", () => {
    expect(isDeadSkip({ ok: false, attempts: 3, fetchedAt: 100 }, 100)).toBe(true);
    expect(isDeadSkip({ ok: false, attempts: 5, fetchedAt: 100 }, 50)).toBe(true);
  });

  it("returns false for a failed item at/over budget when raw.json is newer (recovery)", () => {
    expect(isDeadSkip({ ok: false, attempts: 3, fetchedAt: 100 }, 101)).toBe(false);
  });
});
