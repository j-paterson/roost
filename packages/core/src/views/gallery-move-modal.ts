/**
 * Gallery move-to modal — staging (Smart Assign) vs vault collection targets,
 * neighbor selection mode after plain-gallery moves.
 */
import { App, BasesEntry, TFile, Notice } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";
import type { IRoostPlugin } from "@/types/plugin";
import { safeGetValue } from "@/lib/bases-entry";
import {
  gatherVaultCollections,
  buildFileIndex,
  encodeMoveTarget,
  decodeMoveTarget,
} from "@/lib/vault-utils";
import { bulkWriteAssignments } from "@/ui/lib/bulk-write-assignments";
import { ItemModal } from "@/ui/components/item-modal";
import { SuggestionModal } from "@/ui/components/suggestion-modal";
import { loadEmbeddingCache, computeCentroid } from "@/pipeline/shared";
import { suggestNeighbors } from "@/pipeline/suggest-neighbors";
import type { GalleryCardConfig } from "@/views/gallery-cards";

async function bulkWriteCategoryMove(
  ctx: GalleryMoveModalContext,
  plugin: IRoostPlugin,
  ids: string[],
  fileByKey: Map<string, TFile>,
  to: string,
): Promise<number> {
  const { category, subcategory } = decodeMoveTarget(to);
  const itemAssignments = new Map<string, string>();
  for (const id of ids) itemAssignments.set(id, to);
  const result = await bulkWriteAssignments({
    itemAssignments,
    fileByKey,
    fileManager: ctx.app.fileManager,
    plugin,
    events: ctx.app.metadataCache,
    patchFor: () => ({
      [CATEGORY_FIELD]: category,
      [SUBCATEGORY_FIELD]: subcategory ?? null,
      [ASSIGNED_BY_FIELD]: "human",
    }),
    log: () => {},
    setProgress: () => {},
  });
  return result.tagged;
}

export interface GalleryMoveModalContext {
  app: App;
  cfg: Pick<GalleryCardConfig, "imagePropId">;
  getRoostPlugin: () => IRoostPlugin | null;
  getAllEntries: () => BasesEntry[];
  resolveVideoUrl: (entry: BasesEntry) => string | null;
  resolveImageUrl: (entry: BasesEntry, propId: string) => string | null;
  resolveAllImages: (entry: BasesEntry) => string[];
  enterSelectionMode: (
    itemIds: string[],
    targetName: string,
    onAccept: (ids: string[]) => void,
  ) => void;
  /** Drop moved entry from filtered gallery and refresh when applicable. */
  onEntryRemovedFromGallery: (entry: BasesEntry) => void;
}

