/**
 * Typed bridge from bookmarks gallery state → GalleryGridRenderHost.
 *
 * rebuildGalleryGrid mutates several fields on the host; this adapter forwards
 * those writes to a plain state source so BookmarksBasesView avoids unsafe casts.
 */
import type { App, BasesEntry, BasesEntryGroup } from "obsidian";
import type { RoostFilter } from "@/types/roost";
import type { GalleryCardConfig } from "@/views/gallery-cards";

export interface GalleryGridConfigAccess {
  get(key: string): unknown;
  getAsPropertyId(key: string): string;
}

/** Mutable + readonly inputs for a single grid rebuild pass. */
export interface GalleryGridStateSource {
  app: App;
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  config: GalleryGridConfigAccess;
  data: { data: BasesEntry[]; groupedData?: BasesEntryGroup[] };

  filteredIndices: number[] | null;
  splitMode: boolean;
  certainIndicesSplit: number[] | null;
  uncertainIndicesSplit: number[] | null;
  currentFilter: RoostFilter;
  activePlatformFilter: string | null;

  renderedKey: string;
  knownPlatforms: string[];
  estimatedHeight: number;
  certainGrid: HTMLElement | null;
  uncertainGrid: HTMLElement | null;
  totalCount: number;
  loadedCount: number;
  cfg: GalleryCardConfig;
  hydrationObserver: IntersectionObserver | null;
  pendingExpandInPlaceId: string | null;

  refreshFeedEntries(filter: RoostFilter): void;
  /** Substitute-mode pipeline view is registered, active, and replaces the card grid. */
  shouldRenderPipelineSubstitute(): boolean;
  dispatchPipelineGalleryView(): boolean;
  applyGridStyle(cardSize: number, target?: HTMLElement): void;
  createPlaceholder(parent: HTMLElement, index: number, height: number): void;
  expandInPlaceById(roostId: string): void;
  onPlatformsDiscovered(platforms: string[]): void;
  getFeedViewMode(): "grid" | "feed";
  /** Update metadata-dependent DOM on a reconciled hydrated card. */
  syncKeptGalleryCard(card: HTMLElement, entry: BasesEntry): void;
}

/** Host surface consumed by rebuildGalleryGrid (includes mutable rebuild outputs). */
export interface GalleryGridRenderHost extends GalleryGridStateSource {}

/** Shape implemented by BookmarksBasesView for grid rebuild. */
export interface GalleryGridViewBind {
  app: App;
  getGalleryContainer(): HTMLElement;
  getGalleryScrollEl(): HTMLElement;
  config: GalleryGridConfigAccess;
  data: { data: BasesEntry[]; groupedData?: BasesEntryGroup[] };

  filteredIndices: number[] | null;
  splitMode: boolean;
  certainIndicesSplit: number[] | null;
  uncertainIndicesSplit: number[] | null;
  currentFilter: RoostFilter;
  activePlatformFilter: string | null;

  renderedKey: string;
  knownPlatforms: string[];
  estimatedHeight: number;
  certainGrid: HTMLElement | null;
  uncertainGrid: HTMLElement | null;
  totalCount: number;
  loadedCount: number;
  cfg: GalleryCardConfig;
  hydrationObserver: IntersectionObserver | null;
  pendingExpandInPlaceId: string | null;

  refreshFeedEntries(filter: RoostFilter): void;
  /** Substitute-mode pipeline view is registered, active, and replaces the card grid. */
  shouldRenderPipelineSubstitute(): boolean;
  dispatchPipelineGalleryView(): boolean;
  applyGridStyle(cardSize: number, target?: HTMLElement): void;
  createPlaceholder(parent: HTMLElement, index: number, height: number): void;
  expandInPlaceById(roostId: string): void;
  onPlatformsDiscovered(platforms: string[]): void;
  getFeedViewMode(): "grid" | "feed";
  /** Update metadata-dependent DOM on a reconciled hydrated card. */
  syncKeptGalleryCard(card: HTMLElement, entry: BasesEntry): void;
}

