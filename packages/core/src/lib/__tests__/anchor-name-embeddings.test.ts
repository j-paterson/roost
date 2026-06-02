// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadAnchorNameEmbeddings, saveAnchorNameEmbeddings, lookupAnchorNameVec } from "../anchor-name-embeddings";
import { fillMissingAnchorNames } from "../anchor-name-embeddings";
import { FileSystemAdapter } from "obsidian";
import type { Vault } from "obsidian";
import type { AnchorNameEmbeddingCache } from "../anchor-name-embeddings";

let tmpVaultRoot: string;

function makeVault(): Vault {
  const adapter = new FileSystemAdapter();
  adapter.basePath = tmpVaultRoot;
  return { adapter } as unknown as Vault;
}

describe("anchor-name-embeddings", () => {
  beforeEach(() => {
    tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-emb-"));
    fs.mkdirSync(path.join(tmpVaultRoot, ".roost", "cache"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
  });

  it("round-trips an empty cache as {}", () => {
    const v = makeVault();
    expect(loadAnchorNameEmbeddings(v)).toEqual({});
  });

  it("saves and reloads named vectors with lowercase keys", () => {
    const v = makeVault();
    saveAnchorNameEmbeddings(v, {
      "music": { vec: [0.1, 0.2], modelVersion: 1 },
      "anime": { vec: [0.3, 0.4], modelVersion: 1 },
    });
    const reloaded = loadAnchorNameEmbeddings(v);
    expect(Object.keys(reloaded).sort()).toEqual(["anime", "music"]);
    expect(reloaded["music"].vec).toEqual([0.1, 0.2]);
  });

  it("lookupAnchorNameVec is case-insensitive", () => {
    const cache = { "video game": { vec: [1, 2, 3], modelVersion: 1 } };
    expect(lookupAnchorNameVec(cache, "Video Game")).toEqual([1, 2, 3]);
    expect(lookupAnchorNameVec(cache, "VIDEO GAME")).toEqual([1, 2, 3]);
  });

  it("lookupAnchorNameVec returns null for unknown name", () => {
    const cache = { "music": { vec: [1, 2], modelVersion: 1 } };
    expect(lookupAnchorNameVec(cache, "Anime")).toBeNull();
  });

  it("lookupAnchorNameVec returns null when modelVersion mismatches", () => {
    const cache = { "music": { vec: [1, 2], modelVersion: 1 } };
    expect(lookupAnchorNameVec(cache, "Music", 2)).toBeNull();
  });
});

describe("fillMissingAnchorNames", () => {
  it("only embeds names not already in cache, returns merged map", async () => {
    const cache: AnchorNameEmbeddingCache = {
      "music": { vec: [1, 0], modelVersion: 1 },
    };
    const calls: string[] = [];
    const fakeEmbed = async (texts: string[]): Promise<number[][]> => {
      calls.push(...texts);
      return texts.map(() => [9, 9]);
    };
    const filled = await fillMissingAnchorNames(["Music", "Anime", "Movie"], cache, fakeEmbed);
    expect(calls.sort()).toEqual(["Anime", "Movie"]);
    expect(filled["music"]).toEqual({ vec: [1, 0], modelVersion: 1 });
    expect(filled["anime"]).toEqual({ vec: [9, 9], modelVersion: 1 });
    expect(filled["movie"]).toEqual({ vec: [9, 9], modelVersion: 1 });
  });

  it("returns the original cache unchanged if no names are missing", async () => {
    const cache: AnchorNameEmbeddingCache = {
      "music": { vec: [1, 0], modelVersion: 1 },
    };
    let called = false;
    const fakeEmbed = async () => { called = true; return []; };
    const filled = await fillMissingAnchorNames(["Music"], cache, fakeEmbed);
    expect(called).toBe(false);
    expect(filled).toEqual(cache);
  });

  it("propagates embed errors and leaves cache untouched on failure", async () => {
    const cache: AnchorNameEmbeddingCache = {};
    const fakeEmbed = async () => { throw new Error("sidecar down"); };
    await expect(fillMissingAnchorNames(["Music"], cache, fakeEmbed))
      .rejects.toThrow("sidecar down");
    expect(cache).toEqual({});
  });
});
