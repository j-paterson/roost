/**
 * Gallery feed split pane — grid + feed sync, Media auto-feed policy.
 */
import type { App, BasesEntry } from "obsidian";
import type { RoostFilter } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";
import { getRoostId } from "@/lib/bases-entry";
import { mountFeedPanel, type FeedPanelHandle } from "@/views/feed/feed-panel";
import { createFeedSync, type FeedSync } from "@/views/feed/feed-sync";
import type { FeedRenderContext } from "@/views/feed/feed-renderers";
import { mountFeedSplit, type FeedSplitMount } from "@/views/feed/feed-split-host";

const FEED_MIN_PANE_PX = 280;
const FEED_DEFAULT_GRID_RATIO = 0.35;

/** In-session persistence of the user's drag-adjusted pane ratio */
let lastFeedPaneRatio: number | null = null;

/** Stable string key for a filter's scope (category/subcategory/itemIds). */
function galleryFilterScopeKey(f: RoostFilter | null): string {
  if (!f) return "<all>";
  const cat = f.category ?? "";
  const sub = f.subcategory ?? "";
  const items = f.itemIds ? `[${[...f.itemIds].sort().join(",")}]` : "";
  return `${cat}|${sub}|${items}`;
}

export interface GalleryFeedModeHost {
  app: App;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  getImagePropId(): string;
  getScopedEntries(): BasesEntry[];
  getAllEntries(): BasesEntry[];
  getRoostPlugin(): IRoostPlugin | null;
  findEntryByRoostId(roostId: string): BasesEntry | null;
  openMoveModal(entry: BasesEntry): void;
  onViewModeChanged(): void;
}

export class GalleryFeedModeController {
  viewMode: "grid" | "feed" = "grid";
  feedAutoOpenedForMedia = false;

  private feedSplitMount: FeedSplitMount | null = null;
  private feedHandle: FeedPanelHandle | null = null;
  private readonly feedSync: FeedSync = createFeedSync();
  private feedSyncUnsub: (() => void) | null = null;
  private lastFeedFilterKey: string | null = null;

  constructor(private readonly host: GalleryFeedModeHost) {}

  getFeedSplitHostEl(): HTMLElement | null {
    return this.feedSplitMount?.hostEl ?? null;
  }

  getViewMode(): "grid" | "feed" {
    return this.viewMode;
  }

  /** Media list needs the feed pane; restore grid when leaving if we auto-opened. */
  syncViewModeForFilter(filter: RoostFilter): void {
    const isMedia = filter?.category === "Media";
    if (isMedia) {
      if (this.viewMode !== "feed") {
        this.setViewMode("feed");
        this.feedAutoOpenedForMedia = true;
      }
    } else if (this.feedAutoOpenedForMedia && this.viewMode === "feed") {
      this.setViewMode("grid");
      this.feedAutoOpenedForMedia = false;
    }
  }

  toggleViewMode(): void {
    this.setViewMode(this.viewMode === "feed" ? "grid" : "feed");
  }

  setViewMode(mode: "grid" | "feed"): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    if (mode === "feed") this.enterFeedMode();
    else this.exitFeedMode();
    this.host.onViewModeChanged();
  }

  setFeedActiveFromGrid(roostId: string): void {
    if (this.viewMode === "feed") this.feedSync.set(roostId, "grid");
  }

  refreshEntries(filter: RoostFilter | null): void {
    if (!this.feedHandle) return;
    const key = galleryFilterScopeKey(filter);
    const preferred = key === this.lastFeedFilterKey ? this.feedSync.get() : null;
    this.lastFeedFilterKey = key;
    this.feedHandle.setEntries(this.host.getScopedEntries(), preferred);
  }

  dispose(): void {
    if (this.viewMode === "feed") this.exitFeedMode();
  }

  private enterFeedMode(): void {
    const outerScrollEl = this.host.scrollEl.parentElement;
    if (!outerScrollEl) return;

    this.feedSplitMount = mountFeedSplit(outerScrollEl, this.host.scrollEl, {
      defaultRatio: lastFeedPaneRatio ?? FEED_DEFAULT_GRID_RATIO,
      minPanePx: FEED_MIN_PANE_PX,
      onRatioChange: (ratio) => {
        lastFeedPaneRatio = ratio;
      },
    });

    const ctx: FeedRenderContext = {
      app: this.host.app,
      imagePropId: this.host.getImagePropId(),
      onAction: (action, roostId) => {
        if (action === "open") {
          const path = this.lookupPathByRoostId(roostId);
          if (path) void this.host.app.workspace.openLinkText(path, "", true);
          return;
        }
        if (action === "delete") {
          this.host.getRoostPlugin()?.fireItemClick({ action: "delete", roostId });
          return;
        }
        if (action === "move") {
          const entry = this.host.findEntryByRoostId(roostId);
          if (entry) this.host.openMoveModal(entry);
        }
      },
    };

    this.feedHandle = mountFeedPanel(
      this.feedSplitMount.rightPane,
      ctx,
      this.feedSync,
      this.host.getScopedEntries(),
    );

    this.feedSyncUnsub = this.feedSync.subscribe((roostId, source) => {
      this.applyFeedActiveHighlight(roostId);
      if (roostId && source === "feed") this.scrollGalleryCardIntoView(roostId);
    });
  }

  private exitFeedMode(): void {
    this.feedSyncUnsub?.();
    this.feedSyncUnsub = null;
    this.feedHandle?.dispose();
    this.feedHandle = null;
    this.feedSplitMount?.teardown();
    this.feedSplitMount = null;
    this.applyFeedActiveHighlight(null);
  }

  private applyFeedActiveHighlight(roostId: string | null): void {
    const cards = this.host.containerEl.querySelectorAll<HTMLElement>(".roost-card");
    cards.forEach((el) => {
      const id = el.dataset.roostId;
      el.classList.toggle("roost-card-feed-active", id != null && id === roostId);
    });
  }

  private scrollGalleryCardIntoView(roostId: string): void {
    const card = this.host.containerEl.querySelector<HTMLElement>(
      `.roost-card[data-roost-id="${CSS.escape(roostId)}"]`,
    );
    if (card) card.scrollIntoView({ block: "nearest" });
  }

  private lookupPathByRoostId(roostId: string): string | null {
    for (const e of this.host.getAllEntries()) {
      if (getRoostId(e) === roostId) return e.file.path;
    }
    return null;
  }
}
