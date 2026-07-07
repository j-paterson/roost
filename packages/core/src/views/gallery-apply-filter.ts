/**
 * Gallery filter application — orchestrates feed mode, folder view, layout, grid rebuild.
 */
import type { BasesEntry } from "obsidian";
import type { RoostFilter, MatchDetail } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";
import { traceEvent } from "@/lib/render-trace";
import {
  galleryFilterLayoutState,
  galleryFilterMatchState,
  tryApplyGalleryFolderFilter,
  type GalleryFolderFilterApplied,
} from "@/views/gallery-filter-apply";
import type { GalleryFilterIndicesResult } from "@/views/gallery-filter-indices";
import type { GalleryExpandFocusHost } from "@/views/gallery-expand-focus";
import { focusAndExpandGalleryCard } from "@/views/gallery-expand-focus";

export interface GalleryApplyFilterHost {
  getRoostPlugin(): IRoostPlugin | null;
  getCardSize(): number;
  getEntries(): BasesEntry[] | undefined;
  containerEl: HTMLElement;
  cfgImagePropId: string;
  resolveImageUrl(entry: BasesEntry, propId: string): string | null;
  hydrationObserver: IntersectionObserver | null;
  activePlatformFilter: string | null;
  pinnedRoostIds: Set<string> | null;
  reapplyingFilter: boolean;

  syncViewModeForFilter(filter: RoostFilter): void;
  refreshFeedIfActive(filter: RoostFilter): void;
  pushFilterHistory(filter: RoostFilter, pushHistory: boolean): void;
  setCurrentFilter(filter: RoostFilter): void;
  setMatchState(matched: Set<string> | null, detail: Map<string, MatchDetail> | null): void;
  applyFolderResult(result: GalleryFolderFilterApplied): void;
  applyLayoutState(layout: GalleryFilterIndicesResult): void;
  clearPinnedRoostIds(): void;
  buildToolbar(): void;
  clearRenderedKey(): void;
  onDataUpdated(): void;
  setReapplyingFilter(active: boolean): void;
  takePendingFocusId(): string | null;
  expandFocusHost(): GalleryExpandFocusHost;
  onFolderDrillDown(folder: { id?: string; name: string; itemIds: string[] }): void;
  prepareFolderRender(): void;
}

export function applyGalleryFilter(
  host: GalleryApplyFilterHost,
  filter: RoostFilter,
  pushHistory = true,
): void {
  const plugin = host.getRoostPlugin();
  traceEvent("applyFilter:enter", {
    filterCategory: filter?.category ?? null,
    filterSubcategory: filter?.subcategory ?? null,
    bulkWriteInProgress: plugin?.bulkWriteInProgress ?? false,
    reapplyingFilter: host.reapplyingFilter,
    pushHistory,
  });

  host.setCurrentFilter(filter);
  host.pushFilterHistory(filter, pushHistory);

  // Defer only NON-user-initiated re-applications during a bulk write. A user
  // clicking a folder (pushHistory) must update the gallery immediately, even
  // while a background sync is streaming writes.
  if (plugin?.bulkWriteInProgress && !pushHistory) {
    traceEvent("applyFilter:deferred");
    return;
  }

  const matchState = galleryFilterMatchState(filter);
  host.setMatchState(matchState.matchedRoostIds, matchState.matchDetailMap);

  const folderApplied = tryApplyGalleryFolderFilter(
    filter,
    host.containerEl,
    {
      cardSize: host.getCardSize(),
      entries: host.getEntries(),
      imagePropId: host.cfgImagePropId,
      resolveImageUrl: (entry, propId) => host.resolveImageUrl(entry, propId),
      onFolderClick: (folder) => host.onFolderDrillDown(folder),
    },
    () => host.prepareFolderRender(),
  );
  if (folderApplied) {
    host.applyFolderResult(folderApplied);
    return;
  }

  const entries = host.getEntries();
  if (!entries) {
    if (filter?.category === "Media") {
      host.syncViewModeForFilter(filter);
      host.refreshFeedIfActive(filter);
    }
    return;
  }

  const layout = galleryFilterLayoutState(
    entries,
    filter,
    host.activePlatformFilter,
    matchState.matchDetailMap,
    host.pinnedRoostIds,
  );
  host.applyLayoutState(layout);
  host.clearPinnedRoostIds();
  // Feed split mounts after filteredIndices exist so scoped entries are correct.
  host.syncViewModeForFilter(filter);
  host.refreshFeedIfActive(filter);
  host.buildToolbar();
  host.clearRenderedKey();

  traceEvent("applyFilter:beforeRender", {
    filteredCount: layout.filteredIndices?.length ?? null,
    splitMode: layout.splitMode,
  });

  host.setReapplyingFilter(true);
  try {
    host.onDataUpdated();
  } finally {
    host.setReapplyingFilter(false);
  }

  const focusId = host.takePendingFocusId();
  if (focusId) {
    focusAndExpandGalleryCard(host.expandFocusHost(), focusId);
  }
}
