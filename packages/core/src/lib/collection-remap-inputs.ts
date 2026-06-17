import type { App, Vault, TFile } from "obsidian";
import { gatherVaultCollections, getSyncFiles } from "@/lib/vault-utils";
import { loadCollectionAliases } from "@/lib/collection-aliases";
import { loadEmbeddingCache } from "@/pipeline/shared";
import {
  buildCategoryCentroids,
  type CollectionInput,
  type CategoryCentroid,
} from "@/lib/collection-remap";

export interface SourceCollection {
  platform: string;
  name: string;
  memberIds: string[];
}

/** Raw source collections grouped by (platform, `collection` field) within the sync folder. */
export function gatherSourceCollections(app: App, syncFolder: string): SourceCollection[] {
  const order: string[] = [];
  const byKey = new Map<string, SourceCollection>();
  for (const file of getSyncFiles(app.vault as Vault, syncFolder)) {
    const fm = app.metadataCache.getFileCache(file as TFile)?.frontmatter;
    const id = fm?.roost_id as string | undefined;
    const platform = fm?.platform as string | undefined;
    const name = (fm?.collection as string | undefined)?.trim();
    if (!id || !platform || !name) continue;
    const key = `${platform}:${name}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { platform, name, memberIds: [] };
      byKey.set(key, entry);
      order.push(key);
    }
    entry.memberIds.push(id);
  }
  return order.map((k) => byKey.get(k)!);
}

/** Assemble everything the suggestion engine needs from the live vault. */
export function buildRemapInputs(
  app: App,
  syncFolder: string,
): { collections: CollectionInput[]; categories: CategoryCentroid[] } {
  const cache = loadEmbeddingCache(app.vault as Vault);
  // Pass aliases so already-mapped collections fold into their canonical category's
  // centroid (consistent with smart-assign-inputs). categoryGroups are keyed by
  // resolved category (roost_category > alias > collection), the correct match targets.
  const aliases = loadCollectionAliases(app.vault as Vault);
  const { collections: categoryGroups } = gatherVaultCollections(app, syncFolder, undefined, aliases);
  const categories = buildCategoryCentroids(
    categoryGroups,
    cache as Record<string, { vec: number[] | null }>,
  );
  const collections: CollectionInput[] = gatherSourceCollections(app, syncFolder).map((s) => ({
    platform: s.platform,
    name: s.name,
    memberVecs: s.memberIds
      .map((id) => cache[id]?.vec)
      .filter((v): v is number[] => Array.isArray(v)),
  }));
  return { collections, categories };
}
