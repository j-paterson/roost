import { App, Vault, TFile, TFolder, FileSystemAdapter, type FrontMatterCache } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import * as path from "path";
import { cacheDir } from "@/lib/roost-paths";
import { loadEmbeddingCache, saveEmbeddingCache } from "@/pipeline/shared";
import { resolveCollectionAlias, type CollectionAliasMap } from "@/lib/collection-aliases";

/**
 * Return the absolute filesystem path for the vault root.
 * Uses FileSystemAdapter.getBasePath() — the public API.
 * Returns "" in environments where the adapter isn't a FileSystemAdapter
 * (e.g. mobile, unit tests with mock adapters).
 */
export function vaultBasePath(vault: Vault): string {
  if (vault.adapter instanceof FileSystemAdapter) {
    return vault.adapter.getBasePath();
  }
  return "";
}

/**
 * Return all markdown files inside the sync folder.
 */
export function getSyncFiles(vault: Vault, syncFolder: string): TFile[] {
  return vault.getMarkdownFiles().filter(f => f.path.startsWith(syncFolder + "/"));
}

/** Remove YAML frontmatter block from raw note text. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 3).trim();
}

/**
 * Walk all sync-folder markdown files and gather collection labels per item.
 *
 * Reader precedence: `roost_category` (Roost-managed) > `collection` (TikTok-native).
 * This matches the behavior of `scripts/test-health-gaps.py` and ensures Smart
 * Assign's own output is visible to the health audit.
 *
 * Returns unfiltered data — caller is responsible for applying any userTopics
 * or cache-presence filter.
 */
export type AssignedBy = "human" | "auto";

export function gatherVaultCollections(
  app: App,
  syncFolder: string,
  platform?: string,
  aliases?: CollectionAliasMap,
): {
  itemIds: string[];
  itemCollections: Map<string, string>;
  collections: Record<string, string[]>;
  /** Per-item provenance: "human" if manually assigned, "auto" (or absent) if machine-assigned. */
  itemProvenance: Map<string, AssignedBy>;
} {
  const files = app.vault.getMarkdownFiles().filter(f => {
    if (!f.path.startsWith(syncFolder + "/")) return false;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm?.roost_id) return false;
    if (platform && fm.platform !== platform) return false;
    return true;
  });

  const itemIds: string[] = [];
  const itemCollections = new Map<string, string>();
  const itemProvenance = new Map<string, AssignedBy>();

  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.roost_id) continue;
    const id = fm.roost_id as string;
    itemIds.push(id);
    const rawCollection = fm.collection as string | undefined;
    // Platform default "tiktok" is safe: alias keys are namespaced
    // (`tiktok:<name>`), and only TikTok sync stamps `collection`. Must match
    // the same default on the WRITE side in use-roost-category-tree's rename
    // capture so a key written on rename is found here on read.
    const resolved = resolveCollectionAlias(aliases, (fm.platform as string) ?? "tiktok", rawCollection);
    const raw = ((fm.roost_category ?? resolved ?? rawCollection) as string | undefined)?.trim();
    if (raw && raw !== "undefined" && raw !== "null") {
      itemCollections.set(id, raw);
      itemProvenance.set(id, fm.roost_assigned_by === "human" ? "human" : "auto");
    }
  }

  const collections: Record<string, string[]> = {};
  for (const [id, name] of itemCollections) {
    if (!collections[name]) collections[name] = [];
    collections[name].push(id);
  }

  return { itemIds, itemCollections, collections, itemProvenance };
}

/**
 * Build a Map from roost_id → TFile for all sync-folder files.
 */
export function buildFileIndex(app: App, syncFolder: string): Map<string, TFile> {
  const files = getSyncFiles(app.vault, syncFolder);
  const index = new Map<string, TFile>();
  for (const f of files) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (fm?.roost_id) index.set(fm.roost_id, f);
  }
  return index;
}

