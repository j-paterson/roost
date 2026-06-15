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
import { fsIncompleteReason, isDeadSkip } from "../media-backfill";

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

  it("returns 'folder-missing' for a path that does not exist", () => {
    expect(fsIncompleteReason(path.join(dir, "nope"), "twitter")).toBe("folder-missing");
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
