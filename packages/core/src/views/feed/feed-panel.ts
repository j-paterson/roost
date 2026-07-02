/**
 * Feed pane — vertical snap-scrolling list of feed items.
 *
 * Memory discipline: with 18k-item bases, only the active item ± half-window
 * is mounted. Items outside the window render as fixed-height placeholders
 * to preserve scroll geometry so snap math stays correct.
 *
 * Active-item detection uses IntersectionObserver on the slotted items;
 * the item with the highest intersection ratio above 0.6 becomes active.
 */
import type { BasesEntry } from "obsidian";
import { getRoostId } from "@/lib/bases-entry";
import type { FeedItemHandle, FeedRenderContext } from "@/views/feed/feed-renderers";
import { renderFeedItem } from "@/views/feed/feed-renderers";
import type { FeedSync } from "@/views/feed/feed-sync";

const WINDOW_SIZE = 5;

// Slots are cheap placeholder <div>s, but creating + observing thousands of them
// synchronously (e.g. the Smart Assign review pass seeds the whole run) freezes
// the main thread. Build the first CHUNK_SIZE synchronously (covers the mount
// window + first screen) and append the rest across animation frames. For lists
// at or below CHUNK_SIZE this is fully synchronous — identical to the old path.
const CHUNK_SIZE = 300;

/** Indices that should be mounted given the active index, total count, and window. */
export function computeMountWindow(activeIndex: number, total: number, windowSize: number): Set<number> {
  const out = new Set<number>();
  if (total <= 0) return out;
  const half = Math.floor(windowSize / 2);
  const start = Math.max(0, activeIndex - half);
  const end = Math.min(total - 1, activeIndex + half);
  for (let i = start; i <= end; i++) out.add(i);
  return out;
}

export interface FeedPanelHandle {
  setEntries(entries: BasesEntry[], preferredActiveRoostId: string | null): void;
  dispose(): void;
}

interface Slot {
  el: HTMLElement;
  entry: BasesEntry;
  roostId: string;
  handle: FeedItemHandle | null;
}

