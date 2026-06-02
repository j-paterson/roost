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
}

export interface SmartAssignConfirmResult {
  tagged: number;
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
    patchFor: (_, value) => {
      if (isSubcat) {
        return { [CATEGORY_FIELD]: parentName!, [SUBCATEGORY_FIELD]: value, [ASSIGNED_BY_FIELD]: "auto" };
      }
      const sep = value.indexOf("\x00");
      if (sep < 0) {
        return { [CATEGORY_FIELD]: value, [SUBCATEGORY_FIELD]: null, [ASSIGNED_BY_FIELD]: "auto" };
      }
      const category = value.slice(0, sep);
      const subcategory = value.slice(sep + 1);
      return {
        [CATEGORY_FIELD]: category,
        [SUBCATEGORY_FIELD]: subcategory || null,
        [ASSIGNED_BY_FIELD]: "auto",
      };
    },
    log: host.log,
    setProgress: (done, total) =>
      host.setSyncProgress({ phase: "writing", count: total, written: done, skipped: 0, resynced: 0 }),
    runUnderGuard: host.runUnderGuard,
  });

  host.log(`[confirm] tagged=${result.tagged} alreadySet=${result.alreadySet} notFound=${result.notFound} errors=${result.errors}`);
  if (result.notFound > 0) host.log(`[confirm] ${result.notFound} items could not be matched to vault files`);
  new Notice(`Smart Assign complete — ${result.tagged} notes categorized`);

  return { tagged: result.tagged };
}
