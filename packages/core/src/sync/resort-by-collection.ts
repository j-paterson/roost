import type { App, TFile } from "obsidian";
import { getSyncFiles } from "@/lib/vault-utils";
import { resolveCollectionAlias, type CollectionAliasMap } from "@/lib/collection-aliases";

const EMPTY = new Set(["", "undefined", "null"]);

/** Decide the frontmatter patch to physically reflect an item's collection→category
 * mapping in roost_category. Returns null to skip (no collection, or already correct).
 * Pure. `fm` is the note's frontmatter; `aliases` is the loaded alias map. */
export function resortPatch(
  fm: Record<string, unknown>,
  aliases: CollectionAliasMap,
): { roost_category: string; roost_assigned_by: "human"; roost_subcategory?: null } | null {
  const collection = (fm.collection as string | undefined)?.trim();
  if (!collection || EMPTY.has(collection)) return null; // nothing to resort by
  const platform = (fm.platform as string | undefined) ?? "";
  const target = resolveCollectionAlias(aliases, platform, collection) ?? collection;
  // Idempotent: skip if already resolved to target by a human.
  if (fm.roost_category === target && fm.roost_assigned_by === "human") return null;
  const patch: { roost_category: string; roost_assigned_by: "human"; roost_subcategory?: null } = {
    roost_category: target,
    roost_assigned_by: "human",
  };
  // A subcategory is a child of a specific category. When the resort MOVES the note to
  // a different category, any subcategory assigned under the OLD category is orphaned —
  // clear it so a stale subcategory isn't stranded under the new category. (When the
  // category is unchanged and only provenance flips, the subcategory is still valid.)
  if (fm.roost_category !== target && fm.roost_subcategory != null) {
    patch.roost_subcategory = null;
  }
  return patch;
}

export interface ResortResult {
  changed: number;
  already: number;
  byTarget: Record<string, number>;
}

/** Walk synced notes and reflect each collection→category mapping into roost_category.
 * dryRun=true computes counts WITHOUT writing. Progress-logged (cloud-vault writes slow). */
export async function resortByCollection(
  app: App,
  syncFolder: string,
  aliases: CollectionAliasMap,
  opts: { dryRun: boolean },
  log: (m: string) => void = () => {},
): Promise<ResortResult> {
  let changed = 0, already = 0;
  const byTarget: Record<string, number> = {};
  const files = getSyncFiles(app.vault, syncFolder);
  log(`${opts.dryRun ? "[dry-run] " : ""}scanning ${files.length} notes...`);
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file as TFile)?.frontmatter;
    if (!fm) continue;
    const patch = resortPatch(fm, aliases);
    if (!patch) {
      if ((fm.collection as string | undefined)?.trim()) already++;
      continue;
    }
    byTarget[patch.roost_category] = (byTarget[patch.roost_category] ?? 0) + 1;
    changed++;
    if (!opts.dryRun) {
      await app.fileManager.processFrontMatter(file as TFile, (front) => {
        front.roost_category = patch.roost_category;
        front.roost_assigned_by = patch.roost_assigned_by;
        if (patch.roost_subcategory === null) delete front.roost_subcategory;
      });
      if (changed % 200 === 0) log(`  ...wrote ${changed} so far`);
    }
  }
  const top = Object.entries(byTarget)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  log(
    `${opts.dryRun ? "[dry-run] would resort" : "resorted"} ${changed} items into ${Object.keys(byTarget).length} categories (${already} already correct). Top: ${top}`,
  );
  return { changed, already, byTarget };
}
