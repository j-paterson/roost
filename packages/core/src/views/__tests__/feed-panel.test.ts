// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from "vitest";
import type { BasesEntry } from "obsidian";
import { feedWindowRange, mountFeedPanel } from "@/views/feed/feed-panel";
import { createFeedSync } from "@/views/feed/feed-sync";
import type { FeedRenderContext } from "@/views/feed/feed-renderers";

// Card rendering is out of scope — the windowed tests assert slot creation only.
const handles: Array<{ dispose: any; activate: any; deactivate: any }> = [];
vi.mock("@/views/feed/feed-renderers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/views/feed/feed-renderers")>();
  return {
    ...real,
    renderFeedItem: vi.fn(() => {
      const h = { dispose: vi.fn(), activate: vi.fn(), deactivate: vi.fn() };
      handles.push(h);
      return h;
    }),
  };
});

beforeAll(() => {
  const proto = HTMLElement.prototype as any;
  if (!proto.empty) {
    proto.createDiv = function (opts?: { cls?: string; text?: string }) {
      const d = document.createElement("div");
      if (opts?.cls) d.className = opts.cls;
      if (opts?.text) d.textContent = opts.text;
      this.appendChild(d);
      return d;
    };
    proto.addClass = function (cls: string) { this.classList.add(cls); };
    proto.removeClass = function (cls: string) { this.classList.remove(cls); };
    proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  }
  HTMLElement.prototype.scrollIntoView = () => {};
  // Run RAF callbacks synchronously so suppressScrollSync resets within test frames.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
});

describe("feedWindowRange", () => {
  it("centers on the active index with the given buffer", () => {
    expect(feedWindowRange(5, 100, 2)).toEqual({ start: 3, end: 7 });
  });
  it("clamps at the start", () => {
    expect(feedWindowRange(0, 100, 2)).toEqual({ start: 0, end: 2 });
    expect(feedWindowRange(1, 100, 2)).toEqual({ start: 0, end: 3 });
  });
  it("clamps at the end", () => {
    expect(feedWindowRange(99, 100, 2)).toEqual({ start: 97, end: 99 });
  });
  it("clamps the active index into range", () => {
    expect(feedWindowRange(999, 10, 2)).toEqual({ start: 7, end: 9 });
    expect(feedWindowRange(-5, 10, 2)).toEqual({ start: 0, end: 2 });
  });
  it("handles total smaller than the window", () => {
    expect(feedWindowRange(1, 3, 2)).toEqual({ start: 0, end: 2 });
  });
  it("returns an empty range for total 0", () => {
    expect(feedWindowRange(0, 0, 2)).toEqual({ start: 0, end: -1 });
  });
});

function makeEntry(id: string): BasesEntry {
  return { file: { path: `B/${id}.md`, basename: id }, getValue: (k: string) => (k === "note.roost_id" ? id : null) } as unknown as BasesEntry;
}
const ctx = {} as unknown as FeedRenderContext;

describe("mountFeedPanel windowed slots", () => {
  it("attaches only ~5 slots (window) not N, bracketed by spacers", () => {
    const container = document.createElement("div");
    const entries = Array.from({ length: 5000 }, (_, i) => makeEntry(`k${i}`));
    const handle = mountFeedPanel(container, ctx, createFeedSync(), entries, { itemHeight: () => 800 });
    const items = container.querySelectorAll(".roost-feed-item");
    expect(items.length).toBeLessThanOrEqual(5);      // active(0) ± 2 → indices 0..2 at the start
    expect(items.length).toBeGreaterThan(0);
    expect(container.querySelector(".roost-feed-spacer-top")).not.toBeNull();
    expect(container.querySelector(".roost-feed-spacer-bottom")).not.toBeNull();
    // bottom spacer reserves the rest of the scroll height
    const bottom = container.querySelector<HTMLElement>(".roost-feed-spacer-bottom")!;
    expect(parseInt(bottom.style.height, 10)).toBeGreaterThan(100000);
    handle.dispose();
  });

  it("slides the window when scrollTop moves (active = round(scrollTop/H))", () => {
    const container = document.createElement("div");
    const entries = Array.from({ length: 5000 }, (_, i) => makeEntry(`k${i}`));
    const handle = mountFeedPanel(container, ctx, createFeedSync(), entries, { itemHeight: () => 800 });
    // scroll to item 100 (100 * 800 = 80000)
    container.scrollTop = 80000;
    container.dispatchEvent(new Event("scrollend"));
    const idxs = [...container.querySelectorAll<HTMLElement>(".roost-feed-item")].map(e => Number(e.dataset.feedIndex));
    expect(idxs).toContain(100);
    expect(Math.min(...idxs)).toBeGreaterThanOrEqual(98);
    expect(Math.max(...idxs)).toBeLessThanOrEqual(102);
    // top spacer now reserves the rows above the window
    const top = container.querySelector<HTMLElement>(".roost-feed-spacer-top")!;
    expect(parseInt(top.style.height, 10)).toBe(98 * 800);
    handle.dispose();
  });

  it("jumps to the entry when the grid sync fires", () => {
    const container = document.createElement("div");
    const entries = Array.from({ length: 5000 }, (_, i) => makeEntry(`k${i}`));
    const sync = createFeedSync();
    const handle = mountFeedPanel(container, ctx, sync, entries, { itemHeight: () => 800 });
    const snapLen = handles.length;
    sync.set("k2000", "grid");
    const idxs = [...container.querySelectorAll<HTMLElement>(".roost-feed-item")].map(e => Number(e.dataset.feedIndex));
    expect(idxs).toContain(2000);
    expect(container.scrollTop).toBe(2000 * 800);
    // The handle for the slot at index 2000 (rendered during the jump) must have been activated.
    const newHandles = handles.slice(snapLen);
    expect(newHandles.some(h => h.activate.mock.calls.length > 0)).toBe(true);
    handle.dispose();
  });
});
