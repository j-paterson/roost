/**
 * Unit tests for the data-safety quarantine/restore/drop contract on
 * MediaDownloader (replaces the eagerly-destructive clearLegacyCarousel).
 *
 * The hazard: when a tweet first gains thread data, the resync path used to
 * DELETE the existing numbered carousel BEFORE downloading the replacement. A
 * dead-CDN render then left the user with nothing. quarantineLegacyCarousel
 * renames (instead of deleting) to `.roostbak` siblings; the caller drops them
 * on a confirmed render or restores them on failure. These tests pin that
 * non-destructive round-trip.
 *
 * Why a hand-rolled vault: the shared fake-vault (`./fake-vault`) and the
 * obsidian stub (`@/__mocks__/obsidian`) do not model `TFolder.children`,
 * `vault.rename`, or `vault.delete` against a mutable file set — they only
 * cover the missing-folder early-return. The quarantine contract needs a folder
 * with real `instanceof TFile` children plus working rename/delete, so we inject
 * a minimal fake implementing exactly getAbstractFileByPath/rename/delete and a
 * TFolder.children list. The fakes use the obsidian-stub TFile/TFolder
 * prototypes so the production `instanceof` guards behave as in Obsidian.
 */
import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import { MediaDownloader, type QuarantinedFile } from "../vault-writer/media-downloader";
import { type VaultIndex } from "../vault-writer/vault-index";
import { type NoteFileWriter } from "../vault-writer/note-file-writer";

// ── Hand-rolled vault with folder/children + rename/delete ────────────────────

interface FakeTFile { path: string; name: string; }
interface FakeTFolder { path: string; name: string; children: FakeTFile[]; }

function makeFile(path: string): FakeTFile {
  const name = path.split("/").pop()!;
  return Object.assign(Object.create(TFile.prototype) as object, { path, name }) as FakeTFile;
}
function makeFolder(path: string, childNames: string[]): FakeTFolder {
  const name = path.split("/").pop()!;
  const children = childNames.map(n => makeFile(`${path}/${n}`));
  return Object.assign(Object.create(TFolder.prototype) as object, { path, name, children }) as FakeTFolder;
}

/**
 * Build a fake vault around a single attach folder containing `fileNames`.
 * Tracks files in a Map<path, true> so rename/delete are observable, and keeps
 * the folder's `children` array in sync so a second quarantine pass sees the
 * post-rename state.
 */
function makeQuarantineVault(attachFolder: string, fileNames: string[]) {
  const folder = makeFolder(attachFolder, fileNames);
  const present = new Set<string>(folder.children.map(c => c.path));

  const vault = {
    getAbstractFileByPath(path: string): unknown {
      if (path === attachFolder) return folder;
      if (present.has(path)) return makeFile(path);
      return null;
    },
    async rename(file: FakeTFile, newPath: string): Promise<void> {
      if (!present.has(file.path)) throw new Error(`rename: missing ${file.path}`);
      if (present.has(newPath)) throw new Error(`rename: target exists ${newPath}`);
      present.delete(file.path);
      present.add(newPath);
      // Keep the folder.children view consistent for any subsequent scan.
      const child = folder.children.find(c => c.path === file.path);
      if (child) { child.path = newPath; child.name = newPath.split("/").pop()!; }
    },
    async delete(file: FakeTFile): Promise<void> {
      present.delete(file.path);
      folder.children = folder.children.filter(c => c.path !== file.path);
    },
  };

  return { vault, present, folder };
}

function makeMediaDownloader(vault: unknown): MediaDownloader {
  return new MediaDownloader({
    vault: vault as any,
    log: () => {},
    index: { notePathMap: new Map() } as unknown as VaultIndex,
    noteWriter: {} as unknown as NoteFileWriter,
    ensuredFolders: new Set<string>(),
  });
}

