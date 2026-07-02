/**
 * Reusable windowed CSS-grid controller. Keeps only near-viewport cards mounted
 * between two full-width spacer <div>s that preserve total scroll height, so a
 * layout pass scales with visible cards, not total.
 *
 * Consumer-agnostic: view-specific rendering is injected via createPlaceholder /
 * syncKept. Grid children are always [topSpacer, ...cards…, bottomSpacer].
 */
import { computeGridWindow, parseColumnCount, type GridWindow } from "./compute-grid-window";

export interface WindowedCardGridOptions {
  scrollEl: HTMLElement;   // the overflow-y:auto scroller
  gridEl: HTMLElement;     // the CSS grid child of scrollEl
  rowHeight: () => number; // uniform px per row incl. gap
  count: () => number;     // total item count
  keyAt: (index: number) => string | null;                                 // stable key (roost_id)
  createPlaceholder: (parent: HTMLElement, index: number) => HTMLElement;   // injected per view
  syncKept?: (el: HTMLElement, index: number) => void;                      // refresh kept card metadata
  readColumns?: () => number;   // test seam; defaults to reading computed grid tracks
  bufferRows?: number;          // default 2
}

export class WindowedCardGrid {
  private readonly topSpacer: HTMLElement;
  private readonly bottomSpacer: HTMLElement;
  private enabled = true;

  constructor(private readonly opts: WindowedCardGridOptions) {
    this.topSpacer = this.makeSpacer("roost-grid-spacer-top");
    this.bottomSpacer = this.makeSpacer("roost-grid-spacer-bottom");
  }

  private makeSpacer(cls: string): HTMLElement {
    const el = document.createElement("div");
    el.className = cls;
    el.style.gridColumn = "1 / -1";
    el.style.height = "0px";
    return el;
  }

  private bufferRows(): number {
    return this.opts.bufferRows ?? 2;
  }

  /** Ensure spacers bracket the grid children (top first, bottom last). */
  private ensureSpacers(): void {
    const { gridEl } = this.opts;
    if (this.topSpacer.parentElement !== gridEl) gridEl.insertBefore(this.topSpacer, gridEl.firstChild);
    gridEl.appendChild(this.bottomSpacer); // appendChild moves it to last
  }

  /** Snapshot hydrated cards by key so a reseed can reuse them. */
  private snapshotKept(): Map<string, HTMLElement> {
    const map = new Map<string, HTMLElement>();
    for (const el of this.opts.gridEl.querySelectorAll<HTMLElement>(".roost-card-ready[data-roost-id]")) {
      map.set(el.dataset.roostId!, el);
    }
    return map;
  }

  /**
   * Reconcile the DOM to `win`. `reseed=false` is the index-stable scroll/resize
   * path; `reseed=true` rebuilds from the model keeping hydrated cards by key.
   */
  applyWindow(win: GridWindow, reseed = false): void {
    this.enabled = true;
    const { gridEl, keyAt, createPlaceholder, syncKept } = this.opts;
    this.ensureSpacers();

    const keptByKey = reseed ? this.snapshotKept() : null;

    // Index the currently-mounted cards.
    const mounted = new Map<number, HTMLElement>();
    for (const el of gridEl.querySelectorAll<HTMLElement>(".roost-card")) {
      const idx = Number(el.dataset.idx);
      if (!Number.isNaN(idx)) mounted.set(idx, el);
    }

    if (reseed) {
      // Detach all cards; the kept snapshot still holds the ones we may reuse.
      for (const el of mounted.values()) el.remove();
      mounted.clear();
    } else {
      // Drop cards that scrolled out of the window.
      for (const [idx, el] of mounted) {
        if (idx < win.windowStart || idx >= win.windowEnd) {
          el.remove();
          mounted.delete(idx);
        }
      }
    }

    // Place every desired index, in ascending order, just before the bottom spacer.
    for (let i = win.windowStart; i < win.windowEnd; i++) {
      let el = mounted.get(i);
      if (!el && keptByKey) {
        const key = keyAt(i);
        const reused = key ? keptByKey.get(key) : undefined;
        if (reused) {
          el = reused;
          el.dataset.idx = String(i);
          syncKept?.(el, i);
        }
      }
      if (!el) el = createPlaceholder(gridEl, i);
      gridEl.insertBefore(el, this.bottomSpacer); // ascending order → sorted
    }

    this.topSpacer.style.height = `${win.topSpacerPx}px`;
    this.bottomSpacer.style.height = `${win.bottomSpacerPx}px`;
  }

  /** Read the live column count (computed grid tracks), or the injected seam. */
  protected columns(): number {
    if (this.opts.readColumns) return Math.max(1, this.opts.readColumns());
    const tpl = getComputedStyle(this.opts.gridEl).gridTemplateColumns;
    return parseColumnCount(tpl, 1);
  }

  enable(): void {
    this.enabled = true;
    this.ensureSpacers();
  }

  /** Yield ownership of gridEl to another render path (split/pipeline). */
  disable(): void {
    this.enabled = false;
    this.topSpacer.remove();
    this.bottomSpacer.remove();
  }

  dispose(): void {
    this.enabled = false;
    this.topSpacer.remove();
    this.bottomSpacer.remove();
  }
}
