import * as fs from "fs";
import * as path from "path";
import type { Vault } from "obsidian";
import { vaultBasePath } from "@/lib/vault-utils";
import { cachePath as roostCachePath, cacheDir } from "@/lib/roost-paths";

/** Current embed model version. Bump if the embedding model changes. */
const EMBED_MODEL_VERSION = 1;

export interface AnchorNameEmbeddingEntry {
  vec: number[];
  modelVersion: number;
}

export type AnchorNameEmbeddingCache = Record<string, AnchorNameEmbeddingEntry>;

function cachePath(vault: Vault): string {
  return roostCachePath(vaultBasePath(vault), "anchor-name-embeddings.json");
}

export function loadAnchorNameEmbeddings(vault: Vault): AnchorNameEmbeddingCache {
  try {
    const p = cachePath(vault);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function saveAnchorNameEmbeddings(vault: Vault, cache: AnchorNameEmbeddingCache): void {
  const p = cachePath(vault);
  const dir = cacheDir(vaultBasePath(vault));
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache));
  } catch (e: unknown) {
    console.warn("[roost] Failed to save anchor-name-embeddings:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Lookup a name vector. Case-insensitive. Returns null when the name is
 * absent OR when the cached entry's modelVersion doesn't match the
 * requested version (default = current model).
 */
export function lookupAnchorNameVec(
  cache: AnchorNameEmbeddingCache,
  name: string,
  expectedModelVersion: number = EMBED_MODEL_VERSION,
): number[] | null {
  const entry = cache[name.toLowerCase()];
  if (!entry) return null;
  if (entry.modelVersion !== expectedModelVersion) return null;
  return entry.vec;
}

/**
 * Fill in missing entries in `cache` for the given names. Names already
 * present (case-insensitive, matching modelVersion) are skipped — no
 * embed calls. Names absent are embedded via `embed(texts)` in a single
 * batched call. Returns a NEW merged cache; does not mutate input.
 *
 * Throws if the embed call throws — caller decides whether to fall back
 * to pure-item centroids.
 */
export async function fillMissingAnchorNames(
  names: string[],
  cache: AnchorNameEmbeddingCache,
  embed: (texts: string[]) => Promise<number[][]>,
  modelVersion: number = EMBED_MODEL_VERSION,
): Promise<AnchorNameEmbeddingCache> {
  const missing: string[] = [];
  const seenLower = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    const entry = cache[lower];
    if (entry && entry.modelVersion === modelVersion) continue;
    missing.push(name);
  }
  if (missing.length === 0) return cache;

  const vectors = await embed(missing);
  const merged: AnchorNameEmbeddingCache = { ...cache };
  for (let i = 0; i < missing.length; i++) {
    merged[missing[i].toLowerCase()] = { vec: vectors[i], modelVersion };
  }
  return merged;
}
