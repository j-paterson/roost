// @vitest-environment node
/**
 * Embedding-cache durability: a flaky/interrupted write or a truncated file must
 * never silently discard hours of embedding (and the even more expensive
 * vision/topic LLM) work.
 *
 * Covers:
 *   1. round-trip save → load preserves vecs + text
 *   2. a truncated .bin salvages the complete-vector prefix and keeps every
 *      entry's text fields (no all-or-nothing wipe)
 *   3. a missing .bin still loads the text cache (vec == null, not {})
 *   4. atomic writes leave no *.tmp sibling behind
 *   5. embedding-meta.json records the vector dim
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter } from "obsidian";
import type { Vault } from "obsidian";
import type { EmbeddingCacheEntry } from "@/types/roost";
import {
  saveEmbeddingCache,
  loadEmbeddingCache,
  __resetEmbeddingCache,
} from "@/pipeline/shared";

const VEC_DIM = 768;

/** Minimal fake vault whose vaultBasePath() resolves to a temp dir.
 *  vaultBasePath() (lib/vault-utils) only needs `vault.adapter` to be a
 *  FileSystemAdapter whose getBasePath() returns the root. */
function fakeVault(baseDir: string): Vault {
  const adapter = new FileSystemAdapter();
  adapter.basePath = baseDir;
  return { adapter } as unknown as Vault;
}

/** Cache files live under <vaultRoot>/.roost/cache/ (see lib/roost-paths). */
function cacheFile(baseDir: string, name: string): string {
  return path.join(baseDir, ".roost", "cache", name);
}

function makeVec(seed: number): number[] {
  const v = new Array(VEC_DIM);
  for (let i = 0; i < VEC_DIM; i++) v[i] = (seed + i) * 0.001;
  return v;
}

function entry(seed: number): EmbeddingCacheEntry {
  return {
    vision: `vision-${seed}`,
    summary: `summary-${seed}`,
    category: `category-${seed}`,
    vec: makeVec(seed),
  };
}

describe("embedding-cache durability", () => {
  let tmp: string;
  let vault: Vault;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-embed-"));
    vault = fakeVault(tmp);
    __resetEmbeddingCache();
  });

  afterEach(() => {
    __resetEmbeddingCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips vectors and text (Fix 1)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      "tiktok:1": entry(1),
      "tiktok:2": entry(2),
    };
    saveEmbeddingCache(vault, cache);
    __resetEmbeddingCache();

    const loaded = loadEmbeddingCache(vault);
    expect(Object.keys(loaded).sort()).toEqual(["tiktok:1", "tiktok:2"]);
    for (const key of ["tiktok:1", "tiktok:2"]) {
      expect(loaded[key].vec).not.toBeNull();
      expect(loaded[key].vec!.length).toBe(VEC_DIM);
      expect(loaded[key].vision).toBe(cache[key].vision);
      expect(loaded[key].summary).toBe(cache[key].summary);
      expect(loaded[key].category).toBe(cache[key].category);
    }
    // The first float should round-trip through Float32.
    expect(loaded["tiktok:1"].vec![0]).toBeCloseTo(cache["tiktok:1"].vec![0], 5);
  });

  it("salvages the complete-vector prefix from a truncated bin and keeps all text (Fix 3 + Fix 2)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      "tiktok:1": entry(1),
      "tiktok:2": entry(2),
      "tiktok:3": entry(3),
    };
    saveEmbeddingCache(vault, cache);

    // Drop 1000 bytes off the end — partially eats the last vector (which is
    // 768*4 = 3072 bytes), so the third key's vector is no longer complete.
    const binPath = cacheFile(tmp, "embedding-vectors.bin");
    const sizeBefore = fs.statSync(binPath).size;
    fs.truncateSync(binPath, sizeBefore - 1000);

    __resetEmbeddingCache();
    const loaded = loadEmbeddingCache(vault);

    // Cache is NOT empty — the partial wipe of one vector did not nuke the cache.
    expect(Object.keys(loaded).sort()).toEqual(["tiktok:1", "tiktok:2", "tiktok:3"]);

    // The complete-prefix survivors keep their vectors (keys are written in order).
    expect(loaded["tiktok:1"].vec).not.toBeNull();
    expect(loaded["tiktok:1"].vec!.length).toBe(VEC_DIM);
    expect(loaded["tiktok:2"].vec).not.toBeNull();
    expect(loaded["tiktok:2"].vec!.length).toBe(VEC_DIM);

    // The truncated one has no vector — but STILL carries its text fields.
    expect(loaded["tiktok:3"].vec).toBeNull();
    expect(loaded["tiktok:3"].vision).toBe("vision-3");
    expect(loaded["tiktok:3"].summary).toBe("summary-3");
    expect(loaded["tiktok:3"].category).toBe("category-3");
  });

  it("preserves the text cache when the bin is missing (Fix 2)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      "tiktok:1": entry(1),
      "tiktok:2": entry(2),
    };
    saveEmbeddingCache(vault, cache);

    fs.rmSync(cacheFile(tmp, "embedding-vectors.bin"));

    __resetEmbeddingCache();
    const loaded = loadEmbeddingCache(vault);

    // Not {} — the expensive vision/topic work survives a missing/destroyed bin.
    expect(Object.keys(loaded).sort()).toEqual(["tiktok:1", "tiktok:2"]);
    for (const key of ["tiktok:1", "tiktok:2"]) {
      expect(loaded[key].vec).toBeNull();
      expect(loaded[key].vision).toBe(cache[key].vision);
      expect(loaded[key].summary).toBe(cache[key].summary);
      expect(loaded[key].category).toBe(cache[key].category);
    }
  });

  it("leaves no .tmp sibling after an atomic save (Fix 1)", () => {
    saveEmbeddingCache(vault, { "tiktok:1": entry(1) });
    const dir = path.join(tmp, ".roost", "cache");
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(cacheFile(tmp, "embedding-vectors.bin.tmp"))).toBe(false);
    expect(fs.existsSync(cacheFile(tmp, "embedding-cache.json.tmp"))).toBe(false);
  });

  it("writes embedding-meta.json with the vector dim (Fix 4)", () => {
    saveEmbeddingCache(vault, { "tiktok:1": entry(1) });
    const metaPath = cacheFile(tmp, "embedding-meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    expect(meta).toEqual({ dim: VEC_DIM });
  });
});