/** Open the Move-to modal for a gallery entry (card action or expanded collection row). */
export function openGalleryMoveModal(ctx: GalleryMoveModalContext, entry: BasesEntry): void {
  const plugin2 = ctx.getRoostPlugin();
  if (!plugin2) return;
  const groupId = plugin2.activeFilter?.groupId;
  const itemCategory = safeGetValue(entry, `note.${CATEGORY_FIELD}`)?.toString() || null;
  const item = {
    roostId: safeGetValue(entry, "note.roost_id")?.toString() || "",
    title: safeGetValue(entry, "note.title")?.toString() || entry.file.basename,
    author: (safeGetValue(entry, "note.author")?.toString() || "").replace(/\[\[People\/|\]\]/g, ""),
    platform: safeGetValue(entry, "note.platform")?.toString() || "",
    collection: itemCategory || safeGetValue(entry, "note.collection")?.toString() || null,
    tags: (safeGetValue(entry, "note.tags")?.toString() || "")
      .split(",")
      .map((t: string) => t.trim())
      .filter(Boolean),
    stats: {
      plays: Number(safeGetValue(entry, "note.stats_plays")) || undefined,
      likes: Number(safeGetValue(entry, "note.stats_likes")) || undefined,
      comments: Number(safeGetValue(entry, "note.stats_comments")) || undefined,
      shares: Number(safeGetValue(entry, "note.stats_shares")) || undefined,
    },
    url: safeGetValue(entry, "note.url")?.toString() || null,
    filePath: entry.file.path,
    videoUrl: ctx.resolveVideoUrl(entry),
    imageUrl: ctx.resolveImageUrl(entry, ctx.cfg.imagePropId),
    allImages: ctx.resolveAllImages(entry),
  };

  if (groupId) {
    const proposedFolders = plugin2.proposedFolderNames || [];
    const modal = new ItemModal({
      app: ctx.app,
      item,
      currentGroupId: groupId,
      proposedFolders,
      itemVec: null,
      collectionCentroids: {},
      recentTargets: [],
      onMove: (itemId, from, to) => {
        plugin2.lastSuggestionResult = null;
        plugin2.fireItemClick({ action: "move", itemId, from, to });
        const suggestions = plugin2.lastSuggestionResult;
        if (suggestions) {
          modal.close();
          const suggModal = new SuggestionModal({
            app: ctx.app,
            suggestions,
            onAccept: (ids) => {
              plugin2.fireItemClick({ action: "acceptSuggestions", itemIds: ids });
            },
            onDismiss: () => {
              plugin2.fireItemClick({ action: "dismissSuggestions" });
            },
            onReview: (ids) => {
              plugin2.setFilter({ itemIds: ids });
            },
          });
          suggModal.open();
        } else {
          modal.close();
        }
      },
      suggestions: null,
      onAcceptSuggestions: (ids) => {
        plugin2.fireItemClick({ action: "acceptSuggestions", itemIds: ids });
      },
      onDismissSuggestions: () => {
        plugin2.fireItemClick({ action: "dismissSuggestions" });
      },
      onReviewSuggestions: (ids) => {
        plugin2.setFilter({ itemIds: ids });
      },
    });
    modal.open();
    return;
  }

  const isNullish = (v: string | undefined | null): v is null | undefined =>
    !v || v === "null" || v === "undefined";
  const catSubs = new Map<string, Set<string>>();
  for (const e of ctx.getAllEntries()) {
    const cat = safeGetValue(e, `note.${CATEGORY_FIELD}`)?.toString();
    if (isNullish(cat)) continue;
    if (!catSubs.has(cat)) catSubs.set(cat, new Set());
    const sub = safeGetValue(e, `note.${SUBCATEGORY_FIELD}`)?.toString();
    if (!isNullish(sub)) catSubs.get(cat)!.add(sub);
  }
  const emptySubs = plugin2.settings?.emptySubcategories ?? {};
  for (const [cat, subs] of Object.entries(emptySubs)) {
    if (!catSubs.has(cat)) catSubs.set(cat, new Set());
    for (const sub of subs) catSubs.get(cat)!.add(sub);
  }
  const vaultFolders: { id: string; name: string }[] = [];
  for (const [cat, subs] of [...catSubs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    vaultFolders.push({ id: cat, name: cat });
    for (const sub of [...subs].sort()) {
      vaultFolders.push({ id: encodeMoveTarget(cat, sub), name: `  ${sub}` });
    }
  }

  const cache = loadEmbeddingCache(ctx.app.vault);
  const roostId = safeGetValue(entry, "note.roost_id")?.toString() ?? "";
  const itemVec = cache[roostId]?.vec ?? null;
  const syncFolder = plugin2.settings?.syncFolder ?? "Bookmarks";
  const { collections } = gatherVaultCollections(ctx.app, syncFolder);
  const centroids: Record<string, number[]> = {};
  for (const [name, ids] of Object.entries(collections)) {
    const vecs = ids.map(id => cache[id]?.vec).filter(Boolean) as number[][];
    if (vecs.length > 0) centroids[name] = computeCentroid(vecs);
  }
  const recentTargets: string[] = plugin2.settings?.recentMoveTargets ?? [];

  const modal = new ItemModal({
    app: ctx.app,
    item,
    currentGroupId: itemCategory || "",
    proposedFolders: vaultFolders,
    itemVec,
    collectionCentroids: centroids,
    recentTargets,
    onMove: async (_itemId, _from, to) => {
      let moved = false;
      try {
        const file = ctx.app.vault.getAbstractFileByPath(entry.file.path);
        if (!(file instanceof TFile)) {
          new Notice(`Could not find file: ${entry.file.path}`);
        } else if (!roostId) {
          new Notice("Move failed: missing roost_id");
        } else {
          const tagged = await bulkWriteCategoryMove(
            ctx,
            plugin2,
            [roostId],
            new Map([[roostId, file]]),
            to,
          );
          if (tagged > 0) {
            const { category: toCat, subcategory: toSub } = decodeMoveTarget(to);
            new Notice(`Moved to ${toSub ? `${toCat} › ${toSub}` : toCat}`);
            moved = true;
          }
        }
      } catch (err: unknown) {
        console.error("[roost] move-to error:", err);
        new Notice(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      modal.close();
      ctx.onEntryRemovedFromGallery(entry);

      if (!moved) return;

      const recents = [to, ...(plugin2.settings.recentMoveTargets ?? []).filter((t: string) => t !== to)].slice(0, 5);
      plugin2.settings.recentMoveTargets = recents;
      plugin2.saveSettings();

      if (itemVec && itemCategory) {
        const postCollections = gatherVaultCollections(ctx.app, syncFolder).collections;
        const sourceIds = postCollections[itemCategory] ?? [];
        const targetIds = postCollections[to] ?? [];
        const neighbors = suggestNeighbors({
          movedItemIds: [roostId],
          sourceGroupItemIds: { [itemCategory]: sourceIds },
          targetGroupItemIds: targetIds,
          cache,
          clipFusionAlpha: plugin2.settings?.clipFusionAlpha,
        });
        if (neighbors.length > 0) {
          const neighborIds = neighbors.map(n => n.itemId);
          const capturedTo = to;
          const capturedSyncFolder = syncFolder;
          ctx.enterSelectionMode(neighborIds, capturedTo, async (ids) => {
            const fileIndex = buildFileIndex(ctx.app, capturedSyncFolder);
            const fileByKey = new Map<string, TFile>();
            for (const nId of ids) {
              const nFile = fileIndex.get(nId);
              if (nFile) fileByKey.set(nId, nFile);
            }
            const tagged = await bulkWriteCategoryMove(ctx, plugin2, ids, fileByKey, capturedTo);
            new Notice(`Moved ${tagged} item${tagged !== 1 ? "s" : ""} to ${capturedTo}`);
          });
        }
      }
    },
    suggestions: null,
    onAcceptSuggestions: () => {},
    onDismissSuggestions: () => {},
    onReviewSuggestions: () => {},
  });
  modal.open();
}