/**
 * Strip surrounding `[[` / `]]` from a wikilink string.
 */
export function stripWikilink(s: string): string {
  return s.replace(/^\[\[/, "").replace(/\]\]$/, "");
}

/**
 * Extract the `roost_id` value from note frontmatter content.
 * Returns null if not found.
 */
export function parseRoostId(content: string): string | null {
  const match = content.match(/^roost_id:\s*"?([^\n"]+)"?/m);
  return match ? match[1] : null;
}

/**
 * Return true if the frontmatter marks an item as "belongs to nothing" —
 * i.e., the user explicitly decided it should never be assigned a category.
 * Such items must be excluded from the unsorted candidate set (library-tree
 * unsorted count and Smart Assign gather) to prevent re-assignment loops.
 */
export function isBelongsNothingFm(fm: Record<string, unknown> | undefined | null): boolean {
  return !!fm && fm.roost_belongs_nothing === true;
}

/**
 * Check if a frontmatter object matches a category filter.
 * - filterCategory === undefined → match all
 * - filterCategory === null → match only unsorted (no roost_category)
 * - filterCategory === "Name" → match that specific category
 * - filterSubcategory → additionally require roost_subcategory match
 */
export function matchesCategoryFilter(
  fm: FrontMatterCache,
  filterCategory: string | null | undefined,
  filterSubcategory?: string,
): boolean {
  if (filterCategory === undefined) return true;
  const cat = fm[CATEGORY_FIELD];
  if (filterCategory === null) return !cat;
  if (cat !== filterCategory) return false;
  // Parent click (no subcategory filter) matches all items in this category
  if (!filterSubcategory) return true;
  // Subcategory filter: require exact match
  return fm[SUBCATEGORY_FIELD] === filterSubcategory;
}

/**
 * Check if a frontmatter object matches a combined platform + category filter.
 * Returns true if the item should be included.
 */
export function matchesFilter(
  fm: FrontMatterCache,
  filter: { platform?: string; category?: string | null; subcategory?: string } | null,
): boolean {
  if (!filter) return true;
  if (!fm?.roost_id) return false;
  if (filter.platform && fm.platform !== filter.platform) return false;
  if ("category" in filter && !matchesCategoryFilter(fm, filter.category, filter.subcategory)) return false;
  return true;
}

/** Encode a move target (category + optional subcategory) into a single string. */
const SUBCAT_SEP = "\x00";

export function encodeMoveTarget(category: string, subcategory?: string): string {
  return subcategory ? `${category}${SUBCAT_SEP}${subcategory}` : category;
}

export function decodeMoveTarget(target: string): { category: string; subcategory?: string } {
  const idx = target.indexOf(SUBCAT_SEP);
  if (idx === -1) return { category: target };
  return { category: target.slice(0, idx), subcategory: target.slice(idx + 1) };
}

/** Return indices of entries matching a predicate (shared by gallery + explorer filters). */
export function filterEntryIndices<T>(
  entries: T[],
  predicate: (entry: T, index: number) => boolean,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (predicate(entries[i], i)) indices.push(i);
  }
  return indices;
}

/**
 * Gather all items belonging to a specific top-level category, and group
 * them by existing subcategory. Used by Smart Assign's `subcategorize` scope.
 *
 * Returns:
 * - itemIds: every roost_id whose `roost_category` equals `categoryName`
 *   (regardless of whether it has a subcategory).
 * - collections: Record<subcategoryName, roost_id[]> — items grouped by
 *   their existing `roost_subcategory`. Items without a subcategory are
 *   not included in `collections` but ARE in `itemIds`.
 * - itemProvenance: "human" if the item's roost_assigned_by frontmatter
 *   is "human", else "auto". Mirrors gatherVaultCollections.
 */
