/**
 * Unit tests for NoteFileWriter — the note I/O collaborator extracted from
 * VaultWriter in plan 015 (decomposition phase 2).
 *
 * NoteFileWriter is tested directly, bypassing VaultWriter, so regressions
 * in the extraction are visible without the full writeBatch machinery.
 */
import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import { NoteFileWriter } from "../vault-writer/note-file-writer";
import { makeFakeVault } from "./fake-vault";
import { type VaultIndex } from "../vault-writer/vault-index";
import type { NormalizedRecord } from "@/lib/normalize";

// ── Minimal VaultIndex stub ───────────────────────────────────────────────────

function makeMinimalIndex(files: Map<string, string>): VaultIndex {
  return {
    notePathMap: new Map(),
    findNoteForId(roostId: string, folderPath: string, handle: string, itemId: string) {
      const path = `${folderPath}/${handle} - ${itemId}.md`;
      const content = files.get(path);
      if (!content) return null;
      return Object.assign(Object.create(TFile.prototype) as object, {
        path,
        name: `${handle} - ${itemId}.md`,
        extension: "md",
      }) as TFile;
    },
  } as unknown as VaultIndex;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGenericRecord(overrides?: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    id: "generic:1",
    platform: "generic",
    itemId: "1",
    rawData: {
      // For generic platform, extractBookmarkText uses raw.text (not raw.desc)
      text: "hello world",
      author: { uniqueId: "someone" },
    },
    saved_at: "2026-01-02T00:00:00.000Z",
    published_at: null,
    captured_via: "test",
    ...overrides,
  };
}

// ── Test 1: writeGenericRecord output ─────────────────────────────────────────

describe("NoteFileWriter.writeGenericRecord", () => {
  it("creates note at correct path with correct frontmatter and body", async () => {
    const { vault, files } = makeFakeVault();
    const ensuredFolders = new Set<string>();
    const index = makeMinimalIndex(files);
    const writer = new NoteFileWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
      index,
      ensuredFolders,
    });

    const rec = makeGenericRecord();
    await writer.writeGenericRecord(rec);

    const notePaths = [...files.keys()].filter(p => p.startsWith("Bookmarks/Other/"));
    expect(notePaths.length).toBe(1);

    const noteContent = files.get(notePaths[0])!;
    expect(noteContent).toContain('roost_id: "generic:1"');
    expect(noteContent).toContain("platform: generic");
    // For generic platform, extractBookmarkText uses raw.text
    expect(noteContent).toContain("hello world");
  });
});

// ── Test 2: rewriteNoteBody no-op on missing note ─────────────────────────────

describe("NoteFileWriter.rewriteNoteBody", () => {
  it("no-op when index returns null for findNoteForId", async () => {
    const { vault, files } = makeFakeVault();
    const ensuredFolders = new Set<string>();
    // Index that always returns null
    const emptyIndex = {
      notePathMap: new Map(),
      findNoteForId: () => null,
    } as unknown as VaultIndex;
    const writer = new NoteFileWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
      index: emptyIndex,
      ensuredFolders,
    });

    const rec = makeGenericRecord();
    await writer.rewriteNoteBody(rec);

    // No files should have been modified (vault starts empty, nothing created)
    expect(files.size).toBe(0);
  });

  it("rewrites body when frontmatter is present", async () => {
    const { vault, files } = makeFakeVault();
    const ensuredFolders = new Set<string>();

    // For generic platform: extractBookmarkAuthor returns "Unknown" (no twitter/tiktok logic),
    // extractBookmarkAuthorUsername returns null, so handle = "Unknown".
    // folderPath = "Bookmarks/Other", path = "Bookmarks/Other/Unknown - 1.md"
    const notePath = "Bookmarks/Other/Unknown - 1.md";
    const initialContent = "---\nroost_id: \"generic:1\"\nplatform: generic\n---\n\nold body\n";
    files.set(notePath, initialContent);

    const index = makeMinimalIndex(files);
    const writer = new NoteFileWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
      index,
      ensuredFolders,
    });

    // Use text field (not desc) — generic platform extractBookmarkText uses raw.text
    const rec = makeGenericRecord({ rawData: { text: "new body text", author: { uniqueId: "someone" } } });
    await writer.rewriteNoteBody(rec);

    const updatedContent = files.get(notePath)!;
    expect(updatedContent).toBeTruthy();
    expect(updatedContent.endsWith("new body text\n")).toBe(true);
  });
});

// ── Test 3: stampEnrichmentVersion no-op when roostId not in notePathMap ──────

describe("NoteFileWriter.stampEnrichmentVersion", () => {
  it("no-op when roostId is not in notePathMap", async () => {
    const { vault, files } = makeFakeVault();
    const ensuredFolders = new Set<string>();
    const index = makeMinimalIndex(files);
    const writer = new NoteFileWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
      index,
      ensuredFolders,
    });

    // Call with a roostId that's not in the index's notePathMap
    await writer.stampEnrichmentVersion("generic:99", "articleBody", 1);

    // vault.modify should never have been called — files unchanged
    expect(files.size).toBe(0);
  });
});

// ── Tests 4–5: writeSidecar create and modify ─────────────────────────────────

describe("NoteFileWriter.writeSidecar", () => {
  it("creates new file when path does not exist", async () => {
    const { vault, files } = makeFakeVault();
    const ensuredFolders = new Set<string>();
    const index = makeMinimalIndex(files);
    const writer = new NoteFileWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
      index,
      ensuredFolders,
    });

    await writer.writeSidecar("Bookmarks/Other/sidecar.json", '{"hello":"world"}');

    expect(files.has("Bookmarks/Other/sidecar.json")).toBe(true);
    expect(files.get("Bookmarks/Other/sidecar.json")).toBe('{"hello":"world"}');
  });

  it("modifies existing file when path already exists", async () => {
    const { vault, files } = makeFakeVault();
    files.set("Bookmarks/Other/sidecar.json", '{"original":"data"}');

    const ensuredFolders = new Set<string>();
    const index = makeMinimalIndex(files);
    const writer = new NoteFileWriter({
      vault: vault as any,
      syncFolder: "Bookmarks",
      log: () => {},
      index,
      ensuredFolders,
    });

    await writer.writeSidecar("Bookmarks/Other/sidecar.json", '{"updated":"data"}');

    expect(files.get("Bookmarks/Other/sidecar.json")).toBe('{"updated":"data"}');
  });
});
