/**
 * Pure helpers for Smart Assign clustering and scoring.
 */
import type { App } from "obsidian";
import * as path from "path";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import { getSyncFiles, vaultBasePath } from "@/lib/vault-utils";
import { buildCategoryDefs, type CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

export function vaultRoostDir(app: App): string {
  return path.join(vaultBasePath(app.vault), ".roost");
}

/**
 * Build subcatsByParent from vault frontmatter. For each (category, subcategory) pair
 * that has anchor items, build a CategoryDef using the existing buildCategoryDefs helper.
 */
export function buildSubcatsByParent(
  app: App,
  syncFolder: string,
  cache: Record<string, EmbeddingCacheEntry>,
  nameEmbeddings: Map<string, number[]>,
): Map<string, CategoryDef[]> {
  const files = getSyncFiles(app.vault, syncFolder);
  const itemsByParentSubcat: Map<string, Map<string, string[]>> = new Map();
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const cat = fm[CATEGORY_FIELD];
    const subcat = fm[SUBCATEGORY_FIELD];
    const itemId = fm.roost_id;
    if (!cat || !subcat || !itemId) continue;
    if (typeof cat !== "string" || typeof subcat !== "string" || typeof itemId !== "string") continue;
    let subcatMap = itemsByParentSubcat.get(cat);
    if (!subcatMap) { subcatMap = new Map(); itemsByParentSubcat.set(cat, subcatMap); }
    let bucket = subcatMap.get(subcat);
    if (!bucket) { bucket = []; subcatMap.set(subcat, bucket); }
    bucket.push(itemId);
  }
  const result = new Map<string, CategoryDef[]>();
  for (const [parent, subcatMap] of itemsByParentSubcat) {
    const collections: Record<string, string[]> = {};
    for (const [subcat, ids] of subcatMap) collections[subcat] = ids;
    const defs = buildCategoryDefs(collections, new Map(), cache, undefined, undefined, nameEmbeddings);
    if (defs.length > 0) result.set(parent, defs);
  }
  return result;
}
