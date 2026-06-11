/**
 * In-memory fake vault for VaultWriter characterization tests.
 *
 * Backed by a Map<path, content> so tests can inspect written content directly.
 * Only the methods called by VaultWriter's hermetic (generic-record) paths are
 * implemented. File objects are plain objects — instanceof TFile is NOT required
 * by the write paths under test.
 */
import { TFile } from "obsidian";

export interface FakeFile {
  path: string;
  name: string;
  extension: "md";
}

export interface FakeVault {
  /** All files keyed by their vault-relative path. */
  files: Map<string, string>;
  /** The Obsidian Vault-like object to pass to VaultWriter. */
  vault: FakVaultObj;
}

/** Minimal shape that satisfies every VaultWriter call reachable from the
 *  hermetic (generic / no-twitter / no-tiktok) test paths. */
export interface FakVaultObj {
  files: Map<string, string>;
  create(path: string, content: string): Promise<void>;
  modify(file: FakeFile, content: string): Promise<void>;
  read(file: FakeFile): Promise<string>;
  cachedRead(file: FakeFile): Promise<string>;
  getAbstractFileByPath(path: string): FakeFile | null;
  getMarkdownFiles(): FakeFile[];
  createFolder(path: string): Promise<void>;
  adapter: { write(path: string, content: string): Promise<void> };
}

function makeFile(path: string): FakeFile {
  const parts = path.split("/");
  const basename = parts[parts.length - 1];
  return Object.assign(Object.create(TFile.prototype) as object, {
    path,
    name: basename,
    extension: "md" as const,
  }) as FakeFile;
}

/**
 * Create an empty in-memory fake vault.
 * Call `seedNote(path, content)` on the returned vault to pre-populate files.
 */
export function makeFakeVault(): FakeVault & { seedNote(path: string, content: string): void } {
  const files = new Map<string, string>();

  const vault: FakVaultObj = {
    files,

    async create(path: string, content: string): Promise<void> {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      files.set(path, content);
    },

    async modify(file: FakeFile, content: string): Promise<void> {
      files.set(file.path, content);
    },

    async read(file: FakeFile): Promise<string> {
      const c = files.get(file.path);
      if (c === undefined) throw new Error(`File not found: ${file.path}`);
      return c;
    },

    async cachedRead(file: FakeFile): Promise<string> {
      const c = files.get(file.path);
      if (c === undefined) throw new Error(`File not found: ${file.path}`);
      return c;
    },

    getAbstractFileByPath(path: string): FakeFile | null {
      // Exact match — a file exists at this path
      if (files.has(path)) return makeFile(path);
      // Folder existence check — return a non-null object if any stored file
      // is a descendant of this path (simulates Obsidian folder entries).
      const prefix = path.endsWith("/") ? path : path + "/";
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return makeFile(path);
      }
      return null;
    },

    getMarkdownFiles(): FakeFile[] {
      return [...files.keys()]
        .filter(p => p.endsWith(".md"))
        .map(makeFile);
    },

    async createFolder(_path: string): Promise<void> {
      // Folders are implicit in our map-backed implementation.
    },

    adapter: {
      async write(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
    },
  };

  function seedNote(path: string, content: string): void {
    files.set(path, content);
  }

  return { files, vault, seedNote };
}