export function mountFeedPanel(
  container: HTMLElement,
  ctx: FeedRenderContext,
  sync: FeedSync,
  initialEntries: BasesEntry[],
): FeedPanelHandle {
  container.empty();
  container.addClass("roost-feed-scroller");

  let slots: Slot[] = [];
  let mounted: Set<number> = new Set();
  let activeIndex = 0;
  let suppressScrollSync = false;
  // Bumped on every rebuild/dispose so a superseded chunked-append loop bails.
  let buildToken = 0;

  function makeSlot(entry: BasesEntry): Slot {
    // Detached — appended to the container later (in chunks) by rebuild.
    const el = document.createElement("div");
    el.className = "roost-feed-item";
    return { el, entry, roostId: getRoostId(entry), handle: null };
  }

  function mountIndex(i: number) {
    const slot = slots[i];
    if (!slot || slot.handle) return;
    slot.el.empty();
    slot.handle = renderFeedItem(slot.el, slot.entry, ctx);
  }

  function unmountIndex(i: number) {
    const slot = slots[i];
    if (!slot || !slot.handle) return;
    slot.handle.dispose();
    slot.handle = null;
    slot.el.empty();
  }

  function setActiveIndex(next: number, fromScroll: boolean) {
    if (next === activeIndex) return;
    const prevHandle = slots[activeIndex]?.handle;
    prevHandle?.deactivate?.();
    activeIndex = next;
    const nextWindow = computeMountWindow(activeIndex, slots.length, WINDOW_SIZE);
    for (const i of mounted) if (!nextWindow.has(i)) unmountIndex(i);
    for (const i of nextWindow) if (!mounted.has(i)) mountIndex(i);
    mounted = nextWindow;
    slots[activeIndex]?.handle?.activate?.();
    if (fromScroll) {
      const roostId = slots[activeIndex]?.roostId ?? null;
      sync.set(roostId, "feed");
    }
  }

  // Active-item detection. IntersectionObserver alone is fragile in a
  // snap-scroll container because rapid scrolls can pass through items
  // without ever reaching the 0.6 threshold. The reliable primitive for
  // snap-scrolling is `scrollend` — it fires when the snap settles, and
  // we pick the item whose top is closest to the viewport top. We keep
  // the IO as a coarse signal for slow drags where snap hasn't engaged.
  const observer = new IntersectionObserver(
    (entriesObserved) => {
      let bestIdx = activeIndex;
      let bestRatio = 0;
      for (const o of entriesObserved) {
        if (o.intersectionRatio < 0.6) continue;
        if (o.intersectionRatio <= bestRatio) continue;
        const idx = Number((o.target as HTMLElement).dataset.feedIndex);
        if (!Number.isNaN(idx)) { bestIdx = idx; bestRatio = o.intersectionRatio; }
      }
      if (!suppressScrollSync && bestRatio > 0) setActiveIndex(bestIdx, true);
    },
    { root: container, threshold: [0, 0.5, 0.6, 1] },
  );

  /** Pick the slot whose top is closest to the container's scrollTop. */
  function closestSlotToScrollTop(): number {
    if (slots.length === 0) return -1;
    const scrollTop = container.scrollTop;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const dist = Math.abs(slots[i].el.offsetTop - container.offsetTop - scrollTop);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return bestIdx;
  }

  const onScrollEnd = () => {
    if (suppressScrollSync) return;
    const idx = closestSlotToScrollTop();
    if (idx >= 0 && idx !== activeIndex) setActiveIndex(idx, true);
  };
  container.addEventListener("scrollend", onScrollEnd);

  function rebuild(entries: BasesEntry[], preferredActiveRoostId: string | null) {
    // Supersede any in-flight chunked append from a previous rebuild.
    const myToken = ++buildToken;
    // Unobserve stale slots before clearing the DOM so IO callbacks cannot
    // fire for removed elements and corrupt activeIndex on the new slot list.
    for (const s of slots) observer.unobserve(s.el);
    // Dispose existing slots
    for (const i of mounted) unmountIndex(i);
    mounted = new Set();
    container.empty();
    container.addClass("roost-feed-scroller");

    // Create slot records with DETACHED elements (cheap); append/observe below.
    slots = entries.map(makeSlot);
    slots.forEach((s, i) => { s.el.dataset.feedIndex = String(i); });

    let nextActive = 0;
    if (preferredActiveRoostId) {
      const idx = slots.findIndex((s) => s.roostId === preferredActiveRoostId);
      if (idx >= 0) nextActive = idx;
    }
    activeIndex = nextActive;

    // Append + observe a [start, end) index range, in order.
    const appendRange = (start: number, end: number) => {
      for (let i = start; i < end && i < slots.length; i++) {
        container.appendChild(slots[i].el);
        observer.observe(slots[i].el);
      }
    };

    // Synchronous first chunk: enough to cover the mount window + first screen.
    const firstEnd = Math.min(slots.length, Math.max(CHUNK_SIZE, activeIndex + WINDOW_SIZE + 1));
    appendRange(0, firstEnd);

    const window = computeMountWindow(activeIndex, slots.length, WINDOW_SIZE);
    for (const i of window) mountIndex(i);
    mounted = window;
    slots[activeIndex]?.handle?.activate?.();

    // Scroll active into view without echoing back to sync.
    suppressScrollSync = true;
    slots[activeIndex]?.el.scrollIntoView({ block: "start" });
    requestAnimationFrame(() => { suppressScrollSync = false; });

    // Append the remaining slots across animation frames so the main thread
    // never blocks on a multi-thousand-item list. Bails if superseded.
    if (firstEnd < slots.length) {
      let cursor = firstEnd;
      const step = () => {
        if (myToken !== buildToken) return; // a newer rebuild (or dispose) took over
        appendRange(cursor, cursor + CHUNK_SIZE);
        cursor += CHUNK_SIZE;
        if (cursor < slots.length) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  // Subscribe to grid-driven activations. Smooth-scrolling across many
  // items is agonizingly slow (~1s per ~10 items), so only use smooth
  // for neighbors — jumps further away snap instantly to the target.
  const SMOOTH_DISTANCE = 3;
  const unsubSync = sync.subscribe((roostId, source) => {
    if (source !== "grid") return;
    if (!roostId) return;
    const idx = slots.findIndex((s) => s.roostId === roostId);
    if (idx < 0 || idx === activeIndex) return;
    const distance = Math.abs(idx - activeIndex);
    const behavior: ScrollBehavior = distance > SMOOTH_DISTANCE ? "auto" : "smooth";
    suppressScrollSync = true;
    setActiveIndex(idx, false);
    slots[idx].el.scrollIntoView({ block: "start", behavior });
    // Give the scroll time to settle before re-enabling scroll-sourced
    // updates. Smooth scroll across a few items needs ~400ms; instant
    // snap completes within a frame.
    const settleMs = behavior === "smooth" ? 400 : 50;
    setTimeout(() => { suppressScrollSync = false; }, settleMs);
  });

  rebuild(initialEntries, sync.get());

  return {
    setEntries(entries, preferredActiveRoostId) { rebuild(entries, preferredActiveRoostId); },
    dispose() {
      buildToken++; // cancel any in-flight chunked append
      unsubSync();
      container.removeEventListener("scrollend", onScrollEnd);
      observer.disconnect();
      for (const i of mounted) unmountIndex(i);
      mounted = new Set();
      container.empty();
      container.removeClass("roost-feed-scroller");
    },
  };
}
