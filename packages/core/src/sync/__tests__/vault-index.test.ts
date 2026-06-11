/**
 * Unit tests for the extracted VaultIndex class.
 *
 * These tests exercise VaultIndex directly (independent of VaultWriter)
 * to validate that the extraction preserved behavior.  They mirror the
 * getExistingIds tests from vault-writer.test.ts (plan 006) but target
 * VaultIndex directly, and add focused coverage for findNoteForId and
 * population of existingIds / notePathMap after scanExistingIds.
 */
import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import { VaultIndex } from "../vault-writer/vault-index";
import { makeFakeVault } from "./fake-vault";

// ── getExistingIds (mirrored from vault-writer.test.ts, targeting VaultIndex) ──

describe("VaultIndex.getExistingIds", () => {
  it("returns IDs of notes inside the sync folder, excludes notes outside", async () => {
    const { vault, seedNote } = makeFakeVault();

    seedNote(
      "Bookmarks/TikTok/some-note.md",
      "---\nroost_id: tiktok:1\nplatform: tiktok\n---\n\nbody\n",
    );
    seedNote(
      "Bookmarks/X/some-tweet.md",
      "---\nroost_id: twitter:2\nplatform: twitter\n---\n\nbody\n",
    );
    // Note OUTSIDE the sync folder — must NOT appear in the result
    seedNote(
      "OtherFolder/unrelated.md",
      "---\nroost_id: generic:999\nplatform: generic\n---\n\nbody\n",
    );

    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });
    const ids = await index.getExistingIds();

    expect(ids.has("tiktok:1")).toBe(true);
    expect(ids.has("twitter:2")).toBe(true);
    expect(ids.has("generic:999")).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("returns empty set when sync folder has no notes", async () => {
    const { vault } = makeFakeVault();
    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });
    const ids = await index.getExistingIds();
    expect(ids.size).toBe(0);
  });

  it("caches the result — second call returns same Set object", async () => {
    const { vault, seedNote } = makeFakeVault();
    seedNote(
      "Bookmarks/Other/note.md",
      "---\nroost_id: generic:42\nplatform: generic\n---\n\nbody\n",
    );
    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });
    const first = await index.getExistingIds();
    const second = await index.getExistingIds();
    // Same reference — the cache is returned on the second call
    expect(first).toBe(second);
  });
});

// ── existingIds + notePathMap population after scanExistingIds ────────────────

describe("VaultIndex — existingIds + notePathMap population", () => {
  it("scanExistingIds populates both existingIds and notePathMap", async () => {
    const { vault, seedNote } = makeFakeVault();

    seedNote(
      "Bookmarks/TikTok/tiktok-note.md",
      "---\nroost_id: tiktok:abc\nplatform: tiktok\n---\n\nbody\n",
    );
    seedNote(
      "Bookmarks/X/twitter-note.md",
      "---\nroost_id: twitter:xyz\nplatform: twitter\n---\n\nbody\n",
    );

    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });

    // existingIds starts null
    expect(index.existingIds).toBeNull();
    // notePathMap starts empty
    expect(index.notePathMap.size).toBe(0);

    await index.getExistingIds();

    // After scanning, existingIds is populated
    expect(index.existingIds).not.toBeNull();
    expect(index.existingIds!.has("tiktok:abc")).toBe(true);
    expect(index.existingIds!.has("twitter:xyz")).toBe(true);

    // notePathMap should have both entries pointing to TFile objects
    expect(index.notePathMap.size).toBe(2);
    const tiktokFile = index.notePathMap.get("tiktok:abc");
    const twitterFile = index.notePathMap.get("twitter:xyz");
    expect(tiktokFile).toBeDefined();
    expect(twitterFile).toBeDefined();
    // Files should be TFile instances
    expect(tiktokFile instanceof TFile).toBe(true);
    expect(twitterFile instanceof TFile).toBe(true);
    // Paths should match the seeded paths
    expect(tiktokFile!.path).toBe("Bookmarks/TikTok/tiktok-note.md");
    expect(twitterFile!.path).toBe("Bookmarks/X/twitter-note.md");
  });
});

// ── findNoteForId ─────────────────────────────────────────────────────────────

describe("VaultIndex.findNoteForId", () => {
  it("returns TFile when note exists at standard path", async () => {
    const { vault, seedNote } = makeFakeVault();

    // A Twitter note at the standard "handle - itemId.md" path
    seedNote(
      "Bookmarks/X/@someone - tweet123.md",
      "---\nroost_id: twitter:tweet123\nplatform: twitter\n---\n\nbody\n",
    );

    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });

    const result = index.findNoteForId("twitter:tweet123", "Bookmarks/X", "@someone", "tweet123");
    expect(result).not.toBeNull();
    expect(result instanceof TFile).toBe(true);
    expect(result!.path).toBe("Bookmarks/X/@someone - tweet123.md");
  });

  it("falls back to notePathMap for Eagle-imported notes with non-standard filenames", async () => {
    const { vault, seedNote } = makeFakeVault();

    // Seed a note with a non-standard filename — not findable by direct path lookup
    seedNote(
      "Bookmarks/X/some-imported-note.md",
      "---\nroost_id: twitter:tweet456\nplatform: twitter\n---\n\nbody\n",
    );

    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });

    // Pre-populate notePathMap (as scanExistingIds would do)
    await index.getExistingIds();

    // findNoteForId with the right handle+itemId — direct path won't match,
    // but notePathMap should provide the fallback
    const result = index.findNoteForId("twitter:tweet456", "Bookmarks/X", "@differenthandle", "tweet456");
    expect(result).not.toBeNull();
    expect(result instanceof TFile).toBe(true);
    expect(result!.path).toBe("Bookmarks/X/some-imported-note.md");
  });

  it("returns null when note is not found and not in notePathMap", async () => {
    const { vault } = makeFakeVault();

    const index = new VaultIndex({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
    });

    const result = index.findNoteForId("twitter:missing", "Bookmarks/X", "@ghost", "missing");
    expect(result).toBeNull();
  });
});