export function bindGalleryGridStateSource(view: GalleryGridViewBind): GalleryGridStateSource {
  return {
    app: view.app,
    containerEl: view.getGalleryContainer(),
    scrollEl: view.getGalleryScrollEl(),
    config: view.config,
    data: view.data,
    filteredIndices: view.filteredIndices,
    splitMode: view.splitMode,
    certainIndicesSplit: view.certainIndicesSplit,
    uncertainIndicesSplit: view.uncertainIndicesSplit,
    currentFilter: view.currentFilter,
    activePlatformFilter: view.activePlatformFilter,
    renderedKey: view.renderedKey,
    knownPlatforms: view.knownPlatforms,
    estimatedHeight: view.estimatedHeight,
    certainGrid: view.certainGrid,
    uncertainGrid: view.uncertainGrid,
    totalCount: view.totalCount,
    loadedCount: view.loadedCount,
    cfg: view.cfg,
    hydrationObserver: view.hydrationObserver,
    pendingExpandInPlaceId: view.pendingExpandInPlaceId,
    refreshFeedEntries: (filter) => view.refreshFeedEntries(filter),
    shouldRenderPipelineSubstitute: () => view.shouldRenderPipelineSubstitute(),
    dispatchPipelineGalleryView: () => view.dispatchPipelineGalleryView(),
    applyGridStyle: (cardSize, target) => view.applyGridStyle(cardSize, target),
    createPlaceholder: (parent, index, height) =>
      view.createPlaceholder(parent, index, height),
    expandInPlaceById: (roostId) => view.expandInPlaceById(roostId),
    onPlatformsDiscovered: (platforms) => view.onPlatformsDiscovered(platforms),
    getFeedViewMode: () => view.getFeedViewMode(),
    syncKeptGalleryCard: (card, entry) => view.syncKeptGalleryCard(card, entry),
  };
}

export function bindGalleryGridRenderHost(
  source: GalleryGridStateSource,
): GalleryGridRenderHost {
  return {
    get app() {
      return source.app;
    },
    get containerEl() {
      return source.containerEl;
    },
    get scrollEl() {
      return source.scrollEl;
    },
    get config() {
      return source.config;
    },
    get data() {
      return source.data;
    },
    get filteredIndices() {
      return source.filteredIndices;
    },
    get splitMode() {
      return source.splitMode;
    },
    get certainIndicesSplit() {
      return source.certainIndicesSplit;
    },
    get uncertainIndicesSplit() {
      return source.uncertainIndicesSplit;
    },
    get currentFilter() {
      return source.currentFilter;
    },
    get activePlatformFilter() {
      return source.activePlatformFilter;
    },
    get renderedKey() {
      return source.renderedKey;
    },
    set renderedKey(value: string) {
      source.renderedKey = value;
    },
    get knownPlatforms() {
      return source.knownPlatforms;
    },
    get estimatedHeight() {
      return source.estimatedHeight;
    },
    set estimatedHeight(value: number) {
      source.estimatedHeight = value;
    },
    get certainGrid() {
      return source.certainGrid;
    },
    set certainGrid(value: HTMLElement | null) {
      source.certainGrid = value;
    },
    get uncertainGrid() {
      return source.uncertainGrid;
    },
    set uncertainGrid(value: HTMLElement | null) {
      source.uncertainGrid = value;
    },
    get totalCount() {
      return source.totalCount;
    },
    set totalCount(value: number) {
      source.totalCount = value;
    },
    get loadedCount() {
      return source.loadedCount;
    },
    set loadedCount(value: number) {
      source.loadedCount = value;
    },
    get cfg() {
      return source.cfg;
    },
    set cfg(value: GalleryCardConfig) {
      source.cfg = value;
    },
    get hydrationObserver() {
      return source.hydrationObserver;
    },
    get pendingExpandInPlaceId() {
      return source.pendingExpandInPlaceId;
    },
    set pendingExpandInPlaceId(value: string | null) {
      source.pendingExpandInPlaceId = value;
    },
    refreshFeedEntries: (filter) => source.refreshFeedEntries(filter),
    shouldRenderPipelineSubstitute: () => source.shouldRenderPipelineSubstitute(),
    dispatchPipelineGalleryView: () => source.dispatchPipelineGalleryView(),
    applyGridStyle: (cardSize, target) => source.applyGridStyle(cardSize, target),
    createPlaceholder: (parent, index, height) =>
      source.createPlaceholder(parent, index, height),
    expandInPlaceById: (roostId) => source.expandInPlaceById(roostId),
    onPlatformsDiscovered: (platforms) => source.onPlatformsDiscovered(platforms),
    getFeedViewMode: () => source.getFeedViewMode(),
    syncKeptGalleryCard: (card, entry) => source.syncKeptGalleryCard(card, entry),
  };
}