const ATTACH = "Bookmarks/X/twitter-123";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MediaDownloader.quarantineLegacyCarousel", () => {
  it("renames numbered carousel + card.png to .roostbak, leaves other files alone", async () => {
    const { vault, present } = makeQuarantineVault(ATTACH, [
      "1.jpg", "2.jpg", "card.png", "raw.json", "thread.json", "cover.webp",
    ]);
    const md = makeMediaDownloader(vault);

    const result = await md.quarantineLegacyCarousel(ATTACH);

    // Victims are exactly the carousel images + card.png.
    expect(result.map(r => r.original).sort()).toEqual([
      `${ATTACH}/1.jpg`, `${ATTACH}/2.jpg`, `${ATTACH}/card.png`,
    ]);
    expect(result.every(r => r.quarantined === `${r.original}.roostbak`)).toBe(true);

    // Originals gone, .roostbak siblings present.
    expect(present.has(`${ATTACH}/1.jpg`)).toBe(false);
    expect(present.has(`${ATTACH}/2.jpg`)).toBe(false);
    expect(present.has(`${ATTACH}/card.png`)).toBe(false);
    expect(present.has(`${ATTACH}/1.jpg.roostbak`)).toBe(true);
    expect(present.has(`${ATTACH}/2.jpg.roostbak`)).toBe(true);
    expect(present.has(`${ATTACH}/card.png.roostbak`)).toBe(true);

    // Non-matching files are untouched.
    expect(present.has(`${ATTACH}/raw.json`)).toBe(true);
    expect(present.has(`${ATTACH}/thread.json`)).toBe(true);
    expect(present.has(`${ATTACH}/cover.webp`)).toBe(true);
  });

  it("returns [] for a missing folder", async () => {
    const { vault } = makeQuarantineVault(ATTACH, ["1.jpg"]);
    const md = makeMediaDownloader(vault);
    await expect(md.quarantineLegacyCarousel("Bookmarks/X/does-not-exist")).resolves.toEqual([]);
  });

  it("removes a stale .roostbak from a prior interrupted run before re-quarantining", async () => {
    const { vault, present } = makeQuarantineVault(ATTACH, ["1.jpg", "1.jpg.roostbak"]);
    const md = makeMediaDownloader(vault);

    const result = await md.quarantineLegacyCarousel(ATTACH);

    // Only 1.jpg is a victim (1.jpg.roostbak does not match the carousel glob).
    expect(result.map(r => r.original)).toEqual([`${ATTACH}/1.jpg`]);
    // The fresh quarantine target exists; no duplicate/throw from the stale one.
    expect(present.has(`${ATTACH}/1.jpg.roostbak`)).toBe(true);
    expect(present.has(`${ATTACH}/1.jpg`)).toBe(false);
  });
});

describe("MediaDownloader.restoreQuarantine", () => {
  it("renames .roostbak back to the original name when it is free", async () => {
    const { vault, present } = makeQuarantineVault(ATTACH, ["1.jpg", "card.png"]);
    const md = makeMediaDownloader(vault);

    const quarantined = await md.quarantineLegacyCarousel(ATTACH);
    expect(present.has(`${ATTACH}/1.jpg`)).toBe(false);

    await md.restoreQuarantine(quarantined);

    expect(present.has(`${ATTACH}/1.jpg`)).toBe(true);
    expect(present.has(`${ATTACH}/card.png`)).toBe(true);
    expect(present.has(`${ATTACH}/1.jpg.roostbak`)).toBe(false);
    expect(present.has(`${ATTACH}/card.png.roostbak`)).toBe(false);
  });

  it("drops the .roostbak (does not clobber) when a new file already owns the original name", async () => {
    const { vault, present } = makeQuarantineVault(ATTACH, ["1.jpg"]);
    const md = makeMediaDownloader(vault);

    const quarantined = await md.quarantineLegacyCarousel(ATTACH);
    // Simulate the new carousel render having created a fresh 1.jpg.
    present.add(`${ATTACH}/1.jpg`);

    await md.restoreQuarantine(quarantined);

    // The fresh file survives; the stale backup is gone.
    expect(present.has(`${ATTACH}/1.jpg`)).toBe(true);
    expect(present.has(`${ATTACH}/1.jpg.roostbak`)).toBe(false);
  });
});

describe("MediaDownloader.dropQuarantine", () => {
  it("permanently deletes the .roostbak files", async () => {
    const { vault, present } = makeQuarantineVault(ATTACH, ["1.jpg", "2.jpg"]);
    const md = makeMediaDownloader(vault);

    const quarantined = await md.quarantineLegacyCarousel(ATTACH);
    await md.dropQuarantine(quarantined);

    expect(present.has(`${ATTACH}/1.jpg.roostbak`)).toBe(false);
    expect(present.has(`${ATTACH}/2.jpg.roostbak`)).toBe(false);
    // Originals stay gone (the new carousel owns those names in production).
    expect(present.has(`${ATTACH}/1.jpg`)).toBe(false);
    expect(present.has(`${ATTACH}/2.jpg`)).toBe(false);
  });
});

describe("quarantine round-trip (data-loss-prevention invariant)", () => {
  it("quarantine → restore yields the original names back, byte-for-byte set-equal", async () => {
    const originals = ["1.jpg", "2.jpg", "3.jpg", "card.png"];
    const { vault, present } = makeQuarantineVault(ATTACH, originals);
    const md = makeMediaDownloader(vault);

    const before = new Set([...present]);
    const quarantined: QuarantinedFile[] = await md.quarantineLegacyCarousel(ATTACH);

    // Mid-flight: originals are quarantined, none of the .roostbak share a name
    // with the media globs the downloader would later write.
    expect(quarantined).toHaveLength(4);

    await md.restoreQuarantine(quarantined);

    const after = new Set([...present]);
    expect(after).toEqual(before);
    for (const n of originals) expect(after.has(`${ATTACH}/${n}`)).toBe(true);
    // No quarantine residue left behind.
    expect([...after].some(p => p.endsWith(".roostbak"))).toBe(false);
  });
});
