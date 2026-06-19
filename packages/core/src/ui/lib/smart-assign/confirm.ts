/**
 * Smart Assign confirm — bulk-write categorized assignments to vault notes.
 */
import { Notice } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";
import type { SmartAssignInput } from "@/types/roost";
import { buildFileIndex } from "@/lib/vault-utils";
import { bulkWriteAssignments } from "@/ui/lib/bulk-write-assignments";
import type { IRoostPlugin } from "@/types/plugin";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { TagAssignment } from "@/pipeline/evaluate";
import { appendCategoryTags, tagToObsidianTag } from "@/lib/category-tags";
export interface SmartAssignConfirmStore {
  getClusterGroups: () => Array<{ uncertainItemIds?: string[] }>;
  getReassignments: () => Map<string, string>;
}

export interface SmartAssignConfirmHost {
  plugin: IRoostPlugin;
  syncFolder: string;
  log: (msg: string) => void;
  setSyncProgress: (p: SyncProgress | null | ((prev: SyncProgress | null) => SyncProgress | null)) => void;
  getInput: () => SmartAssignInput | null;
  unsortedIds: Set<string>;
  assignedSubcategories: Map<string, string | null>;
  store: SmartAssignConfirmStore;
  fileManager: import("obsidian").FileManager;
  metadataCache: import("obsidian").MetadataCache;
  runUnderGuard?: () => Promise<void> | void;
  /**
   * Multi-label tag assignments from the tag-detector forward pass (Wave 2 D1).
   * Present only when `settings.smartAssignTags` is true and the detector weights
   * were loaded successfully.  When provided, `confirmSmartAssign` appends
   * `category/*` native tags for every fired detector tag and sets
   * `roost_category` to the primary (only if absent or a dropped tag).
   */
  tagAssignments?: Map<string, TagAssignment>;
}

export interface SmartAssignConfirmResult {
  tagged: number;
}

/**
 * Provenance stamp for a confirmed item. A user reassignment (an explicit move in the
 * Smart Assign review UI) is a HUMAN decision — it should up-weight the centroid
 * (HUMAN_WEIGHT) and count as an honest label; an untouched proposal is the machine's.
 */
export function confirmAssignedBy(reassigned: Map<string, string>, id: string): "human" | "auto" {
  return reassigned.has(id) ? "human" : "auto";
}

