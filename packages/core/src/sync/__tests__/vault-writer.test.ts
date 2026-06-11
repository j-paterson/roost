/**
 * Characterization tests for VaultWriter's core write paths.
 *
 * These tests pin today's observable behavior so that regressions are visible
 * as test failures rather than silent vault corruption.  Surprising behavior
 * is annotated with a `// CHARACTERIZATION:` comment — it documents the
 * observed behavior, not an endorsement of it.
 *
 * Scope: generic-record write path (no twitter/tiktok — those paths hit
 * network and media download code that cannot be run hermetically).
 *
 * See plans/006-vault-writer-characterization-tests.md for the full plan.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { VaultWriter } from "../vault-writer";
import { makeFakeVault } from "./fake-vault";
import type { NormalizedRecord } from "@/lib/normalize";

// ── Minimal generic record ────────────────────────────────────────────────────
// Platform "generic" (anything other than "twitter"/"tiktok") routes to
// writeGenericRecord, which is pure vault I/O — no network calls.
// The rawData fields below satisfy extractBookmarkText (returns ""),
// extractBookmarkAuthor (returns "Unknown"), and extractBookmarkAuthorUsername
// (returns null) — the helpers gracefully degrade to empty/Unknown.
function makeGenericRecord(overrides?: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    id: "generic:1",
    platform: "generic",
    itemId: "1",
    rawData: {
      // desc is the text field for generic; empty string is fine here.
      desc: "hello world",
      author: { uniqueId: "someone" },
    },
    saved_at: "2026-01-02T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
    ...overrides,
  };
}

// ── Step 2: writeBatch with generic records ───────────────────────────────────

describe("VaultWriter.writeBatch — generic record", () => {
  it("new record: pushes, creates note with correct frontmatter", async () => {
    const { vault, files } = makeFakeVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const rec = makeGenericRecord();

    const result = await writer.writeBatch([rec]);

    // Counters: one new record
    expect(result).toEqual({ pushed: 1, skipped: 0, resynced: 0 });

    // A note was written under Bookmarks/Other/
    const notePaths = [...files.keys()].filter(p => p.startsWith("Bookmarks/Other/"));
    expect(notePaths.length).toBeGreaterThanOrEqual(1);

    const noteContent = files.get(notePaths[0])!;
    // Content must start with a frontmatter block
    expect(noteContent).toMatch(/^---\n/);
    // CHARACTERIZATION: roost_id values containing colons are YAML-quoted by
    // buildFrontmatter (the ":" triggers needsQuoting). Parsing via parseRoostId
    // handles the quotes correctly. Pin this behavior so a "fix" doesn't break
    // the id round-trip.
    expect(noteContent).toContain('roost_id: "generic:1"');
  });

  it(
    "same record re-submitted to a fresh VaultWriter over the same vault: " +
    "skipped=1 and resynced=1",
    async () => {
      const { vault, files } = makeFakeVault();

      // First write
      const w1 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
      await w1.writeBatch([makeGenericRecord()]);

      // Fresh VaultWriter — forces a new scanExistingIds call
      const w2 = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
      const result = await w2.writeBatch([makeGenericRecord()]);

      // CHARACTERIZATION: skipped counts every non-new record (it is the
      // "not newly pushed" counter). resynced is a subset of skipped —
      // the display layer subtracts resynced from skipped for the human-readable
      // "skip" count. Both being non-zero for the same record is by design;
      // audit finding CORRECTNESS-04 was reviewed and rejected.
      expect(result).toEqual({ pushed: 0, skipped: 1, resynced: 1 });

      // The file that was written in the first batch is still there
      const notePaths = [...files.keys()].filter(p => p.startsWith("Bookmarks/Other/"));
      expect(notePaths.length).toBeGreaterThanOrEqual(1);
    },
  );

  it("stopSignal already stopped: returns all-zero counters, writes nothing", async () => {
    const { vault, files } = makeFakeVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const stopSignal = { stopped: true };

    const result = await writer.writeBatch([makeGenericRecord()], stopSignal);

    expect(result).toEqual({ pushed: 0, skipped: 0, resynced: 0 });
    // No files written
    expect([...files.keys()].filter(p => p.startsWith("Bookmarks/"))).toHaveLength(0);
  });
});

// ── Step 3: rewriteNoteBody guard-rails ──────────────────────────────────────

describe("VaultWriter.rewriteNoteBody — guard-rails", () => {
  it("record whose note doesn't exist: resolves without throwing, no writes", async () => {
    const { vault, files } = makeFakeVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    const filesBefore = new Map(files);
    await expect(writer.rewriteNoteBody(makeGenericRecord())).resolves.toBeUndefined();
    // Nothing written
    expect([...files.entries()]).toEqual([...filesBefore.entries()]);
  });

  it(
    "note exists but has NO frontmatter: resolves, content is unchanged " +
    "(fmEnd < 0 → skip-rather-than-corrupt guard)",
    async () => {
      const { vault, files, seedNote } = makeFakeVault();
      const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

      // First write a proper note so the note path is known in the vault.
      // We need writeNote to create a file that findNoteForId can locate.
      await writer.writeBatch([makeGenericRecord()]);

      // Overwrite the note with content that has NO frontmatter.
      const notePaths = [...files.keys()].filter(p => p.startsWith("Bookmarks/Other/"));
      expect(notePaths.length).toBeGreaterThanOrEqual(1);
      const notePath = notePaths[0];
      const noFmContent = "just a body with no frontmatter";
      files.set(notePath, noFmContent);

      await expect(writer.rewriteNoteBody(makeGenericRecord())).resolves.toBeUndefined();

      // Content must remain unchanged (the guard bailed out before modify)
      expect(files.get(notePath)).toBe(noFmContent);
    },
  );
});

// ── Step 4: getExistingIds ────────────────────────────────────────────────────

describe("VaultWriter.getExistingIds", () => {
  it("returns IDs of notes inside the sync folder, excludes notes outside", async () => {
    const { vault, files, seedNote } = makeFakeVault();

    // Two notes inside the sync folder with roost_id frontmatter
    seedNote(
      "Bookmarks/TikTok/some-note.md",
      "---\nroost_id: tiktok:1\nplatform: tiktok\n---\n\nbody\n",
    );
    seedNote(
      "Bookmarks/X/some-tweet.md",
      "---\nroost_id: twitter:2\nplatform: twitter\n---\n\nbody\n",
    );
    // One note OUTSIDE the sync folder — must NOT appear in the result
    seedNote(
      "OtherFolder/unrelated.md",
      "---\nroost_id: generic:999\nplatform: generic\n---\n\nbody\n",
    );

    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const ids = await writer.getExistingIds();

    expect(ids.has("tiktok:1")).toBe(true);
    expect(ids.has("twitter:2")).toBe(true);
    // The note outside the sync folder must not appear
    expect(ids.has("generic:999")).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("returns empty set when sync folder has no notes", async () => {
    const { vault } = makeFakeVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const ids = await writer.getExistingIds();
    expect(ids.size).toBe(0);
  });

  it("caches the result — second call returns same Set object", async () => {
    const { vault, seedNote } = makeFakeVault();
    seedNote(
      "Bookmarks/Other/note.md",
      "---\nroost_id: generic:42\nplatform: generic\n---\n\nbody\n",
    );
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });
    const first = await writer.getExistingIds();
    const second = await writer.getExistingIds();
    // Same reference — the cache is returned on the second call
    expect(first).toBe(second);
  });
});

// ── Additional characterization: note content shape ───────────────────────────

describe("VaultWriter — written note content shape", () => {
  it("generic record produces a note with platform, saved, and roost_id fields", async () => {
    const { vault, files } = makeFakeVault();
    const writer = new VaultWriter({ vault: vault as any, syncFolder: "Bookmarks", onLog: () => {} });

    const rec = makeGenericRecord({
      id: "generic:99",
      itemId: "99",
      saved_at: "2026-06-01T12:00:00.000Z",
    });
    await writer.writeBatch([rec]);

    const notePaths = [...files.keys()].filter(p => p.startsWith("Bookmarks/Other/") && p.endsWith(".md"));
    expect(notePaths.length).toBe(1);

    const content = files.get(notePaths[0])!;
    // CHARACTERIZATION: roost_id is YAML-quoted because the value contains ":"
    expect(content).toContain('roost_id: "generic:99"');
    expect(content).toContain("platform: generic");
    // saved field uses the full ISO string for generic records
    expect(content).toContain("saved:");
    // Note ends with newline (writeNote contract)
    expect(content.endsWith("\n")).toBe(true);
  });
});
