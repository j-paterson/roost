/**
 * Map flat gallery card index → BasesEntry (filtered + grouped data).
 */
import type { BasesEntry, BasesEntryGroup } from "obsidian";
import { getRoostId } from "@/lib/bases-entry";

export interface GalleryEntryDataSource {
  data: BasesEntry[];
  groupedData?: BasesEntryGroup[];
}

/** Resolve the entry behind a rendered card index. */
export function galleryEntryAtIndex(
  source: GalleryEntryDataSource,
  filteredIndices: number[] | null,
  index: number,
): BasesEntry | null {
  if (filteredIndices) {
    const realIndex = filteredIndices[index];
    return realIndex != null ? (source.data[realIndex] ?? null) : null;
  }
  if (source.groupedData && source.groupedData.length > 0) {
    let offset = 0;
    for (const group of source.groupedData) {
      if (index < offset + group.entries.length) {
        return group.entries[index - offset];
      }
      offset += group.entries.length;
    }
    return null;
  }
  return source.data[index] ?? null;
}

/** Find an entry by roost_id in the flat data array. */
export function findGalleryEntryByRoostId(
  entries: BasesEntry[],
  roostId: string,
): BasesEntry | null {
  for (const e of entries) {
    if (getRoostId(e) === roostId) return e;
  }
  return null;
}
