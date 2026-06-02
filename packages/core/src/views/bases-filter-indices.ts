import type { BasesEntry } from "obsidian";
import { CATEGORY_FIELD } from "@/config";
import type { RoostFilter } from "@/types/roost";
import { safeGetValue, getRoostId } from "@/lib/bases-entry";
import { filterEntryIndices, matchesFilter } from "@/lib/vault-utils";

export interface BookmarkFilterIndicesResult {
  filteredIndices: number[] | null;
  uncertainRoostIds: Set<string> | null;
}

function normalizeCategory(raw: unknown): string | undefined {
  const catStr = raw != null ? String(raw).trim() : "";
  if (!catStr || catStr === "undefined" || catStr === "null") return undefined;
  return catStr;
}

function entryFrontmatterForFilter(entry: BasesEntry): Record<string, string | undefined> {
  return {
    roost_id: safeGetValue(entry, "note.roost_id")?.toString() ?? undefined,
    platform: safeGetValue(entry, "note.platform")?.toString() ?? "",
    [CATEGORY_FIELD]: normalizeCategory(safeGetValue(entry, `note.${CATEGORY_FIELD}`)),
  };
}

/** Bookmark gallery filter → flat indices into data.data */
export function computeBookmarkFilterIndices(
  entries: BasesEntry[],
  filter: RoostFilter,
): BookmarkFilterIndicesResult {
  if (!filter) {
    return { filteredIndices: null, uncertainRoostIds: null };
  }

  if (filter.itemIds) {
    const idSet = new Set(filter.itemIds);
    if (filter.certainItemIds && filter.uncertainItemIds) {
      const certainSet = new Set(filter.certainItemIds);
      const uncertainSet = new Set<string>(filter.uncertainItemIds);
      const certainIndices: number[] = [];
      const uncertainIndices: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const roostId = getRoostId(entries[i]);
        if (!idSet.has(roostId)) continue;
        if (certainSet.has(roostId)) certainIndices.push(i);
        else if (uncertainSet.has(roostId)) uncertainIndices.push(i);
        else certainIndices.push(i);
      }
      return {
        filteredIndices: [...certainIndices, ...uncertainIndices],
        uncertainRoostIds: uncertainSet,
      };
    }

    return {
      filteredIndices: filterEntryIndices(entries, (entry) => {
        const roostId = getRoostId(entry);
        return idSet.has(roostId);
      }),
      uncertainRoostIds: null,
    };
  }

  return {
    filteredIndices: filterEntryIndices(entries, (entry) =>
      matchesFilter(entryFrontmatterForFilter(entry), filter),
    ),
    uncertainRoostIds: null,
  };
}

/** Explorer folder path filter → flat indices */
export function computeExplorerFolderIndices(
  entries: BasesEntry[],
  folderPath: string,
): number[] {
  const prefix = `${folderPath}/`;
  return filterEntryIndices(entries, (entry) => {
    const path = entry.file.path;
    return path.startsWith(prefix) || entry.file.parent?.path === folderPath;
  });
}
