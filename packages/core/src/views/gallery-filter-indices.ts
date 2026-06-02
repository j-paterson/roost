import type { BasesEntry } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import type { RoostFilter, MatchDetail } from "@/types/roost";
import { matchesFilter } from "@/lib/vault-utils";
import { safeGetValue } from "@/lib/bases-entry";

export interface GalleryFilterIndicesResult {
  filteredIndices: number[] | null;
  splitMode: boolean;
  certainIndicesSplit: number[] | null;
  uncertainIndicesSplit: number[] | null;
  uncertainRoostIds: Set<string> | null;
}

export interface ComputeGalleryFilterOpts {
  entries: BasesEntry[];
  filter: RoostFilter;
  activePlatformFilter: string | null;
  matchDetailMap: Map<string, MatchDetail> | null;
}

function sortIndicesByMatchScore(
  indices: number[],
  entries: BasesEntry[],
  matchDetailMap: Map<string, MatchDetail> | null,
): number[] {
  if (!matchDetailMap || matchDetailMap.size === 0) return indices;
  return indices.sort((a, b) => {
    const idA = safeGetValue(entries[a], "note.roost_id")?.toString();
    const idB = safeGetValue(entries[b], "note.roost_id")?.toString();
    const scoreA = (idA && matchDetailMap.get(idA)?.score) || 0;
    const scoreB = (idB && matchDetailMap.get(idB)?.score) || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return 0;
  });
}

/** Compute filteredIndices (+ optional split layout) from filter + platform overlay. */
export function computeGalleryFilterIndices(
  opts: ComputeGalleryFilterOpts,
): GalleryFilterIndicesResult {
  const { entries, filter, activePlatformFilter, matchDetailMap } = opts;

  if (!filter) {
    if (activePlatformFilter) {
      const indices: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const p = safeGetValue(entries[i], "note.platform")?.toString();
        if (p === activePlatformFilter) indices.push(i);
      }
      return {
        filteredIndices: indices,
        splitMode: false,
        certainIndicesSplit: null,
        uncertainIndicesSplit: null,
        uncertainRoostIds: null,
      };
    }
    return {
      filteredIndices: null,
      splitMode: false,
      certainIndicesSplit: null,
      uncertainIndicesSplit: null,
      uncertainRoostIds: null,
    };
  }

  if (filter.itemIds) {
    const idSet = new Set(filter.itemIds);
    if (filter.certainItemIds && filter.uncertainItemIds && filter.uncertainItemIds.length > 0) {
      const certainSet = new Set(filter.certainItemIds);
      const uncertainSet = new Set<string>(filter.uncertainItemIds);
      const certainIndices: number[] = [];
      const uncertainIndices: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const roostId = safeGetValue(entries[i], "note.roost_id")?.toString();
        if (!roostId || !idSet.has(roostId)) continue;
        if (certainSet.has(roostId)) certainIndices.push(i);
        else if (uncertainSet.has(roostId)) uncertainIndices.push(i);
        else certainIndices.push(i);
      }
      const certainSplit = sortIndicesByMatchScore(certainIndices, entries, matchDetailMap);
      const uncertainSplit = sortIndicesByMatchScore(uncertainIndices, entries, matchDetailMap);
      return {
        filteredIndices: [...certainSplit, ...uncertainSplit],
        splitMode: true,
        certainIndicesSplit: certainSplit,
        uncertainIndicesSplit: uncertainSplit,
        uncertainRoostIds: uncertainSet,
      };
    }

    const indices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const roostId = safeGetValue(entries[i], "note.roost_id")?.toString();
      if (roostId && idSet.has(roostId)) indices.push(i);
    }
    return {
      filteredIndices: sortIndicesByMatchScore(indices, entries, matchDetailMap),
      splitMode: false,
      certainIndicesSplit: null,
      uncertainIndicesSplit: null,
      uncertainRoostIds: null,
    };
  }

  const indices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const catRaw = safeGetValue(entry, `note.${CATEGORY_FIELD}`);
    const catStr = catRaw != null ? String(catRaw).trim() : "";
    const subcatRaw = safeGetValue(entry, `note.${SUBCATEGORY_FIELD}`);
    const subcatStr = subcatRaw != null ? String(subcatRaw).trim() : "";
    const fm: Record<string, string | undefined> = {
      roost_id: safeGetValue(entry, "note.roost_id")?.toString() ?? undefined,
      platform: safeGetValue(entry, "note.platform")?.toString() ?? "",
      [CATEGORY_FIELD]: catStr && catStr !== "undefined" && catStr !== "null" ? catStr : undefined,
      [SUBCATEGORY_FIELD]: subcatStr && subcatStr !== "undefined" && subcatStr !== "null" ? subcatStr : undefined,
    };
    if (!matchesFilter(fm, filter)) continue;
    if (activePlatformFilter && fm.platform !== activePlatformFilter) continue;
    indices.push(i);
  }

  return {
    filteredIndices: indices,
    splitMode: false,
    certainIndicesSplit: null,
    uncertainIndicesSplit: null,
    uncertainRoostIds: null,
  };
}

/** Sort pinned roost_ids to the top of indices, then return sorted copy. */
export function sortIndicesWithPins(
  indices: number[],
  entries: BasesEntry[],
  pinnedRoostIds: Set<string>,
): number[] {
  return [...indices].sort((a, b) => {
    const aId = safeGetValue(entries[a], "note.roost_id")?.toString() ?? "";
    const bId = safeGetValue(entries[b], "note.roost_id")?.toString() ?? "";
    const aPinned = pinnedRoostIds.has(aId) ? 0 : 1;
    const bPinned = pinnedRoostIds.has(bId) ? 0 : 1;
    return aPinned - bPinned;
  });
}
