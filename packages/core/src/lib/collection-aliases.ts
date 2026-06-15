/**
 * Collection alias map — maps a source collection key (e.g. "tiktok:Finance Tips")
 * to a user-curated local category name (e.g. "Finances").
 *
 * Persisted at .roost/cache/collection-aliases.json via loadPipelineCache /
 * savePipelineCache (the established vault-side JSON cache pattern).
 */
import type { Vault } from "obsidian";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";

export type CollectionAliasMap = Record<string, string>;

const ALIASES_FILE = "collection-aliases.json";

/** Build the canonical alias key for a platform + collection name. */
export function makeAliasKey(platform: string, collectionName: string): string {
  return `${platform}:${collectionName}`;
}

/**
 * Resolve a source collection name to a local category via the alias map.
 * Returns undefined when map/collectionName is null/empty or no entry exists.
 */
export function resolveCollectionAlias(
  map: CollectionAliasMap | null | undefined,
  platform: string,
  collectionName: string | null | undefined,
): string | undefined {
  if (!map || !collectionName) return undefined;
  return map[makeAliasKey(platform, collectionName)] ?? undefined;
}

/** Load the alias map from vault cache. Returns empty record on missing file. */
export function loadCollectionAliases(vault: Vault): CollectionAliasMap {
  return loadPipelineCache<string>(vault, ALIASES_FILE) as CollectionAliasMap;
}

/** Persist the alias map to vault cache. */
export function saveCollectionAliases(vault: Vault, map: CollectionAliasMap): void {
  savePipelineCache<string>(vault, ALIASES_FILE, map);
}
