/**
 * Staging item moves (GroupStore groups + vault collection cards) and neighbor suggestions.
 */
import type * as React from "react";
import type { Vault } from "obsidian";
import type { RoostFilter } from "@/types/roost";
import { loadEmbeddingCache } from "@/pipeline/shared";
import { suggestNeighbors, type NeighborSuggestion } from "@/pipeline/suggest-neighbors";

const COLLECTION_PREFIX = "collection-";

export interface StagingGroupSlice {
  name?: string;
  itemIds: string[];
}

export interface SmartAssignReassignStore {
  getGroup: (id: string) => StagingGroupSlice | null;
  reassignItems: (itemIds: string[], fromGroupId: string, toGroupId: string) => void;
}

export interface SmartAssignReassignHost {
  log: (msg: string) => void;
  vault: Vault;
  clipFusionAlpha: number;
  getVaultCollections: () => Record<string, string[]>;
  setVaultCollections: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  applyFilter: (filter: RoostFilter) => void;
  bumpStore: () => void;
  store: SmartAssignReassignStore;
  setSuggestions: (s: NeighborSuggestion[]) => void;
  setSuggestionTarget: (id: string | null) => void;
}

export interface StagingReassignResult {
  count: number;
  targetName: string;
  itemIds: string[];
}

function collectionNameFromId(groupId: string): string | null {
  return groupId.startsWith(COLLECTION_PREFIX) ? groupId.slice(COLLECTION_PREFIX.length) : null;
}

export function reassignStagingItems(
  host: SmartAssignReassignHost,
  itemIds: string[],
  fromGroupId: string,
  toGroupId: string,
): StagingReassignResult | null {
  const fromCollName = collectionNameFromId(fromGroupId);
  const toCollName = collectionNameFromId(toGroupId);
  const fromGroup = host.store.getGroup(fromGroupId);
  const toGroup = host.store.getGroup(toGroupId);
  const fromName = fromGroup?.name || fromCollName || fromGroupId;
  const toName = toGroup?.name || toCollName || toGroupId;

  host.log(`Moving ${itemIds.length} item(s): "${fromName}" → "${toName}"`);

  const moveSet = new Set(itemIds);
  const vaultCollections = host.getVaultCollections();
  let sourceItems: string[] | null = null;
  let targetItems: string[] | null = null;

  if (fromGroup) {
    fromGroup.itemIds = fromGroup.itemIds.filter(id => !moveSet.has(id));
    sourceItems = [...fromGroup.itemIds];
  } else if (fromCollName && vaultCollections[fromCollName]) {
    sourceItems = (vaultCollections[fromCollName] || []).filter(id => !moveSet.has(id));
    host.setVaultCollections(prev => {
      const updated = { ...prev };
      updated[fromCollName] = sourceItems!;
      return updated;
    });
  }

  if (toGroup) {
    toGroup.itemIds = [...toGroup.itemIds, ...itemIds];
    targetItems = [...toGroup.itemIds];
  } else if (toCollName) {
    targetItems = [...(vaultCollections[toCollName] || []), ...itemIds];
    host.setVaultCollections(prev => {
      const updated = { ...prev };
      updated[toCollName] = targetItems!;
      return updated;
    });
  }

  host.bumpStore();
  if (fromGroup) {
    host.applyFilter({ itemIds: fromGroup.itemIds, groupId: fromGroupId });
  }

  if (!sourceItems || !targetItems) {
    host.setSuggestions([]);
    host.setSuggestionTarget(null);
    return null;
  }

  const cache = loadEmbeddingCache(host.vault);
  const neighbors = suggestNeighbors({
    movedItemIds: itemIds,
    sourceGroupItemIds: { [fromGroupId]: sourceItems },
    targetGroupItemIds: targetItems,
    cache,
    clipFusionAlpha: host.clipFusionAlpha,
  });

  if (neighbors.length > 0) {
    host.setSuggestions(neighbors);
    host.setSuggestionTarget(toGroupId);
    host.log(`${neighbors.length} similar items may also belong in "${toName}".`);
    return { count: neighbors.length, targetName: toName, itemIds: neighbors.map(n => n.itemId) };
  }

  host.setSuggestions([]);
  host.setSuggestionTarget(null);
  return null;
}

export function dismissStagingSuggestions(host: Pick<SmartAssignReassignHost, "setSuggestions" | "setSuggestionTarget">): void {
  host.setSuggestions([]);
  host.setSuggestionTarget(null);
}

export function acceptStagingNeighborSuggestions(
  host: Pick<SmartAssignReassignHost, "store" | "setSuggestions" | "setSuggestionTarget" | "bumpStore">,
  suggestions: NeighborSuggestion[],
  suggestionTarget: string,
  itemIds: string[],
): void {
  const moveSet = new Set(itemIds);
  for (const s of suggestions) {
    if (moveSet.has(s.itemId)) {
      host.store.reassignItems([s.itemId], s.sourceGroupId, suggestionTarget);
    }
  }
  const remaining = suggestions.filter(s => !moveSet.has(s.itemId));
  host.setSuggestions(remaining);
  if (remaining.length === 0) host.setSuggestionTarget(null);
  host.bumpStore();
}
