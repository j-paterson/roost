/**
 * Binds BookmarksBasesView state into GalleryApplyFilterHost (keeps orchestrator thin).
 */
import type { BasesEntry } from "obsidian";
import type { RoostFilter, MatchDetail } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";
import type { GalleryApplyFilterHost } from "@/views/gallery-apply-filter";
import type { GalleryFolderFilterApplied } from "@/views/gallery-filter-apply";
import type { GalleryFilterIndicesResult } from "@/views/gallery-filter-indices";
import type { GalleryExpandFocusHost } from "@/views/gallery-expand-focus";

/** Shape implemented by BookmarksBasesView for filter application. */
export interface GalleryApplyFilterViewBind {
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

export function bindGalleryApplyFilterHost(
  view: GalleryApplyFilterViewBind,
): GalleryApplyFilterHost {
  return {
    getRoostPlugin: () => view.getRoostPlugin(),
    getCardSize: () => view.getCardSize(),
    getEntries: () => view.getEntries(),
    containerEl: view.containerEl,
    cfgImagePropId: view.cfgImagePropId,
    resolveImageUrl: (entry, propId) => view.resolveImageUrl(entry, propId),
    hydrationObserver: view.hydrationObserver,
    activePlatformFilter: view.activePlatformFilter,
    pinnedRoostIds: view.pinnedRoostIds,
    reapplyingFilter: view.reapplyingFilter,
    syncViewModeForFilter: (f) => view.syncViewModeForFilter(f),
    refreshFeedIfActive: (f) => view.refreshFeedIfActive(f),
    pushFilterHistory: (f, push) => view.pushFilterHistory(f, push),
    setCurrentFilter: (f) => view.setCurrentFilter(f),
    setMatchState: (matched, detail) => view.setMatchState(matched, detail),
    applyFolderResult: (result) => view.applyFolderResult(result),
    applyLayoutState: (layout) => view.applyLayoutState(layout),
    clearPinnedRoostIds: () => view.clearPinnedRoostIds(),
    buildToolbar: () => view.buildToolbar(),
    clearRenderedKey: () => view.clearRenderedKey(),
    onDataUpdated: () => view.onDataUpdated(),
    setReapplyingFilter: (active) => view.setReapplyingFilter(active),
    takePendingFocusId: () => view.takePendingFocusId(),
    expandFocusHost: () => view.expandFocusHost(),
    onFolderDrillDown: (folder) => view.onFolderDrillDown(folder),
    prepareFolderRender: () => view.prepareFolderRender(),
  };
}