export async function confirmSmartAssign(
  host: SmartAssignConfirmHost,
  proposedFolders: { name: string; itemIds: string[] }[] | null,
): Promise<SmartAssignConfirmResult | null> {
  if (!proposedFolders) return null;

  host.log("Confirming Smart Assign...");

  const uncertainIds = new Set<string>();
  for (const group of host.store.getClusterGroups()) {
    if (group.uncertainItemIds) {
      for (const id of group.uncertainItemIds) uncertainIds.add(id);
    }
  }
  const reassigned = host.store.getReassignments();

  const confirmInput = host.getInput();
  const isSubcat = confirmInput?.write.into === "subcategoryOf";
  const parentName = isSubcat ? (confirmInput!.write as { into: "subcategoryOf"; parent: string }).parent : null;

  const itemCategory = new Map<string, string>();
  for (const folder of proposedFolders) {
    for (const id of folder.itemIds) {
      if (!host.unsortedIds.has(id)) continue;
      if (uncertainIds.has(id) && !reassigned.has(id)) continue;
      if (isSubcat) {
        itemCategory.set(id, folder.name);
      } else {
        const subcat = host.assignedSubcategories.get(id) ?? null;
        const encoded = subcat === null ? `${folder.name}\x00` : `${folder.name}\x00${subcat}`;
        itemCategory.set(id, encoded);
      }
    }
  }

  const totalProposed = proposedFolders.reduce((n, f) => n + f.itemIds.length, 0);
  const skippedUncertain = [...uncertainIds].filter(id => !reassigned.has(id)).length;
  host.log(`[confirm] ${itemCategory.size} items to categorize (${totalProposed} total, ${skippedUncertain} uncertain skipped, ${totalProposed - itemCategory.size - skippedUncertain} already categorized)`);

  const fileByRoostId = buildFileIndex(host.plugin.app, host.syncFolder);

  const result = await bulkWriteAssignments({
    itemAssignments: itemCategory,
    fileByKey: fileByRoostId,
    fileManager: host.fileManager,
    plugin: host.plugin,
    events: host.metadataCache,
    patchFor: (id, value) => {
      const assignedBy = confirmAssignedBy(reassigned, id);
      if (isSubcat) {
        return { [CATEGORY_FIELD]: parentName!, [SUBCATEGORY_FIELD]: value, [ASSIGNED_BY_FIELD]: assignedBy };
      }
      const sep = value.indexOf("\x00");
      if (sep < 0) {
        return { [CATEGORY_FIELD]: value, [SUBCATEGORY_FIELD]: null, [ASSIGNED_BY_FIELD]: assignedBy };
      }
      const category = value.slice(0, sep);
      const subcategory = value.slice(sep + 1);
      return {
        [CATEGORY_FIELD]: category,
        [SUBCATEGORY_FIELD]: subcategory || null,
        [ASSIGNED_BY_FIELD]: assignedBy,
      };
    },
    log: host.log,
    setProgress: (done, total) =>
      host.setSyncProgress({ phase: "writing", count: total, written: done, skipped: 0, resynced: 0 }),
    runUnderGuard: host.runUnderGuard,
  });

  host.log(`[confirm] tagged=${result.tagged} alreadySet=${result.alreadySet} notFound=${result.notFound} errors=${result.errors}`);
  if (result.notFound > 0) host.log(`[confirm] ${result.notFound} items could not be matched to vault files`);

  // ── Wave 2 D1: Append category/* tags when tagAssignments are present ────────
  // Mirrors the faithfulness contract of migrate-to-tags.mjs migrateNote:
  //   - Append category/<slug> for every fired tag — never remove existing tags.
  //   - Set roost_category to the primary ONLY when absent or a dropped tag
  //     (i.e. not in the detector canon — preserve existing valid primaries).
  if (host.tagAssignments && host.tagAssignments.size > 0) {
    const tagAssignments = host.tagAssignments;
    let tagWriteCount = 0;

    for (const [id, ta] of tagAssignments) {
      const file = fileByRoostId.get(id);
      if (!file) continue;
      try {
        await host.fileManager.processFrontMatter(file, (fm) => {
          // Existing tags array (may be string[] or undefined in frontmatter)
          const existingTags: string[] = Array.isArray(fm["tags"])
            ? (fm["tags"] as unknown[]).map(String)
            : [];

          // Append category/* tags for all fired tags (appendCategoryTags deduplicates)
          const allTagNames = ta.tags.length > 0 ? ta.tags : [ta.primary];
          const newTags = appendCategoryTags(existingTags, allTagNames);

          // Also ensure the primary has its category/* tag even if it didn't fire
          const primaryObsTag = tagToObsidianTag(ta.primary);
          const finalTags = newTags.includes(primaryObsTag)
            ? newTags
            : appendCategoryTags(newTags, [ta.primary]);

          if (finalTags.length !== existingTags.length ||
              !finalTags.every((t, i) => t === existingTags[i])) {
            fm["tags"] = finalTags;
          }

          // Set roost_category = primary ONLY if absent or a dropped tag.
          // Faithful to migrate-to-tags.mjs migrateNote:
          //   keepPrimary = !!(oldPrimary && canon.has(oldPrimary))
          //   effectivePrimary = keepPrimary ? oldPrimary : primary
          // ta.canonTags is the full detector tag list, matching what migrateNote
          // calls `detectors.tags` — so "dropped tag" = any category no longer in
          // the trained detector weights (e.g. "Content Creation" removed from canon).
          const existingPrimary = typeof fm[CATEGORY_FIELD] === "string"
            ? (fm[CATEGORY_FIELD] as string)
            : null;
          const canon = new Set(ta.canonTags);
          const keepPrimary = !!(existingPrimary && canon.has(existingPrimary));
          if (!keepPrimary) {
            fm[CATEGORY_FIELD] = ta.primary;
          }
        });
        tagWriteCount++;
      } catch (e: unknown) {
        host.log(`[confirm/tags] error writing tags for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    host.log(`[confirm/tags] wrote category/* tags for ${tagWriteCount} items`);
  }

  new Notice(`Smart Assign complete — ${result.tagged} notes categorized`);

  return { tagged: result.tagged };
}
