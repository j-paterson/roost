import type { App } from "obsidian";
import type { RoostFilter, SmartAssignInput, EmbeddingCacheEntry } from "@/types/roost";
import { gatherVaultCollections, gatherCategoryAndSubcategories, matchesFilter } from "@/lib/vault-utils";
import { loadEmbeddingCache } from "@/pipeline/shared";
import { aggregateSuggestedTopics } from "@/ui/lib/suggested-topics";

/**
 * Build SmartAssignInput for a filter-scoped run (the Smart Assign button).
 * - itemIds: files matching the sidebar filter
 * - collections: all vault collections
 * - topics: all vault category names
 * - write: category field
 * - allowDiscovery: true
 */
export function buildFilterInput(
  app: App,
  syncFolder: string,
  filter: RoostFilter,
): SmartAssignInput {
  const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith(syncFolder + "/"));
  const itemIds: string[] = [];
  const itemProvenance = new Map<string, "human" | "auto">();
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.roost_id) continue;
    if (!matchesFilter(fm, filter)) continue;
    itemIds.push(fm.roost_id as string);
    itemProvenance.set(fm.roost_id as string, fm.roost_assigned_by === "human" ? "human" : "auto");
  }
  const vault = gatherVaultCollections(app, syncFolder);
  return {
    itemIds,
    collections: vault.collections,
    topics: Object.keys(vault.collections),
    itemProvenance,
    write: { into: "category" },
    allowDiscovery: true,
  };
}

/**
 * Build SmartAssignInput for a resort-scoped run (right-click "Resort").
 * - itemIds: every item currently in the category
 * - collections: all vault collections (resort can move items anywhere)
 * - topics: all vault category names
 * - write: category field
 * - allowDiscovery: true
 */
export function buildResortInput(
  app: App,
  syncFolder: string,
  categoryName: string,
): SmartAssignInput {
  const scoped = gatherCategoryAndSubcategories(app, syncFolder, categoryName);
  const vault = gatherVaultCollections(app, syncFolder);
  const targetIdSet = new Set(scoped.itemIds);
  // Remove target items from collections so they're treated as unsorted
  // (scored against all categories) rather than as labeled anchor members.
  const collections: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(vault.collections)) {
    const filtered = ids.filter(id => !targetIdSet.has(id));
    if (filtered.length > 0 || name !== categoryName) {
      collections[name] = filtered;
    }
  }
  return {
    itemIds: scoped.itemIds,
    collections,
    topics: Object.keys(vault.collections),
    itemProvenance: scoped.itemProvenance,
    write: { into: "category" },
    allowDiscovery: true,
  };
}

export interface BuildSubcategorizeOpts {
  /** Embedding cache override — for tests. Defaults to loading from disk. */
  embeddingCache?: Record<string, EmbeddingCacheEntry>;
  /** Suggestion minCount override — for tests. Default 5. */
  minCount?: number;
  /** Suggestion topN override — for tests. Default 15. */
  topN?: number;
}

/**
 * Build SmartAssignInput for a subcategorize-scoped run (right-click "Sort into subcategories").
 * - itemIds: every item currently in the category
 * - collections: parent's existing subcategories (frontmatter) PLUS user-defined
 *   empty subcategories (from settings) as zero-item anchors
 * - topics: same set of subcategory names — single source of truth
 * - suggestedTopics: ranked candidate names from item LLM categories
 * - write: subcategoryOf parent
 * - allowDiscovery: false (unmatched items stay in parent without subcategory)
 */
export function buildSubcategorizeInput(
  app: App,
  syncFolder: string,
  categoryName: string,
  emptySubcats: string[] = [],
  opts: BuildSubcategorizeOpts = {},
): SmartAssignInput {
  const scoped = gatherCategoryAndSubcategories(app, syncFolder, categoryName);
  const collections: Record<string, string[]> = { ...scoped.collections };
  for (const name of emptySubcats) {
    if (!collections[name]) collections[name] = [];
  }
  const topics = Object.keys(collections);

  const cache = opts.embeddingCache ?? loadEmbeddingCache(app.vault);
  const suggestedTopics = aggregateSuggestedTopics(scoped.itemIds, cache, {
    minCount: opts.minCount ?? 5,
    topN: opts.topN ?? 15,
    existingTopics: topics,
  });

  return {
    itemIds: scoped.itemIds,
    collections,
    topics,
    itemProvenance: scoped.itemProvenance,
    write: { into: "subcategoryOf", parent: categoryName },
    allowDiscovery: false,
    suggestedTopics,
  };
}
