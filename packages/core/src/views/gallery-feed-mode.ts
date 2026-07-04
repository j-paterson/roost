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
import { filterTrainingEntries, readGuess } from "@/views/feed/training-mode";

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

/** Pure: filter and order allEntries by reviewPassIds, excluding skipped.
 *  Entries not present in allEntries are silently dropped. */
export function computeReviewPassEntries(
  reviewPassIds: string[],
  allEntries: BasesEntry[],
  skipped: Set<string>,
): BasesEntry[] {
  const byId = new Map<string, BasesEntry>();
  for (const e of allEntries) byId.set(getRoostId(e), e);
  return reviewPassIds
    .filter(id => !skipped.has(id))
    .map(id => byId.get(id))
    .filter((e): e is BasesEntry => e !== undefined);
}

export interface GalleryFeedModeHost {
  app: App;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  scrollCardIntoView(roostId: string): void;
  getImagePropId(): string;
  getScopedEntries(): BasesEntry[];
  getAllEntries(): BasesEntry[];
  getRoostPlugin(): IRoostPlugin | null;
  findEntryByRoostId(roostId: string): BasesEntry | null;
  openMoveModal(entry: BasesEntry): void;
  onViewModeChanged(): void;
  confirmAuto(roostId: string): Promise<void>;
  rejectAuto(roostId: string): Promise<void>;
  // Review-pass actions (Task 6): commit-as-you-go writes + humanAssignedRoostIds tracking.
  reviewConfirm(roostId: string, category: string): Promise<void>;
  /** originalGuess is the system's proposed category being corrected; null when unknown. */
  reviewMove(roostId: string, category: string, originalGuess: string | null): Promise<void>;
  reviewReject(roostId: string): Promise<void>;
  openReviewMoveModal(entry: BasesEntry, onCategory: (category: string) => Promise<void>): void;
}

export class GalleryFeedModeController {
  viewMode: "grid" | "feed" = "grid";
  feedAutoOpenedForMedia = false;
  trainingMode = false;
  /** When non-null the controller is in review-pass mode: feed entries are seeded from
   *  these ids (ordered by the gallery grid) instead of filterTrainingEntries. */
  reviewPassIds: string[] | null = null;
  /** roostId → proposed folder.name; set by startReviewPass, used in confirm to avoid
   *  reading stale frontmatter. Null when not in a review pass. */
  reviewProposals: Record<string, string> | null = null;

