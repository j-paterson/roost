/**
 * Unit tests for MediaDownloader — the binary-download collaborator extracted
 * from VaultWriter in plan 017 (decomposition phase 3).
 *
 * MediaDownloader is tested directly, bypassing VaultWriter, so regressions
 * in the extraction are visible without the full writeBatch machinery.
 */
import { describe, it, expect, vi } from "vitest";
import { MediaDownloader } from "../vault-writer/media-downloader";
import { makeFakeVault } from "./fake-vault";
import { type VaultIndex } from "../vault-writer/vault-index";
import { type NoteFileWriter } from "../vault-writer/note-file-writer";

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeMinimalIndex(): VaultIndex {
  return {
    notePathMap: new Map(),
  } as unknown as VaultIndex;
}

function makeMinimalNoteWriter(): { noteWriter: NoteFileWriter; sidecarCalls: Array<[string, string]> } {
  const sidecarCalls: Array<[string, string]> = [];
  const noteWriter = {
    writeSidecar: async (path: string, content: string) => { sidecarCalls.push([path, content]); },
  } as unknown as NoteFileWriter;
  return { noteWriter, sidecarCalls };
}

// ── Extend fake vault with binary support ─────────────────────────────────────

function makeFakeVaultWithBinary() {
  const base = makeFakeVault();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const vaultWithBinary = Object.assign(base.vault, {
    createBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      binaryFiles.set(path, data);
      base.files.set(path, `[binary: ${path}]`); // marker so getAbstractFileByPath works
    },
    delete: async (_file: unknown): Promise<void> => { /* no-op in tests */ },
  });
  return { ...base, vault: vaultWithBinary, binaryFiles };
}

// ── Helper to make a MediaDownloader ─────────────────────────────────────────

function makeMediaDownloader(vaultObj: ReturnType<typeof makeFakeVaultWithBinary>) {
  const { noteWriter } = makeMinimalNoteWriter();
  const ensuredFolders = new Set<string>();
  return new MediaDownloader({
    vault: vaultObj.vault as any,
    log: () => {},
    index: makeMinimalIndex(),
    noteWriter,
    ensuredFolders,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MediaDownloader.downloadAndSave", () => {
  it("skip-if-exists: returns embed string immediately without calling downloadFn", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const attachFolder = "Bookmarks/X/twitter-123";
    fakeVault.files.set(`${attachFolder}/1.jpg`, "[existing]");

    const md = makeMediaDownloader(fakeVault);
    const downloadFn = vi.fn(async () => { throw new Error("should not be called"); });

    const result = await md.downloadAndSave(downloadFn, attachFolder, "1.jpg", true);

    expect(result).toBe(`![[${attachFolder}/1.jpg]]`);
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it("skip-if-exists via altNames: skips (and returns the alt embed) when media exists under an Eagle-convention name", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const attachFolder = "Bookmarks/X/twitter-789";
    // Eagle import already stored the video as media.mp4 — a resync must NOT
    // download a second copy as video.mp4.
    fakeVault.files.set(`${attachFolder}/media.mp4`, "[existing eagle video]");

    const md = makeMediaDownloader(fakeVault);
    const downloadFn = vi.fn(async () => { throw new Error("should not be called"); });

    const result = await md.downloadAndSave(downloadFn, attachFolder, "video.mp4", true, ["media.mp4", "media.mov"]);

    expect(result).toBe(`![[${attachFolder}/media.mp4]]`);
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it("altNames absent → still downloads when only the alt would have matched but skipIfExists off", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const attachFolder = "Bookmarks/X/twitter-790";
    fakeVault.files.set(`${attachFolder}/media.mp4`, "[existing]");

    const md = makeMediaDownloader(fakeVault);
    const downloadFn = vi.fn(async () => new TextEncoder().encode("data").buffer);

    // skipIfExists=false → altNames are ignored, download proceeds.
    const result = await md.downloadAndSave(downloadFn, attachFolder, "video.mp4", false, ["media.mp4"]);

    expect(result).toBe(`![[${attachFolder}/video.mp4]]`);
    expect(downloadFn).toHaveBeenCalled();
  });

  it("stop-signal abort: returns null without calling downloadFn when stopped", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const attachFolder = "Bookmarks/X/twitter-456";
    const md = makeMediaDownloader(fakeVault);

    md.setStopSignal({ stopped: true });
    const downloadFn = vi.fn(async () => { throw new Error("should not be called"); });

    const result = await md.downloadAndSave(downloadFn, attachFolder, "video.mp4");

    expect(result).toBeNull();
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it("downloads and saves: calls createBinary and returns embed string", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const attachFolder = "Bookmarks/X/twitter-789";
    const md = makeMediaDownloader(fakeVault);

    const fakeData = new ArrayBuffer(8);
    const downloadFn = vi.fn(async () => fakeData);

    const result = await md.downloadAndSave(downloadFn, attachFolder, "photo.jpg");

    expect(result).toBe(`![[${attachFolder}/photo.jpg]]`);
    expect(fakeVault.binaryFiles.has(`${attachFolder}/photo.jpg`)).toBe(true);
    expect(downloadFn).toHaveBeenCalledOnce();
  });

  it("null download: returns null and does not call createBinary", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const attachFolder = "Bookmarks/X/twitter-000";
    const md = makeMediaDownloader(fakeVault);

    const downloadFn = vi.fn(async (): Promise<ArrayBuffer | null> => null);

    const result = await md.downloadAndSave(downloadFn, attachFolder, "photo.jpg");

    expect(result).toBeNull();
    expect(fakeVault.binaryFiles.size).toBe(0);
    expect(downloadFn).toHaveBeenCalledOnce();
  });
});

describe("MediaDownloader.quarantineLegacyCarousel", () => {
  it("no-op on missing folder: returns empty array, does not throw", async () => {
    const fakeVault = makeFakeVaultWithBinary();
    const md = makeMediaDownloader(fakeVault);

    // Path that has no folder in the vault — should not throw, returns []
    await expect(
      md.quarantineLegacyCarousel("Bookmarks/X/nonexistent-folder")
    ).resolves.toEqual([]);
  });
});
