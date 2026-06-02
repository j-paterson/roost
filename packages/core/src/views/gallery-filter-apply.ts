/**
 * Gallery filter application — compute indices and match metadata from RoostFilter.
 */
import type { BasesEntry } from "obsidian";
import type { RoostFilter, MatchDetail, FolderView } from "@/types/roost";
import {
  renderGalleryFolderCards,
  type GalleryFolderCardsContext,
} from "@/views/gallery-folder-cards";
import {
  computeGalleryFilterIndices,
  sortIndicesWithPins,
  type GalleryFilterIndicesResult,
} from "@/views/gallery-filter-indices";

export interface GalleryFilterMatchState {
  matchedRoostIds: Set<string> | null;
  matchDetailMap: Map<string, MatchDetail> | null;
}

export interface GalleryFilterLayoutState extends GalleryFilterIndicesResult {
  filteredIndices: number[] | null;
}

/** Derive match sets from filter; clears when filter is null. */
export function galleryFilterMatchState(filter: RoostFilter): GalleryFilterMatchState {
  if (!filter) {
    return { matchedRoostIds: null, matchDetailMap: null };
  }
  return {
    matchedRoostIds: filter.matchedItemIds ? new Set(filter.matchedItemIds) : null,
    matchDetailMap: filter.matchDetailMap ?? null,
  };
}

/** Compute filtered indices (+ split layout) and apply pin-to-top ordering. */
export function galleryFilterLayoutState(
  entries: BasesEntry[],
  filter: RoostFilter,
  activePlatformFilter: string | null,
  matchDetailMap: Map<string, MatchDetail> | null,
  pinnedRoostIds: Set<string> | null,
): GalleryFilterLayoutState {
  const result = computeGalleryFilterIndices({
    entries,
    filter,
    activePlatformFilter,
    matchDetailMap,
  });

  let filteredIndices = result.filteredIndices;
  if (pinnedRoostIds && pinnedRoostIds.size > 0 && filteredIndices) {
    filteredIndices = sortIndicesWithPins(filteredIndices, entries, pinnedRoostIds);
  }

  return { ...result, filteredIndices };
}

export function isGalleryFolderFilter(
  filter: RoostFilter,
): filter is RoostFilter & { folders: FolderView[] } {
  return !!(filter?.folders && filter.folders.length > 0);
}

export interface GalleryFolderFilterApplied {
  filteredIndices: null;
  renderedKey: "__folders__";
}

/** Folder drill-down: render stacked folder cards instead of item grid. */
export function tryApplyGalleryFolderFilter(
  filter: RoostFilter,
  container: HTMLElement,
  ctx: GalleryFolderCardsContext,
  onBeforeRender?: () => void,
): GalleryFolderFilterApplied | null {
  if (!isGalleryFolderFilter(filter)) return null;
  onBeforeRender?.();
  renderGalleryFolderCards(container, filter.folders, ctx);
  return { filteredIndices: null, renderedKey: "__folders__" };
}