  private feedSplitMount: FeedSplitMount | null = null;
  private feedHandle: FeedPanelHandle | null = null;
  private feedTrainToggle: HTMLButtonElement | null = null;
  private readonly feedSync: FeedSync = createFeedSync();
  private feedSyncUnsub: (() => void) | null = null;
  private lastFeedFilterKey: string | null = null;
  private skipped = new Set<string>();
  private inFlight = new Set<string>();
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
    if (this.trainingMode === on) {
      // trainingMode can be left ON with the feed closed (exiting via the
      // view-mode toggle doesn't clear it). Re-requesting training mode must
      // still open the feed, or "Review Pass" silently does nothing.
      if (on && this.viewMode !== "feed") this.setViewMode("feed");
      return;
    }
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
      // Clear review-pass state so a subsequent setTrainingMode(true) without
      // startReviewPass yields filterTrainingEntries, not the stale review queue.
      this.reviewPassIds = null;
      this.reviewProposals = null;
      if (this.feedHandle) {
        this.feedHandle.setEntries(this.host.getScopedEntries(), this.feedSync.get());
      }
      this.lastTrainingEntries = [];
    }
    this.syncFeedTrainToggle();
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

  /** Enter review-pass mode: seed the feed from pre-ordered proposal ids (ordered
   *  by the gallery grid at the call site). Must be called while trainingMode is on
   *  (or before entering training mode).
   *  proposalMap is roostId → proposed folder.name so confirm can use the proposed
   *  category rather than (potentially absent or stale) frontmatter. */
  startReviewPass(ids: string[], proposalMap?: Record<string, string>): void {
    this.reviewPassIds = ids;
    this.reviewProposals = proposalMap ?? null;
    this.skipped = new Set();
    if (this.trainingMode) {
      const entries = this.trainingEntries();
      this.lastTrainingEntries = entries;
      this.feedHandle?.setEntries(entries, this.feedSync.get());
    }
  }

  /** Belt-and-suspenders reset called from the host (setMatchState) when a new Smart
   *  Assign run begins, so stale reviewPassIds from a prior pass never leak into the
   *  next regular Train session. */
  resetReviewPass(): void {
    this.reviewPassIds = null;
    this.reviewProposals = null;
  }

  private trainingEntries(): BasesEntry[] {
    if (this.reviewPassIds !== null) {
      return computeReviewPassEntries(this.reviewPassIds, this.host.getAllEntries(), this.skipped);
    }
    return filterTrainingEntries(this.host.getScopedEntries(), this.skipped);
  }

  private advanceAfterAction(judgedId: string): void {
    if (!this.trainingMode) return;
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
    if (!this.trainingMode) return;
    // Review-pass mode: different action semantics (planReviewConfirm / planCorrection /
    // planReject with humanAssignedRoostIds tracking). Route to dedicated handler.
    if (this.reviewPassIds !== null) {
      this.handleReviewPassAction(action, roostId);
      return;
    }
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
    if (this.inFlight.has(roostId)) return;
    this.inFlight.add(roostId);
    // Drop the item from the queue immediately (like skip): the frontmatter change is
    // async and the Bases data refreshes later (and can even change scope), so we can't
    // rely on it disappearing from getScopedEntries() in time for a deterministic advance.
    this.skipped.add(roostId);
    const p = action === "confirm" ? this.host.confirmAuto(roostId) : this.host.rejectAuto(roostId);
    void p.finally(() => { this.inFlight.delete(roostId); this.advanceAfterAction(roostId); });
  }

  /** Review-pass action handler: confirm → planReviewConfirm, move → planCorrection,
   *  reject → planReject. Each action writes frontmatter immediately (commit-as-you-go),
   *  adds to humanAssignedRoostIds, and advances the feed. */
  private handleReviewPassAction(
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
      if (!entry) return;
      // skipped.add + advance happen inside the callback so a cancel (no callback)
      // leaves the item un-judged and still in the review queue.
      this.host.openReviewMoveModal(entry, async (category) => {
        this.skipped.add(roostId);
        // Pass the system's original guess so planCorrection can compute correct=false
        // when the user picks a different category.
        const originalGuess = this.reviewProposals?.[roostId] ?? (entry ? readGuess(entry).category : null);
        await this.host.reviewMove(roostId, category, originalGuess);
        this.advanceAfterAction(roostId);
      });
      return;
    }
    if (this.inFlight.has(roostId)) return;
    this.inFlight.add(roostId);
    this.skipped.add(roostId);
    let p: Promise<void>;
    if (action === "confirm") {
      const entry = this.host.findEntryByRoostId(roostId);
      // Prefer the proposal map (the category shown to the user) over frontmatter (which
      // may be stale or absent for uncategorized Smart-Assign items).
      const cat = (this.reviewProposals?.[roostId] ?? null) || (entry ? readGuess(entry).category : null);
      if (!cat) {
        // No proposal and no frontmatter category — cannot confirm; log and advance.
        console.warn("[roost] review-pass confirm: no category for", roostId, "— skipping");
        this.inFlight.delete(roostId);
        this.advanceAfterAction(roostId);
        return;
      }
      p = this.host.reviewConfirm(roostId, cat);
    } else {
      // reject
      p = this.host.reviewReject(roostId);
    }
    void p.finally(() => { this.inFlight.delete(roostId); this.advanceAfterAction(roostId); });
  }

  private registerKeyboard(): void {
    this.deregisterKeyboard();
    const handler = (e: KeyboardEvent) => {
      if (!this.trainingMode || !this.lastActiveRoostId) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
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

    const self = this;
    const ctx: FeedRenderContext = {
      app: this.host.app,
      imagePropId: this.host.getImagePropId(),
      get trainingMode() { return self.trainingMode; },
      // Review pass: supply the staged proposed category (frontmatter has none yet).
      guessFor: (roostId) => self.reviewProposals?.[roostId] ?? null,
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

    // Mount the scroller into a child host so the in-pane Train toggle can sit as an
    // absolute overlay on the pane (mountFeedPanel turns its container into the scroller).
    const scrollHost = this.feedSplitMount.rightPane.createDiv();
    this.feedHandle = mountFeedPanel(
      scrollHost,
      ctx,
      this.feedSync,
      initialEntries,
    );
    this.mountFeedTrainToggle(this.feedSplitMount.rightPane);

    this.feedSyncUnsub = this.feedSync.subscribe((roostId, source) => {
      this.lastActiveRoostId = roostId;
      if (roostId && source === "feed") this.scrollGalleryCardIntoView(roostId);
      this.applyFeedActiveHighlight(roostId);
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
    this.feedTrainToggle = null; // torn down with the split DOM
    this.feedSplitMount?.teardown();
    this.feedSplitMount = null;
    this.applyFeedActiveHighlight(null);
  }

  /** In-pane Train toggle: overlaid on the feed pane so training can be toggled from
   *  inside the feed (the gallery-toolbar button remains the entry point from grid view). */
  private mountFeedTrainToggle(pane: HTMLElement): void {
    const btn = pane.createEl("button", { cls: "roost-feed-train-toggle" });
    btn.addEventListener("click", () => this.setTrainingMode(!this.trainingMode));
    this.feedTrainToggle = btn;
    this.syncFeedTrainToggle();
  }

  private syncFeedTrainToggle(): void {
    const btn = this.feedTrainToggle;
    if (!btn) return;
    btn.classList.toggle("is-active", this.trainingMode);
    btn.setText(this.trainingMode ? "✓ Training" : "Train");
    btn.title = this.trainingMode ? "Exit training mode" : "Enter training mode";
  }

  private applyFeedActiveHighlight(roostId: string | null): void {
    const cards = this.host.containerEl.querySelectorAll<HTMLElement>(".roost-card");
    cards.forEach((el) => {
      const id = el.dataset.roostId;
      el.classList.toggle("roost-card-feed-active", id != null && id === roostId);
    });
  }

  private scrollGalleryCardIntoView(roostId: string): void {
    this.host.scrollCardIntoView(roostId);
  }

  private lookupPathByRoostId(roostId: string): string | null {
    for (const e of this.host.getAllEntries()) {
      if (getRoostId(e) === roostId) return e.file.path;
    }
    return null;
  }
}
