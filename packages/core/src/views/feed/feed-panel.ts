/**
 * Feed pane — vertical snap-scrolling list of feed items.
 *
 * Memory discipline: with 18k-item bases, only the active item ± half-window
 * is mounted. Items outside the window render as fixed-height placeholders
 * to preserve scroll geometry so snap math stays correct.
 *
 * Windowed slots: only ~5 DOM nodes are attached at a time (active ± WINDOW_BUFFER).
 * Top/bottom spacers preserve total scroll height so the scrollbar and snap math
 * remain correct. Active-item detection uses scrollend + scrollTop/itemHeight math.
 */
import type { BasesEntry } from "obsidian";
import { getRoostId } from "@/lib/bases-entry";
import type { FeedItemHandle, FeedRenderContext } from "@/views/feed/feed-renderers";
import { renderFeedItem } from "@/views/feed/feed-renderers";
import type { FeedSync } from "@/views/feed/feed-sync";

/** Inclusive slot index range to attach around the active item. */
export function feedWindowRange(
  active: number,
  total: number,
  buffer: number,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: -1 };
  const a = Math.min(Math.max(active, 0), total - 1);
  return { start: Math.max(0, a - buffer), end: Math.min(total - 1, a + buffer) };
}

const WINDOW_BUFFER = 2;      // active ± 2 → ≤5 attached slots
const SMOOTH_DISTANCE = 3;    // grid→feed jumps within this distance scroll smoothly

export interface FeedPanelHandle {
  setEntries(entries: BasesEntry[], preferredActiveRoostId: string | null): void;
  dispose(): void;
}

export interface FeedPanelOptions {
  /** Test seam: uniform item height in px. Defaults to container.clientHeight. */
  itemHeight?: () => number;
}

interface Slot {
  entry: BasesEntry;
  roostId: string;
  el: HTMLElement | null;      // created only while in the window
  handle: FeedItemHandle | null;
}

