// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { BasesEntry } from "obsidian";
import { computeMountWindow, mountFeedPanel } from "@/views/feed/feed-panel";
import { createFeedSync } from "@/views/feed/feed-sync";
import type { FeedRenderContext } from "@/views/feed/feed-renderers";

// Card rendering is out of scope — the chunking tests assert slot creation only.
vi.mock("@/views/feed/feed-renderers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/views/feed/feed-renderers")>();
  return { ...real, renderFeedItem: vi.fn(() => ({ dispose: vi.fn() })) };
});

describe("computeMountWindow", () => {
  it("returns a centered window when in the middle", () => {
    expect(computeMountWindow(5, 100, 5)).toEqual(new Set([3, 4, 5, 6, 7]));
  });

  it("clamps to 0 at the start", () => {
    expect(computeMountWindow(0, 100, 5)).toEqual(new Set([0, 1, 2]));
    expect(computeMountWindow(1, 100, 5)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("clamps to total-1 at the end", () => {
    expect(computeMountWindow(99, 100, 5)).toEqual(new Set([97, 98, 99]));
  });

  it("handles total smaller than window", () => {
    expect(computeMountWindow(1, 3, 5)).toEqual(new Set([0, 1, 2]));
  });

  it("handles total === 0", () => {
    expect(computeMountWindow(0, 0, 5)).toEqual(new Set());
  });
});

// ── Chunked slot creation (large review-pass lists must not freeze the main thread) ──

function makeEntry(id: string): BasesEntry {
  return {
    file: { path: `Bookmarks/${id}.md`, basename: id },
    getValue: (key: string) => (key === "note.roost_id" ? id : null),
  } as unknown as BasesEntry;
}

describe("mountFeedPanel — chunked slot creation", () => {
  // Manual rAF queue: each flush() runs exactly one frame's callbacks, so the
  // chunk-append loop advances one CHUNK_SIZE step per flush, deterministically.
  let rafQueue: FrameRequestCallback[] = [];
  const flushFrame = () => {
    const cbs = rafQueue;
    rafQueue = [];
    for (const cb of cbs) cb(0);
  };

  beforeAll(() => {
    const proto = HTMLElement.prototype as any;
    if (!proto.createDiv) {
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
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });

  const ctx = { app: {} as never, imagePropId: "note.cover", onAction: vi.fn() } as unknown as FeedRenderContext;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => makeEntry(`id:${i}`));

  it("creates all slots synchronously for small lists (regular Train mode unchanged)", () => {
    const container = document.createElement("div");
    mountFeedPanel(container, ctx, createFeedSync(), ids(50));
    expect(container.children.length).toBe(50);
  });

  it("creates only the first chunk synchronously for large lists, then appends across frames", () => {
    const container = document.createElement("div");
    mountFeedPanel(container, ctx, createFeedSync(), ids(700));
    // Synchronous work is capped at one chunk — this is the anti-freeze guarantee.
    expect(container.children.length).toBe(300);
    flushFrame(); // frame 1: +300
    expect(container.children.length).toBe(600);
    flushFrame(); // frame 2: remaining 100
    expect(container.children.length).toBe(700);
    flushFrame(); // no-op — loop ended
    expect(container.children.length).toBe(700);
    // Order preserved: slot i carries feedIndex i.
    expect((container.children[699] as HTMLElement).dataset.feedIndex).toBe("699");
  });

  it("a rebuild mid-append supersedes the in-flight chunk loop (no stale slots)", () => {
    const container = document.createElement("div");
    const handle = mountFeedPanel(container, ctx, createFeedSync(), ids(700));
    expect(container.children.length).toBe(300);
    // Rebuild with a new list before the old append loop finishes.
    handle.setEntries(ids(350), null);
    expect(container.children.length).toBe(300); // first chunk of the NEW list
    // Drain all frames: the old loop must bail; only the new list's 350 remain.
    for (let i = 0; i < 5; i++) flushFrame();
    expect(container.children.length).toBe(350);
  });
});
