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
  /** Keep-by-key reuse across reseed for non-roost_id consumers. Defaults to data-roost-id. */
  reuseKey?: { selector: string; get: (el: HTMLElement) => string | null };
  /** Called for each card element removed from the grid (e.g. to unobserve a hydration IO). */
  onEvict?: (el: HTMLElement) => void;
  /**
   * Override/seam for measuring the uniform row PITCH (card height + row gap) in px.
   * Defaults to reading a hydrated card's offsetHeight + the grid's computed rowGap.
   * Returns null when no real height is available yet (stay on the estimate).
   */
  measureRowHeight?: () => number | null;
}

export class WindowedCardGrid {
  private readonly topSpacer: HTMLElement;
  private readonly bottomSpacer: HTMLElement;
  private enabled = true;
  private attached = false;

  private readonly onScroll = () => this.scheduleRecompute();
  private rafHandle: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastWindowKey = "";
  private measuredRowHeight: number | null = null;

  constructor(private readonly opts: WindowedCardGridOptions) {
    this.topSpacer = this.makeSpacer("roost-grid-spacer-top");
    this.bottomSpacer = this.makeSpacer("roost-grid-spacer-bottom");
    this.attach();
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.opts.scrollEl.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.measuredRowHeight = null; // column width changed → cover height changed → re-measure
        this.scheduleRecompute();
      });
      this.resizeObserver.observe(this.opts.scrollEl);
    }
  }

  detach(): void {
    this.opts.scrollEl.removeEventListener("scroll", this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.rafHandle != null) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.rafHandle);
      } else {
        clearTimeout(this.rafHandle);
      }
    }
    this.rafHandle = null;
    this.attached = false;
  }

  private scheduleRecompute(): void {
    if (!this.enabled) return;
    if (this.rafHandle != null) return;
    const raf = typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
    this.rafHandle = raf(() => {
      this.rafHandle = null;
      this.recompute(false);
    });
  }

  private effectiveRowHeight(): number {
    return this.measuredRowHeight ?? this.opts.rowHeight();
  }

  /** Read the uniform row pitch. Default: a hydrated card's offsetHeight + computed rowGap. */
  private readRowHeight(): number | null {
    if (this.opts.measureRowHeight) return this.opts.measureRowHeight();
    const card = this.opts.gridEl.querySelector<HTMLElement>(".roost-card-ready[data-idx]");
    if (!card) return null;
    const gap = parseFloat(getComputedStyle(this.opts.gridEl).rowGap) || 0;
    const h = card.offsetHeight;
    return h > 0 ? h + gap : null;
  }

  /** Measure the uniform row height once; if it differs from the estimate/prior, re-lay exactly. */
  private measureRowHeightOnce(): void {
    if (this.measuredRowHeight != null) return; // uniform → stable until resize invalidates
    const h = this.readRowHeight();
    if (h == null || h <= 0) return;
    this.measuredRowHeight = h;
    this.recompute(true); // re-lay with the exact height
  }

  /** Test seam: simulate the ResizeObserver callback. */
  onResizeForTest(): void {
    this.measuredRowHeight = null;
    this.scheduleRecompute();
  }

  private currentWindow(): GridWindow {
    return computeGridWindow({
      total: this.opts.count(),
      columns: this.columns(),
      rowHeight: Math.max(1, this.effectiveRowHeight()),
      scrollTop: this.opts.scrollEl.scrollTop,
      viewportHeight: this.opts.scrollEl.clientHeight,
      bufferRows: this.bufferRows(),
    });
  }

  /** Scroll/resize-driven reconcile. Skips work when the window is unchanged. */
  recompute(force = false): void {
    if (!this.enabled) return;
    const win = this.currentWindow();
    const key = `${win.windowStart}:${win.windowEnd}`;
    if (!force && key === this.lastWindowKey) return;
    this.lastWindowKey = key;
    this.applyWindow(win, false);
    this.measureRowHeightOnce();
  }

  /** Data-update reseed at the current window (keep hydrated cards by key). */
  refresh(): void {
    this.enabled = true;
    const win = this.currentWindow();
    this.lastWindowKey = `${win.windowStart}:${win.windowEnd}`;
    this.applyWindow(win, true);
  }

  getOrderedKeys(): string[] {
    const out: string[] = [];
    const n = this.opts.count();
    for (let i = 0; i < n; i++) {
      const k = this.opts.keyAt(i);
      if (k) out.push(k);
    }
    return out;
  }

  indexOfKey(key: string): number {
    const n = this.opts.count();
    for (let i = 0; i < n; i++) if (this.opts.keyAt(i) === key) return i;
    return -1;
  }

  scrollIndexIntoView(index: number): void {
    if (!this.enabled) return;
    if (index < 0) return;
    const win = this.currentWindow();
    // Already mounted (within the window incl. buffer) — no coarse snap needed;
    // downstream (feed highlight / expand) handles fine positioning.
    if (index >= win.windowStart && index < win.windowEnd) return;
    const cols = this.columns();
    const row = Math.floor(index / cols);
    this.opts.scrollEl.scrollTop = row * Math.max(1, this.effectiveRowHeight());
    this.recompute(true);
  }

  scrollKeyIntoView(key: string): void {
    this.scrollIndexIntoView(this.indexOfKey(key));
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
    const rk = this.opts.reuseKey ?? {
      selector: ".roost-card-ready[data-roost-id]",
      get: (el: HTMLElement) => el.dataset.roostId ?? null,
    };
    for (const el of this.opts.gridEl.querySelectorAll<HTMLElement>(rk.selector)) {
      const k = rk.get(el);
      if (k) map.set(k, el);
    }
    return map;
  }

  private removeCard(el: HTMLElement): void {
    this.opts.onEvict?.(el);
    el.remove();
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
      // Remove ALL card elements (incl. stray no-data-idx skeletons); keptByKey holds
      // references to hydrated cards for reuse below.
      for (const el of gridEl.querySelectorAll<HTMLElement>(".roost-card")) this.removeCard(el);
      mounted.clear();
    } else {
      // Drop cards that scrolled out of the window.
      for (const [idx, el] of mounted) {
        if (idx < win.windowStart || idx >= win.windowEnd) {
          this.removeCard(el);
          mounted.delete(idx);
        }
      }
    }

    // Place desired indices in ascending order right after the top spacer. Move a card
    // ONLY when it is not already in its correct DOM position — re-inserting an
    // already-placed on-screen card detaches+reattaches it, which repaints it (and
    // re-evaluates `content-visibility`), causing visible flicker while scrolling.
    let prev: Node = this.topSpacer;
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
      if (prev.nextSibling !== el) {
        gridEl.insertBefore(el, prev.nextSibling); // only new/misplaced cards move
      }
      prev = el;
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
    this.recompute(true);
  }

  /** Yield ownership of gridEl to another render path (split/pipeline). */
  disable(): void {
    this.enabled = false;
    this.lastWindowKey = "";
    this.topSpacer.remove();
    this.bottomSpacer.remove();
  }

  dispose(): void {
    this.enabled = false;
    this.detach();
    this.topSpacer.remove();
    this.bottomSpacer.remove();
  }
}
