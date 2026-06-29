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
import { filterTrainingEntries } from "@/views/feed/training-mode";

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

/** After a judged item leaves the filtered queue, pick the next active roostId:
 *  the item now occupying the judged index, clamped to the last item; null if empty. */
export function computeAdvance(remainingIds: string[], judgedIndex: number): string | null {
  if (remainingIds.length === 0) return null;
  const i = Math.min(judgedIndex, remainingIds.length - 1);
  return remainingIds[i];
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
  confirmAuto(roostId: string): Promise<void>;
  rejectAuto(roostId: string): Promise<void>;
}

export class GalleryFeedModeController {
  viewMode: "grid" | "feed" = "grid";
  feedAutoOpenedForMedia = false;
  trainingMode = false;

  private feedSplitMount: FeedSplitMount | null = null;
  private feedHandle: FeedPanelHandle | null = null;
  private readonly feedSync: FeedSync = createFeedSync();
  private feedSyncUnsub: (() => void) | null = null;
  private lastFeedFilterKey: string | null = null;
  private skipped = new Set<string>();
  private lastActiveRoostId: string | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private lastTrainingEntries: BasesEntry[] = [];

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

  setTrainingMode(on: boolean): void {
    if (this.trainingMode === on) return;
    this.trainingMode = on;
    if (on) {
      if (this.viewMode !== "feed") {
        // Force feed mode — enterFeedMode will use trainingEntries and register keyboard
        this.setViewMode("feed");
        return; // setViewMode already called onViewModeChanged
      }
      // Already in feed mode — refresh entries and register keyboard
      const entries = this.trainingEntries();
      this.lastTrainingEntries = entries;
      this.feedHandle?.setEntries(entries, this.feedSync.get());
      this.registerKeyboard();
    } else {
      this.deregisterKeyboard();
      if (this.feedHandle) {
        this.feedHandle.setEntries(this.host.getScopedEntries(), this.feedSync.get());
      }
      this.lastTrainingEntries = [];
    }
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
    const entries = this.trainingMode ? this.trainingEntries() : this.host.getScopedEntries();
    if (this.trainingMode) this.lastTrainingEntries = entries;
    this.feedHandle.setEntries(entries, preferred);
  }

  dispose(): void {
    if (this.viewMode === "feed") this.exitFeedMode();
  }

  private trainingEntries(): BasesEntry[] {
    return filterTrainingEntries(this.host.getScopedEntries(), this.skipped);
  }

  private advanceAfterAction(judgedId: string): void {
    const judgedIndex = this.lastTrainingEntries.map(e => getRoostId(e)).indexOf(judgedId);
    const remaining = this.trainingEntries();
    this.lastTrainingEntries = remaining;
    this.feedHandle?.setEntries(
      remaining,
      computeAdvance(remaining.map(e => getRoostId(e)), judgedIndex >= 0 ? judgedIndex : 0),
    );
  }

  private handleTrainingAction(
    action: "confirm" | "reject" | "recategorize" | "skip",
    roostId: string,
  ): void {
    if (action === "skip") {
      this.skipped.add(roostId);
      this.advanceAfterAction(roostId);
      return;
    }
    if (action === "recategorize") {
      const entry = this.host.findEntryByRoostId(roostId);
      if (entry) this.host.openMoveModal(entry);
      this.advanceAfterAction(roostId);
      return;
    }
    const p = action === "confirm" ? this.host.confirmAuto(roostId) : this.host.rejectAuto(roostId);
    void p.then(() => this.advanceAfterAction(roostId));
  }

  private registerKeyboard(): void {
    this.deregisterKeyboard();
    const handler = (e: KeyboardEvent) => {
      if (!this.trainingMode || !this.lastActiveRoostId) return;
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "y" || e.key === "Y") {
        this.handleTrainingAction("confirm", this.lastActiveRoostId);
      } else if (e.key === "n" || e.key === "N") {
        this.handleTrainingAction("reject", this.lastActiveRoostId);
      } else if (e.key === "s" || e.key === "S") {
        this.handleTrainingAction("skip", this.lastActiveRoostId);
      }
    };
    this.keydownHandler = handler;
    document.addEventListener("keydown", handler);
  }

  private deregisterKeyboard(): void {
    if (this.keydownHandler) {
      document.removeEventListener("keydown", this.keydownHandler);
      this.keydownHandler = null;
    }
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
      trainingMode: this.trainingMode,
      onTrainingAction: (action, roostId) => {
        this.handleTrainingAction(action, roostId);
      },
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

    const initialEntries = this.trainingMode ? this.trainingEntries() : this.host.getScopedEntries();
    if (this.trainingMode) this.lastTrainingEntries = initialEntries;

    this.feedHandle = mountFeedPanel(
      this.feedSplitMount.rightPane,
      ctx,
      this.feedSync,
      initialEntries,
    );

    this.feedSyncUnsub = this.feedSync.subscribe((roostId, source) => {
      this.lastActiveRoostId = roostId;
      this.applyFeedActiveHighlight(roostId);
      if (roostId && source === "feed") this.scrollGalleryCardIntoView(roostId);
    });

    if (this.trainingMode) {
      this.registerKeyboard();
    }
  }

  private exitFeedMode(): void {
    this.deregisterKeyboard();
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
