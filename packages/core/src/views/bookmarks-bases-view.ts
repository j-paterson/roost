/**
 * Custom Bases view — renders bookmark notes as a visual card grid.
 * Registers as "Bookmarks" in the Bases view dropdown.
 */
import { BasesView, BasesEntry, Menu, FuzzySuggestModal } from "obsidian";
import type { QueryController } from "obsidian";
import type { RoostFilter, MatchDetail } from "@/types/roost";
import { getRoostPlugin } from "@/lib/roost-plugin";
import { scopeBasesEntries } from "@/lib/scope-bases-entries";
import { toggleGalleryExpanded, createGalleryExpandState, type GalleryExpandState } from "@/views/gallery-expanded";
import { GallerySelectionController, type GallerySelectionHost } from "@/views/gallery-selection";
import { GalleryFeedModeController, type GalleryFeedModeHost } from "@/views/gallery-feed-mode";
import { traceEvent } from "@/lib/render-trace";
import { createCoalescingTrigger, type CoalescingTrigger } from "@/lib/debounce";
import {
  createGalleryPlaceholder,
  hydrateGalleryCard,
  syncGalleryCardFromEntry,
  type GalleryCardConfig,
} from "@/views/gallery-cards";
import { renderGalleryToolbar } from "@/views/gallery-toolbar";
import { openGalleryMoveModal } from "@/views/gallery-move-modal";
import { GalleryBulkWriteController } from "@/views/gallery-bulk-write";
import { GalleryFilterHistoryController } from "@/views/gallery-filter-history";
import { rebuildGalleryGrid } from "@/views/gallery-grid-render";
import {
  bindGalleryGridRenderHost,
  bindGalleryGridStateSource,
} from "@/views/gallery-grid-host";
import { galleryEntryAtIndex, findGalleryEntryByRoostId } from "@/views/gallery-entry-index";
import {
  expandGalleryInPlaceById,
  findNeighborRoostId,
  type GalleryExpandFocusHost,
} from "@/views/gallery-expand-focus";
import {
  attachGalleryPluginSubscriptions,
  createGalleryHydrationObserver,
} from "@/views/gallery-view-mount";
import {
  mountGalleryViewShell,
  showGalleryInitialSkeletons,
  applyGalleryGridStyle,
} from "@/views/gallery-shell";
import { applyGalleryFilter } from "@/views/gallery-apply-filter";
import {
  bindGalleryApplyFilterHost,
  type GalleryApplyFilterViewBind,
} from "@/views/gallery-apply-filter-host";
import type { GalleryFolderFilterApplied } from "@/views/gallery-filter-apply";
import { sinkGreenIndices, type GalleryFilterIndicesResult } from "@/views/gallery-filter-indices";
import {
  galleryMediaResolvers,
  galleryHasMultipleImages,
  galleryResolveAllImages,
  galleryResolveImageUrl,
  galleryResolveVideoUrl,
  galleryIsTextTileCover,
} from "@/views/gallery-media-bridge";
import { getExplorerExcerpt } from "@/views/explorer-excerpt";
import { createBookmarksPipelineHost } from "@/views/gallery-pipeline-setup";
import { pipelineTypeFromFrontmatter } from "@/pipeline/extraction-from-frontmatter";
import type { PipelineGalleryHost } from "@/views/gallery-pipeline-host";
import { isPipelineSubstituteView } from "@/views/pipeline-views/registry";
import { openLinkInView } from "@/views/roost-link-view";
import { isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";
import { CATEGORY_FIELD } from "@/config";
import { safeGetValue } from "@/lib/bases-entry";
import {
  confirmAutoItem,
  rejectAutoItem,
  planReviewConfirm,
  planCorrection,
  type TrainingActionDeps,
} from "@/pipeline/training-actions";
import { loadSnapshot, saveSnapshot } from "@/pipeline/category-snapshot";
import { loadTrainingSet, saveTrainingSet } from "@/pipeline/training-set";
import { appendEvalRecords } from "@/pipeline/eval-log";
import { readGuess } from "@/views/feed/training-mode";

export const BASES_VIEW_ID = "roost-bookmarks";

/** Coalescing window for gallery repaints — collapses an Obsidian re-index storm to one
 *  trailing paint (single updates still fire immediately via the leading edge). */
const GALLERY_DATA_UPDATE_DEBOUNCE_MS = 250;

export class BookmarksBasesView extends BasesView
  implements GallerySelectionHost, GalleryFeedModeHost, GalleryApplyFilterViewBind {
  type = BASES_VIEW_ID;
  // Public (not private): the Gallery host interfaces (GalleryFeedModeHost,
  // GalleryApplyFilterViewBind, GalleryBulkWriteHost, GalleryGridViewBind)
  // bind to these — a private member can't satisfy a public interface field.
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  private toolbarEl: HTMLElement;
  // Public: GalleryApplyFilterViewBind binds to it.
  hydrationObserver: IntersectionObserver | null = null;
  renderedKey = "";
  private unsubFilter: (() => void) | null = null;
  private unsubDataRefresh: (() => void) | null = null;
  private pipelineHost: PipelineGalleryHost;
  private pendingFocusId: string | null = null;
  // Public: GalleryGridViewBind binds to it.
  pendingExpandInPlaceId: string | null = null;
  reapplyingFilter = false;
  currentFilter: RoostFilter = null;
  filteredIndices: number[] | null = null;
  uncertainRoostIds: Set<string> | null = null;
  matchedRoostIds: Set<string> | null = null;
  matchDetailMap: Map<string, MatchDetail> | null = null;
  humanAssignedRoostIds: Set<string> | null = null;
  splitMode = false;
  certainIndicesSplit: number[] | null = null;
  uncertainIndicesSplit: number[] | null = null;
  certainGrid: HTMLElement | null = null;
  uncertainGrid: HTMLElement | null = null;

  private readonly filterHistory = new GalleryFilterHistoryController(this);
  // Public: GalleryApplyFilterViewBind / GalleryGridViewBind bind to it.
  activePlatformFilter: string | null = null;
  // Public: GalleryGridViewBind binds to it.
  knownPlatforms: string[] = [];
  private selectionBar: HTMLElement | null = null;
  private gallerySelection!: GallerySelectionController;
  private expandState: GalleryExpandState = createGalleryExpandState();
  pinnedRoostIds: Set<string> | null = null;
  private readonly bulkWrite = new GalleryBulkWriteController(this);
  cfg: GalleryCardConfig = {
    imagePropId: "note.cover", imageFit: "cover", imageRatio: 0.75,
    showPlatform: true, showAuthor: true, showTags: false,
  };
  loadedCount = 0;
  totalCount = 0;
  estimatedHeight = 0;
  private readonly feedMode: GalleryFeedModeController;

  getGalleryContainer(): HTMLElement {
    return this.containerEl;
  }

  getGalleryScrollEl(): HTMLElement {
    return this.scrollEl;
  }

  getGallerySelectionBar(): HTMLElement | null {
    return this.selectionBar;
  }

  getCurrentFilter(): RoostFilter {
    return this.currentFilter;
  }

  getRoostPlugin() {
    return getRoostPlugin(this.app);
  }

  getImagePropId(): string {
    return (this.config?.get?.("imagePropId") as string | undefined) ?? this.cfg.imagePropId;
  }

  getAllEntries(): BasesEntry[] {
    return this.data?.data ?? [];
  }

  getScopedEntries(): BasesEntry[] {
    return scopeBasesEntries(this.data?.data ?? [], this.filteredIndices);
  }

  onViewModeChanged(): void {
    this.buildToolbar();
  }

  onHistoryChanged(): void {
    this.buildToolbar();
  }

  onPlatformsDiscovered(platforms: string[]): void {
    this.knownPlatforms = platforms;
    this.buildToolbar();
  }

  getFeedViewMode(): "grid" | "feed" {
    return this.feedMode.getViewMode();
  }

  refreshFeedEntries(filter: RoostFilter): void {
    this.feedMode.refreshEntries(filter);
  }

  getCardSize(): number {
    return (this.config?.get?.("cardSize") as number) ?? 180;
  }

  getEntries(): BasesEntry[] | undefined {
    return this.data?.data;
  }

  get cfgImagePropId(): string {
    return this.cfg.imagePropId;
  }

  resolveImageUrl(entry: BasesEntry, propId: string): string | null {
    return galleryResolveImageUrl(this.app, entry, propId);
  }

  syncViewModeForFilter(filter: RoostFilter): void {
    this.feedMode.syncViewModeForFilter(filter);
  }

  refreshFeedIfActive(filter: RoostFilter): void {
    if (this.feedMode.getViewMode() === "feed") {
      this.feedMode.refreshEntries(filter);
    }
  }

  pushFilterHistory(filter: RoostFilter, pushHistory: boolean): void {
    if (pushHistory) this.filterHistory.push(filter);
  }

  setCurrentFilter(filter: RoostFilter): void {
    this.currentFilter = filter;
  }

  setMatchState(
    matched: Set<string> | null,
    detail: Map<string, MatchDetail> | null,
  ): void {
    this.matchedRoostIds = matched;
    this.matchDetailMap = detail;
  }

  applyFolderResult(result: GalleryFolderFilterApplied): void {
    this.filteredIndices = result.filteredIndices;
    this.renderedKey = result.renderedKey;
  }

  applyLayoutState(layout: GalleryFilterIndicesResult): void {
    const human = this.humanAssignedRoostIds ?? new Set<string>();
    const entries = this.getAllEntries();
    this.splitMode = layout.splitMode;
    this.uncertainRoostIds = layout.uncertainRoostIds;
    // In split mode, apply green-last within each pane separately so human
    // items sink to the bottom of Certain and Uncertain independently.
    if (layout.splitMode && layout.certainIndicesSplit && layout.uncertainIndicesSplit) {
      const certain = sinkGreenIndices(layout.certainIndicesSplit, entries, human);
      const uncertain = sinkGreenIndices(layout.uncertainIndicesSplit, entries, human);
      this.certainIndicesSplit = certain;
      this.uncertainIndicesSplit = uncertain;
      this.filteredIndices = [...certain, ...uncertain];
    } else {
      this.certainIndicesSplit = layout.certainIndicesSplit;
      this.uncertainIndicesSplit = layout.uncertainIndicesSplit;
      this.filteredIndices = layout.filteredIndices
        ? sinkGreenIndices(layout.filteredIndices, entries, human)
        : null;
    }
  }

  clearPinnedRoostIds(): void {
    this.pinnedRoostIds = null;
  }

  clearRenderedKey(): void {
    this.renderedKey = "";
  }

  setReapplyingFilter(active: boolean): void {
    this.reapplyingFilter = active;
  }

  takePendingFocusId(): string | null {
    const id = this.pendingFocusId;
    this.pendingFocusId = null;
    return id;
  }

  onFolderDrillDown(folder: { id?: string; name: string; itemIds: string[] }): void {
    const p = this.getRoostPlugin();
    if (p) {
      p.setFilter({ itemIds: folder.itemIds, groupId: folder.id ?? folder.name });
    }
  }

  prepareFolderRender(): void {
    this.renderedKey = "";
    this.hydrationObserver?.disconnect();
  }

  findEntryByRoostId(roostId: string): BasesEntry | null {
    return findGalleryEntryByRoostId(this.getAllEntries(), roostId);
  }

  async confirmAuto(roostId: string): Promise<void> {
    const entry = this.findEntryByRoostId(roostId);
    const file = entry ? this.app.vault.getFileByPath(entry.file.path) : null;
    const guess = entry ? readGuess(entry).category : null;
    if (!entry || !file || !guess) return;
    try {
      await confirmAutoItem(
        { vault: this.app.vault, fileManager: this.app.fileManager, file, id: roostId, now: Date.now() },
        guess,
      );
    } catch (e) {
      console.warn("[roost] confirmAuto failed:", e);
    }
  }

  async rejectAuto(roostId: string): Promise<void> {
    const entry = this.findEntryByRoostId(roostId);
    const file = entry ? this.app.vault.getFileByPath(entry.file.path) : null;
    const guess = entry ? readGuess(entry).category : null;
    if (!entry || !file || !guess) return;
    try {
      await rejectAutoItem(
        { vault: this.app.vault, fileManager: this.app.fileManager, file, id: roostId, now: Date.now() },
        guess,
      );
    } catch (e) {
      console.warn("[roost] rejectAuto failed:", e);
    }
  }

  // ── Review-pass host methods (Task 6) ──────────────────────────────────────
  // Each write follows the confirmAutoItem/rejectAutoItem pattern: preseed snapshot →
  // persist training-set + eval → write frontmatter.  After the write, the id is
  // added to humanAssignedRoostIds so the grid card greens + sinks on the next repaint.

  async reviewConfirm(roostId: string, category: string): Promise<void> {
    const entry = this.findEntryByRoostId(roostId);
    const file = entry ? this.app.vault.getFileByPath(entry.file.path) : null;
    if (!entry || !file) return;
    try {
      const now = Date.now();
      const deps: TrainingActionDeps = { vault: this.app.vault, fileManager: this.app.fileManager, file, id: roostId, now };
      const ts = loadTrainingSet(deps.vault);
      const { evalRecord, patch, snapshotValue } = planReviewConfirm(ts, roostId, category, now);
      const snap = loadSnapshot(deps.vault);
      snap[roostId] = snapshotValue;
      saveSnapshot(deps.vault, snap);
      saveTrainingSet(deps.vault, ts);
      appendEvalRecords(deps.vault, [evalRecord]);
      await deps.fileManager.processFrontMatter(file, (fm) => { Object.assign(fm, patch); });
      if (!this.humanAssignedRoostIds) this.humanAssignedRoostIds = new Set();
      this.humanAssignedRoostIds.add(roostId);
      this.onDataUpdated();
    } catch (e) {
      console.warn("[roost] reviewConfirm failed:", e);
    }
  }

  async reviewMove(roostId: string, category: string): Promise<void> {
    const entry = this.findEntryByRoostId(roostId);
    const file = entry ? this.app.vault.getFileByPath(entry.file.path) : null;
    if (!entry || !file) return;
    try {
      const now = Date.now();
      const deps: TrainingActionDeps = { vault: this.app.vault, fileManager: this.app.fileManager, file, id: roostId, now };
      const ts = loadTrainingSet(deps.vault);
      const { evalRecord, patch, snapshotValue } = planCorrection(ts, roostId, category, now);
      const snap = loadSnapshot(deps.vault);
      snap[roostId] = snapshotValue;
      saveSnapshot(deps.vault, snap);
      saveTrainingSet(deps.vault, ts);
      appendEvalRecords(deps.vault, [evalRecord]);
      await deps.fileManager.processFrontMatter(file, (fm) => { Object.assign(fm, patch); });
      if (!this.humanAssignedRoostIds) this.humanAssignedRoostIds = new Set();
      this.humanAssignedRoostIds.add(roostId);
      this.onDataUpdated();
    } catch (e) {
      console.warn("[roost] reviewMove failed:", e);
    }
  }

  async reviewReject(roostId: string): Promise<void> {
    const entry = this.findEntryByRoostId(roostId);
    const file = entry ? this.app.vault.getFileByPath(entry.file.path) : null;
    const guess = entry ? readGuess(entry).category : null;
    if (!entry || !file || !guess) return;
    try {
      await rejectAutoItem(
        { vault: this.app.vault, fileManager: this.app.fileManager, file, id: roostId, now: Date.now() },
        guess,
      );
      if (!this.humanAssignedRoostIds) this.humanAssignedRoostIds = new Set();
      this.humanAssignedRoostIds.add(roostId);
      this.onDataUpdated();
    } catch (e) {
      console.warn("[roost] reviewReject failed:", e);
    }
  }

  /** Open a fuzzy category picker for the review-pass move action.
   *  Shows Smart Assign proposed folders first, then any additional vault categories.
   *  Calls onCategory with the picked id; the caller (controller) then runs reviewMove. */
  openReviewMoveModal(entry: BasesEntry, onCategory: (category: string) => Promise<void>): void {
    void entry; // entry available for future preview enhancement; unused here
    const plugin = this.getRoostPlugin();
    const proposed: { id: string; name: string }[] = plugin?.proposedFolderNames ?? [];
    const proposedIds = new Set(proposed.map(f => f.id));
    const vault = this.getVaultCategories();
    const all: { id: string; name: string }[] = [
      ...proposed,
      ...vault.filter(c => !proposedIds.has(c.id)),
    ];
    const app = this.app;
    class ReviewMoveModal extends FuzzySuggestModal<{ id: string; name: string }> {
      getItems() { return all; }
      getItemText(item: { id: string; name: string }) { return item.name; }
      onChooseItem(item: { id: string; name: string }) { void onCategory(item.id); }
    }
    const modal = new ReviewMoveModal(app);
    modal.setPlaceholder("Move to category…");
    modal.open();
  }

  openMoveModal(entry: BasesEntry): void {
    openGalleryMoveModal(
      {
        app: this.app,
        cfg: this.cfg,
        getRoostPlugin: () => this.getRoostPlugin(),
        getAllEntries: () => this.data.data,
        resolveVideoUrl: (e) => galleryResolveVideoUrl(this.app, e),
        resolveImageUrl: (e, propId) => galleryResolveImageUrl(this.app, e, propId),
        resolveAllImages: (e) => galleryResolveAllImages(this.app, e),
        enterSelectionMode: (ids, target, onAccept) =>
          this.enterSelectionMode(ids, target, onAccept),
        onEntryRemovedFromGallery: (e) => {
          const entryIdx = this.data?.data?.indexOf(e);
          if (entryIdx != null && entryIdx >= 0 && this.filteredIndices) {
            this.filteredIndices = this.filteredIndices.filter(i => i !== entryIdx);
            this.renderedKey = "";
            this.onDataUpdated();
          }
        },
      },
      entry,
    );
  }

  constructor(controller: QueryController, scrollEl: HTMLElement) {
    super(controller);
    const shell = mountGalleryViewShell(scrollEl);
    this.toolbarEl = shell.toolbarEl;
    this.scrollEl = shell.scrollEl;
    this.containerEl = shell.containerEl;
    this.selectionBar = shell.selectionBar;
    this.gallerySelection = new GallerySelectionController(this);
    showGalleryInitialSkeletons(
      this.containerEl,
      (this.config?.get?.("cardSize") as number) ?? 180,
      (this.config?.get?.("imageRatio") as number) ?? 75,
    );

    this.bulkWrite.tryAttach();
    this.feedMode = new GalleryFeedModeController(this);
    this.pipelineHost = createBookmarksPipelineHost({
      app: this.app,
      containerEl: this.containerEl,
      scrollEl: this.scrollEl,
      cfg: this.cfg,
      getFeedSplitHostEl: () => this.feedMode.getFeedSplitHostEl(),
      getFilter: () => this.currentFilter,
      getEntries: () => this.data?.data ?? [],
      getFilteredIndices: () => this.filteredIndices,
      getRoostPlugin: () => this.getRoostPlugin(),
      mediaResolvers: () => galleryMediaResolvers(this.app, this.cfg),
      onRerender: () => {
        this.renderedKey = "";
        this.onDataUpdated();
      },
      onPinAndFocus: (roostId) => {
        this.pinnedRoostIds = new Set([roostId]);
        this.pendingFocusId = roostId;
      },
      onSetFeedActive: (roostId) => this.feedMode.setFeedActiveFromGrid(roostId),
      onMove: (entry) => this.openMoveModal(entry),
    });
  }

  buildToolbar(): void {
    if (!this.toolbarEl) return;
    renderGalleryToolbar(
      this.toolbarEl,
      {
        filter: this.currentFilter,
        filterHistoryIndex: this.filterHistory.getIndex(),
        filterHistoryLength: this.filterHistory.getLength(),
        knownPlatforms: this.knownPlatforms,
        activePlatformFilter: this.activePlatformFilter,
        viewMode: this.feedMode.getViewMode(),
      },
      {
        onNavigateBack: () => this.filterHistory.navigateBack(),
        onNavigateForward: () => this.filterHistory.navigateForward(),
        onPlatformFilterChange: (platform) => {
          this.activePlatformFilter = platform;
          this.buildToolbar();
          this.applyFilter(this.currentFilter, false);
        },
        onViewModeToggle: () => this.feedMode.toggleViewMode(),
      },
    );
    // Training mode is toggled from the in-pane "Train" button inside the feed
    // (mountFeedTrainToggle) — no separate toolbar button needed.
  }

  enterSelectionMode(itemIds: string[], targetName: string, onAccept: (ids: string[]) => void): void {
    this.gallerySelection.enter(itemIds, targetName, onAccept);
  }

  onload(): void {
    if (this.renderedKey === "") {
      applyGalleryGridStyle(
        this.containerEl,
        (this.config?.get?.("cardSize") as number) ?? 180,
      );
    }

    const subs = attachGalleryPluginSubscriptions({
      getRoostPlugin: () => this.getRoostPlugin(),
      getCurrentFilter: () => this.currentFilter,
      applyFilter: (filter, pushHistory) => this.applyFilter(filter, pushHistory),
      onDataUpdated: () => this.onDataUpdated(),
    });
    this.unsubFilter = subs.unsubFilter;
    this.unsubDataRefresh = subs.unsubDataRefresh;
    this.hydrationObserver = createGalleryHydrationObserver((el, index) =>
      this.hydrateCard(el, index),
    );

    // Make scroll container focusable for ⌘A/Esc keyboard shortcuts.
    this.scrollEl.tabIndex = 0;

    // ⌘A / Ctrl-A — select all visible cards.
    this.registerDomEvent(this.scrollEl as HTMLElement, "keydown", (e: KeyboardEvent) => {
      if (this.gallerySelection.isActive()) return; // enter mode handles its own keys
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        this.gallerySelection.selectAll(this.getOrderedVisibleRoostIds());
      } else if (e.key === "Escape") {
        this.gallerySelection.clear();
      }
    });

    // Click on empty grid space (the container itself, not a card) → clear selection.
    this.registerDomEvent(this.containerEl, "click", (e: MouseEvent) => {
      if (e.target === this.containerEl) {
        this.gallerySelection.clear();
      }
    });

    // Delegate contextmenu to the container so we catch right-clicks anywhere on a card.
    this.registerDomEvent(this.containerEl, "contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      const target = (e.target as HTMLElement).closest("[data-roost-id]") as HTMLElement | null;
      if (!target) {
        // Right-click on empty space — clear selection.
        this.gallerySelection.clear();
        return;
      }
      const roostId = target.dataset.roostId;
      if (roostId) this.handleCardContextMenu(roostId, e);
    });
  }

  onunload(): void {
    this.dataUpdateTrigger?.cancel();
    this.dataUpdateTrigger = null;
    this.feedMode.dispose();
    this.hydrationObserver?.disconnect();
    this.hydrationObserver = null;
    this.unsubFilter?.();
    this.unsubFilter = null;
    this.unsubDataRefresh?.();
    this.unsubDataRefresh = null;
    this.bulkWrite.dispose();
    this.pipelineHost.dispose();
  }

  private applyFilter(filter: RoostFilter, pushHistory = true): void {
    applyGalleryFilter(bindGalleryApplyFilterHost(this), filter, pushHistory);
  }

  expandFocusHost(): GalleryExpandFocusHost {
    return {
      containerEl: this.containerEl,
      scrollEl: this.scrollEl,
      expandState: this.expandState,
      hydrateCard: (el, index) => this.hydrateCard(el, index),
      getEntryByIndex: (index) => this.getEntryByIndex(index),
      toggleExpandedCard: (cardEl, entry) => this.toggleExpandedCard(cardEl, entry),
    };
  }

  private toggleExpandedCard(cardEl: HTMLElement, entry: BasesEntry): void {
    void toggleGalleryExpanded(this.expandState, cardEl, {
      app: this.app,
      entry,
      domHost: this.containerEl,
      matchDetailMap: this.matchDetailMap,
      mediaResolvers: galleryMediaResolvers(this.app, this.cfg),
      onPipelineExpand: (id) => this.pipelineHost.getHandle()?.onExpand?.(id),
      onCollectionClick: (e) => this.openMoveModal(e),
      onMove: (e) => this.openMoveModal(e),
      onDelete: (roostId) => {
        const plugin = this.getRoostPlugin();
        if (!plugin) return;
        const entries = this.data?.data;
        this.pendingExpandInPlaceId = entries
          ? findNeighborRoostId(entries, this.filteredIndices, roostId)
          : null;
        plugin.fireItemClick({ action: "delete", roostId });
      },
    });
  }

  private dataUpdateTrigger: CoalescingTrigger | null = null;

  onDataUpdated(): void {
    const plugin = this.getRoostPlugin();
    traceEvent("onDataUpdated:enter", {
      bulkWriteInProgress: plugin?.bulkWriteInProgress ?? false,
      reapplyingFilter: this.reapplyingFilter,
      currentFilterCategory: this.currentFilter?.category ?? null,
      dataLen: this.data?.data?.length ?? 0,
    });
    if (plugin?.bulkWriteInProgress) {
      traceEvent("onDataUpdated:guarded");
      return;
    }

    // Coalesce the repaint. Obsidian fires onDataUpdated in a STORM while it re-indexes
    // externally-changed files (e.g. after a bulk vault write / the tag migration). The
    // bulkWriteInProgress guard above only covers Roost's OWN writes, not Obsidian's
    // re-index — so without coalescing the grid repaints on every event and strobes.
    // Leading edge keeps single updates immediate; the burst collapses to one trailing paint.
    if (this.dataUpdateTrigger === null) {
      this.dataUpdateTrigger = createCoalescingTrigger(
        () => this.performDataUpdate(),
        GALLERY_DATA_UPDATE_DEBOUNCE_MS,
      );
    }
    this.dataUpdateTrigger.trigger();
  }

  private performDataUpdate(): void {
    // Re-check the guard: a Roost bulk write may have begun during the coalescing window.
    if (this.getRoostPlugin()?.bulkWriteInProgress) {
      traceEvent("onDataUpdated:guarded");
      return;
    }

    this.bulkWrite.tryAttach();

    if (this.currentFilter && !this.reapplyingFilter) {
      this.applyFilter(this.currentFilter, false);
      return;
    }

    rebuildGalleryGrid(
      bindGalleryGridRenderHost(bindGalleryGridStateSource(this)),
    );
  }

  private galleryCardHandlers() {
    const self = this;
    return {
      get viewMode() { return self.feedMode.getViewMode(); },
      expandState: this.expandState,
      uncertainRoostIds: this.uncertainRoostIds,
      matchedRoostIds: this.matchedRoostIds,
      matchDetailMap: this.matchDetailMap,
      humanAssignedRoostIds: this.humanAssignedRoostIds,
      isSelectionActive: () => this.gallerySelection.isActive(),
      isSelected: (id: string) => this.gallerySelection.isSelected(id),
      onSelectionToggle: (id: string, cardEl: HTMLElement) => this.gallerySelection.toggle(id, cardEl),
      onFeedSelect: (id: string) => this.feedMode.setFeedActiveFromGrid(id),
      onExpand: (cardEl: HTMLElement, entry: BasesEntry) => this.toggleExpandedCard(cardEl, entry),
      resolveImageUrl: (entry: BasesEntry, propId: string) => galleryResolveImageUrl(this.app, entry, propId),
      resolveVideoUrl: (entry: BasesEntry) => galleryResolveVideoUrl(this.app, entry),
      hasMultipleImages: (entry: BasesEntry) => galleryHasMultipleImages(this.app, entry),
      isTextTileCover: (entry: BasesEntry) => galleryIsTextTileCover(this.app, entry),
      resolveExcerpt: (entry: BasesEntry) => getExplorerExcerpt(entry.file, this.app),
      pipelineTypeForEntry: (entry: BasesEntry) => pipelineTypeFromFrontmatter(this.app.metadataCache.getFileCache(entry.file)?.frontmatter ?? {}),
      onOpenLink: (url: string) => { void openLinkInView(this.app, url); },
      onSelect: (roostId: string, e: MouseEvent) => {
        if (e.shiftKey) {
          this.gallerySelection.selectRange(roostId, this.getOrderedVisibleRoostIds());
        } else if (e.metaKey || e.ctrlKey) {
          this.gallerySelection.toggleId(roostId);
        } else {
          this.gallerySelection.selectSingle(roostId);
        }
      },
    };
  }

  // Public: GalleryGridViewBind calls this during grid rebuild.
  createPlaceholder(parent: HTMLElement, index: number, height: number): void {
    createGalleryPlaceholder(parent, index, height, this.hydrationObserver);
  }

  private hydrateCard(el: HTMLElement, index: number): void {
    const entry = this.getEntryByIndex(index);
    if (!entry) return;
    hydrateGalleryCard(el, entry, this.cfg, this.galleryCardHandlers());
  }

  private getEntryByIndex(index: number): BasesEntry | null {
    if (!this.data?.data) return null;
    return galleryEntryAtIndex(this.data, this.filteredIndices, index);
  }

  applyGridStyle(cardSize: number, target?: HTMLElement): void {
    applyGalleryGridStyle(target ?? this.containerEl, cardSize);
  }

  expandInPlaceById(roostId: string): void {
    expandGalleryInPlaceById(this.expandFocusHost(), roostId);
  }

  shouldRenderPipelineSubstitute(): boolean {
    if (!isPipelineSubstituteView(this.currentFilter)) return false;
    const category = this.currentFilter?.category;
    if (!category) return false;
    const plugin = this.getRoostPlugin();
    if (!plugin) return false;
    return isCategoryPipelineActive(category, plugin);
  }

  syncKeptGalleryCard(card: HTMLElement, entry: BasesEntry): void {
    syncGalleryCardFromEntry(card, entry, {
      uncertainRoostIds: this.uncertainRoostIds,
      matchedRoostIds: this.matchedRoostIds,
      matchDetailMap: this.matchDetailMap,
    });
  }

  dispatchPipelineGalleryView(): boolean {
    return this.pipelineHost.dispatch();
  }

  /** Ordered roostIds of all currently-rendered (hydrated) cards. */
  private getOrderedVisibleRoostIds(): string[] {
    return Array.from(this.containerEl.querySelectorAll("[data-roost-id]"))
      .map(el => (el as HTMLElement).dataset.roostId!)
      .filter(Boolean);
  }

  /** Unique, sorted vault category names derived from entry frontmatter. */
  private getVaultCategories(): { id: string; name: string }[] {
    const cats = new Set<string>();
    for (const e of this.getAllEntries()) {
      const cat = safeGetValue(e, `note.${CATEGORY_FIELD}`)?.toString();
      if (cat && cat !== "null" && cat !== "undefined") cats.add(cat);
    }
    return [...cats].sort().map(name => ({ id: name, name }));
  }

  /**
   * Build and show the Finder-style right-click context menu for the gallery.
   * If the right-clicked card was NOT already selected, Finder-selects it first.
   */
  private handleCardContextMenu(roostId: string, e: MouseEvent): void {
    const plugin = this.getRoostPlugin();
    if (!plugin) return;

    // Finder rule: if the right-clicked card is NOT selected, select it alone.
    if (!this.gallerySelection.has(roostId)) {
      this.gallerySelection.selectSingle(roostId);
    }

    const selectedIds = this.gallerySelection.getSelected();
    const n = selectedIds.length;
    const nLabel = n === 1 ? "" : ` ${n}`;

    const menu = new Menu();

    // Reject selected
    menu.addItem(item => item
      .setTitle(`Reject${nLabel} selected`)
      .setIcon("x-circle")
      .onClick(() => {
        plugin.fireItemClick({ action: "rejectItems", itemIds: [...selectedIds] });
        this.gallerySelection.clear();
      }),
    );

    menu.addSeparator();

    // Move selected to… (staging groups or vault categories)
    const groupId = plugin.activeFilter?.groupId;
    if (groupId) {
      // Smart Assign staging mode: list proposed folders from the plugin.
      const proposed = plugin.proposedFolderNames ?? [];
      for (const folder of proposed) {
        if (folder.id === groupId) continue; // skip the currently-viewed group
        const fId = folder.id;
        const fName = folder.name;
        menu.addItem(item => item
          .setTitle(`Move${nLabel} selected to "${fName}"`)
          .setIcon("folder-input")
          .onClick(() => {
            plugin.fireItemClick({ action: "moveItems", itemIds: [...selectedIds], to: fId });
            this.gallerySelection.clear();
          }),
        );
      }
    } else {
      // Library / plain gallery mode: list vault categories.
      const categories = this.getVaultCategories();
      for (const { id: catId, name: catName } of categories) {
        menu.addItem(item => item
          .setTitle(`Move${nLabel} selected to "${catName}"`)
          .setIcon("folder-input")
          .onClick(() => {
            plugin.fireItemClick({ action: "moveItems", itemIds: [...selectedIds], to: catId });
            this.gallerySelection.clear();
          }),
        );
      }
    }

    menu.addSeparator();

    // Delete selected
    menu.addItem(item => item
      .setTitle(`Delete${nLabel} selected…`)
      .setIcon("trash-2")
      .setWarning(true)
      .onClick(() => {
        plugin.fireItemClick({ action: "deleteItems", roostIds: [...selectedIds] });
        this.gallerySelection.clear();
      }),
    );

    menu.showAtMouseEvent(e);
  }
}
