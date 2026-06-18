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
): { roost_category: string; roost_assigned_by: "human"; roost_subcategory?: string | null } | null {
  const collection = (fm.collection as string | undefined)?.trim();
  if (!collection || EMPTY.has(collection)) return null; // nothing to resort by
  const platform = (fm.platform as string | undefined) ?? "";
  const target = resolveCollectionAlias(aliases, platform, collection) ?? collection;
  // Subcategory policy:
  //  - FOLD (collection folds into a different top-level): the fragment name becomes the
  //    subcategory (e.g. `web3` → Tech / web3).
  //  - IDENTITY + category moved here from elsewhere: clear the now-orphaned subcategory.
  //  - IDENTITY + unchanged: leave it (undefined) — the pipelines own Food/Recipes etc.
  const desiredSub: string | null | undefined =
    collection !== target ? collection
    : fm.roost_category !== target ? null
    : undefined;
  const curSub = typeof fm.roost_subcategory === "string" ? fm.roost_subcategory : null;
  const subOk = desiredSub === undefined || desiredSub === curSub;
  // Idempotent: skip when category + provenance are already correct AND the subcategory
  // already matches what we'd write.
  if (fm.roost_category === target && fm.roost_assigned_by === "human" && subOk) return null;
  const patch: { roost_category: string; roost_assigned_by: "human"; roost_subcategory?: string | null } = {
    roost_category: target,
    roost_assigned_by: "human",
  };
  if (desiredSub !== undefined && desiredSub !== curSub) patch.roost_subcategory = desiredSub;
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
        if ("roost_subcategory" in patch) {
          if (patch.roost_subcategory === null) delete front.roost_subcategory;
          else front.roost_subcategory = patch.roost_subcategory;
        }
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