export function mountFeedPanel(
  container: HTMLElement,
  ctx: FeedRenderContext,
  sync: FeedSync,
  initialEntries: BasesEntry[],
  opts?: FeedPanelOptions,
): FeedPanelHandle {
  container.empty();
  container.addClass("roost-feed-scroller");

  const topSpacer = makeSpacer("roost-feed-spacer-top");
  const bottomSpacer = makeSpacer("roost-feed-spacer-bottom");

  let slots: Slot[] = [];
  let windowStart = 0;
  let windowEnd = -1;
  let activeIndex = 0;
  let suppressScrollSync = false;
  let rafPending = false;

  function makeSpacer(cls: string): HTMLElement {
    const el = document.createElement("div");
    el.className = cls;
    el.style.width = "100%";
    el.style.flex = "0 0 auto";
    el.style.height = "0px";
    return el;
  }

  const H = (): number => {
    const h = opts?.itemHeight ? opts.itemHeight() : container.clientHeight;
    return h > 0 ? h : 1;
  };
  const clampIndex = (i: number): number =>
    slots.length === 0 ? 0 : Math.min(Math.max(i, 0), slots.length - 1);

  function ensureSpacers(): void {
    if (topSpacer.parentElement !== container) container.insertBefore(topSpacer, container.firstChild);
    container.appendChild(bottomSpacer); // appendChild moves it to last
  }

  function detachSlot(i: number): void {
    const slot = slots[i];
    if (!slot?.el) return;
    slot.handle?.dispose();
    slot.handle = null;
    slot.el.remove();
    slot.el = null;
  }

  /** Attach exactly the window [start,end], in order, moving only slots not already in place. */
  function applyWindow(active: number): void {
    const { start, end } = feedWindowRange(active, slots.length, WINDOW_BUFFER);
    // Detach slots leaving the window.
    for (let i = windowStart; i <= windowEnd; i++) {
      if (i < start || i > end) detachSlot(i);
    }
    ensureSpacers();
    // Place window slots ascending, right after the top spacer; only move when needed.
    let prev: Node = topSpacer;
    for (let i = start; i <= end; i++) {
      const slot = slots[i];
      if (!slot.el) {
        const el = document.createElement("div");
        el.className = "roost-feed-item";
        el.dataset.feedIndex = String(i);
        slot.el = el;
        slot.handle = renderFeedItem(el, slot.entry, ctx);
      }
      if (prev.nextSibling !== slot.el) container.insertBefore(slot.el, prev.nextSibling);
      prev = slot.el;
    }
    windowStart = start;
    windowEnd = end;
    const h = H();
    topSpacer.style.height = `${start * h}px`;
    bottomSpacer.style.height = `${Math.max(0, slots.length - 1 - end) * h}px`;
  }

  function setActiveIndex(next: number, fromScroll: boolean): void {
    const n = clampIndex(next);
    if (n === activeIndex && slots[n]?.el) return;
    slots[activeIndex]?.handle?.deactivate?.();
    activeIndex = n;
    applyWindow(activeIndex);
    slots[activeIndex]?.handle?.activate?.();
    if (fromScroll) sync.set(slots[activeIndex]?.roostId ?? null, "feed");
  }

  const currentIndexFromScroll = (): number => clampIndex(Math.round(container.scrollTop / H()));

  const onScroll = (): void => {
    if (suppressScrollSync || rafPending) return;
    rafPending = true;
    const raf = typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
    raf(() => {
      rafPending = false;
      const idx = currentIndexFromScroll();
      if (idx !== activeIndex) setActiveIndex(idx, true);
    });
  };
  const onScrollEnd = (): void => {
    if (suppressScrollSync) return;
    const idx = currentIndexFromScroll();
    if (idx !== activeIndex) setActiveIndex(idx, true);
  };
  container.addEventListener("scroll", onScroll, { passive: true });
  container.addEventListener("scrollend", onScrollEnd);

  const resizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        applyWindow(activeIndex);
        suppressScrollSync = true;
        container.scrollTop = activeIndex * H();
        requestAnimationFrame(() => { suppressScrollSync = false; });
      })
    : null;
  resizeObserver?.observe(container);

  /** Scroll to an item, sliding the window. `smooth` for near jumps. */
  function scrollToIndex(i: number, smooth: boolean): void {
    const idx = clampIndex(i);
    slots[activeIndex]?.handle?.deactivate?.();
    activeIndex = idx;
    applyWindow(idx);
    suppressScrollSync = true;
    const top = idx * H();
    if (smooth) container.scrollTo({ top, behavior: "smooth" });
    else container.scrollTop = top;
    slots[idx]?.handle?.activate?.();
    const settleMs = smooth ? 400 : 50;
    setTimeout(() => { suppressScrollSync = false; }, settleMs);
  }

  const unsubSync = sync.subscribe((roostId, source) => {
    if (source !== "grid" || !roostId) return;
    const idx = slots.findIndex((s) => s.roostId === roostId);
    if (idx < 0 || idx === activeIndex) return;
    scrollToIndex(idx, Math.abs(idx - activeIndex) <= SMOOTH_DISTANCE);
  });

  function rebuild(entries: BasesEntry[], preferredActiveRoostId: string | null): void {
    for (let i = windowStart; i <= windowEnd; i++) detachSlot(i);
    container.empty();
    container.addClass("roost-feed-scroller");
    slots = entries.map((e) => ({ entry: e, roostId: getRoostId(e), el: null, handle: null }));
    windowStart = 0;
    windowEnd = -1;

    let nextActive = 0;
    if (preferredActiveRoostId) {
      const idx = slots.findIndex((s) => s.roostId === preferredActiveRoostId);
      if (idx >= 0) nextActive = idx;
    }
    activeIndex = clampIndex(nextActive);

    container.appendChild(topSpacer);
    container.appendChild(bottomSpacer);
    applyWindow(activeIndex);
    slots[activeIndex]?.handle?.activate?.();

    suppressScrollSync = true;
    container.scrollTop = activeIndex * H();
    requestAnimationFrame(() => { suppressScrollSync = false; });
  }

  rebuild(initialEntries, sync.get());

  return {
    setEntries(entries, preferredActiveRoostId) { rebuild(entries, preferredActiveRoostId); },
    dispose() {
      unsubSync();
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("scrollend", onScrollEnd);
      resizeObserver?.disconnect();
      for (let i = windowStart; i <= windowEnd; i++) detachSlot(i);
      windowStart = 0;
      windowEnd = -1;
      container.empty();
      container.removeClass("roost-feed-scroller");
    },
  };
}