export function gatherCategoryAndSubcategories(
  app: App,
  syncFolder: string,
  categoryName: string,
  aliases?: CollectionAliasMap,
): {
  itemIds: string[];
  collections: Record<string, string[]>;
  itemProvenance: Map<string, AssignedBy>;
} {
  const files = app.vault.getMarkdownFiles().filter(f =>
    f.path.startsWith(syncFolder + "/"),
  );

  const itemIds: string[] = [];
  const collections: Record<string, string[]> = {};
  const itemProvenance = new Map<string, AssignedBy>();

  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.roost_id) continue;
    const rawCollection = fm.collection as string | undefined;
    // See gatherVaultCollections: "tiktok" default is safe (namespaced keys)
    // and must mirror the rename-capture write side.
    const resolved = resolveCollectionAlias(aliases, (fm.platform as string) ?? "tiktok", rawCollection);
    const cat = ((fm[CATEGORY_FIELD] ?? resolved ?? rawCollection) as string | undefined)?.trim();
    if (!cat || cat === "undefined" || cat === "null") continue;
    if (cat !== categoryName) continue;
    const id = fm.roost_id as string;
    itemIds.push(id);
    itemProvenance.set(id, fm.roost_assigned_by === "human" ? "human" : "auto");
    const sub = (fm[SUBCATEGORY_FIELD] as string | undefined)?.trim();
    if (sub && sub !== "undefined" && sub !== "null") {
      if (!collections[sub]) collections[sub] = [];
      collections[sub].push(id);
    }
  }

  return { itemIds, collections, itemProvenance };
}

// ── Deleted-item tombstones ──
// Persisted in .roost/deleted-ids.json so deleted items aren't re-downloaded.

const DELETED_IDS_FILE = "deleted-ids.json";

let deletedIdsCache: Set<string> | null = null;

function roostDir(vault: Vault): string {
  return cacheDir(vaultBasePath(vault));
}

function deletedIdsPath(vault: Vault): string {
  return path.join(roostDir(vault), DELETED_IDS_FILE);
}

export function loadDeletedIds(vault: Vault): Set<string> {
  if (deletedIdsCache) return deletedIdsCache;
  const fs = require("fs");
  const filePath = deletedIdsPath(vault);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    deletedIdsCache = new Set(JSON.parse(raw));
  } catch {
    deletedIdsCache = new Set();
  }
  return deletedIdsCache;
}

function saveDeletedIds(vault: Vault): void {
  const fs = require("fs");
  const dir = roostDir(vault);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(deletedIdsPath(vault), JSON.stringify([...loadDeletedIds(vault)], null, 2));
}

function addDeletedId(vault: Vault, roostId: string): void {
  loadDeletedIds(vault).add(roostId);
  saveDeletedIds(vault);
}


/**
 * Delete a bookmark item: trash the note file + attachment folder,
 * remove from embedding cache, add to tombstone list.
 */
export async function deleteItem(
  app: App,
  vault: Vault,
  syncFolder: string,
  roostId: string,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  const fileIndex = buildFileIndex(app, syncFolder);
  const file = fileIndex.get(roostId);
  if (!file) {
    onLog?.(`[delete] note not found for ${roostId}`);
    return false;
  }

  // Find and trash the attachment folder (e.g. tiktok-7123456789/)
  const noteDir = file.path.replace(/\/[^/]+\.md$/, "");
  const [platform, itemId] = roostId.split(":", 2);
  const attachFolder = vault.getAbstractFileByPath(`${noteDir}/${platform}-${itemId}`);
  if (attachFolder instanceof TFolder) {
    await vault.trash(attachFolder, true);
  }

  // Trash the note file
  await vault.trash(file, true);

  // Add to tombstone list
  addDeletedId(vault, roostId);

  // Remove from embedding cache
  try {
    const cache = loadEmbeddingCache(vault);
    if (cache[roostId]) {
      delete cache[roostId];
      saveEmbeddingCache(vault, cache);
    }
  } catch { /* cache cleanup is best-effort */ }

  onLog?.(`[delete] trashed ${file.path} (${roostId})`);
  return true;
}
