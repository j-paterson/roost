/**
 * Regression test: the Media substitute view must remove its own DOM on
 * dispose.
 *
 * Background: media-list's dispose used to rely on "the next render's
 * container.empty()" to wipe its children. That contract held when the
 * gallery did full-teardown renders, but the standard-grid path now
 * RECONCILES cards in place (gallery-grid-render.ts → reconcileStandardGrid)
 * and never empties the container — so switching Media → any other category
 * left the media table mixed into the card grid.
 *
 * The host (PipelineGalleryHost.dispatch) calls handle.dispose() when the
 * category changes away; dispose must remove everything the view added to
 * the container — and ONLY what it added (dispatch runs after reconcile, so
 * a container.empty() in dispose would delete freshly reconciled cards).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { BasesEntry } from "obsidian";
import { getPipelineGalleryView, type GalleryRenderContext } from "@/views/pipeline-views/registry";
import "@/views/pipeline-views/index";

// Polyfill Obsidian's DOM augmentations (happy-dom does not ship these).
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
    proto.createEl = function (tag: string, opts?: { cls?: string; text?: string; href?: string }) {
      const el = document.createElement(tag) as any;
      if (opts?.cls) el.className = opts.cls;
      if (opts?.text) el.textContent = opts.text;
      if (opts?.href) el.href = opts.href;
      this.appendChild(el);
      return el;
    };
    proto.createSpan = function (opts?: { cls?: string; text?: string }) {
      const s = document.createElement("span");
      if (opts?.cls) s.className = opts.cls;
      if (opts?.text) s.textContent = opts.text;
      this.appendChild(s);
      return s;
    };
    proto.setText = function (text: string) { this.textContent = text; };
    proto.setAttr = function (name: string, value: string) { this.setAttribute(name, value); };
    proto.addClass = function (cls: string) { this.classList.add(cls); };
    proto.removeClass = function (cls: string) { this.classList.remove(cls); };
    proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  }
});

/** Minimal BasesEntry stub: getValue-backed, no metadataCache frontmatter. */
function entryStub(values: Record<string, unknown>): BasesEntry {
  return {
    file: { path: "Bookmarks/x.md", basename: "x" },
    getValue: (key: string) => values[key] ?? null,
  } as unknown as BasesEntry;
}

function ctxStub(entries: BasesEntry[]): GalleryRenderContext {
  return {
    app: { metadataCache: { getCache: () => undefined } },
    entries,
    filter: { category: "Media" },
    setFilter: () => {},
    rerender: () => {},
    resolveImageUrl: () => null,
    resolveVideoUrl: () => null,
    pinAndFocus: () => {},
    setFeedActive: () => {},
    renderExpandedCard: () => {},
  } as unknown as GalleryRenderContext;
}

describe("media-list substitute view dispose", () => {
  it("empty state: dispose removes everything the view added", () => {
    const view = getPipelineGalleryView({ category: "Media" } as any)!;
    expect(view).toBeTruthy();
    const container = document.createElement("div");

    const handle = view.render(container, ctxStub([]));
    expect(container.children.length).toBeGreaterThan(0); // rendered something

    handle.dispose();
    expect(container.children.length).toBe(0);            // and cleaned it ALL up
    expect(container.classList.contains("roost-media-list-host")).toBe(false);
  });

  it("populated table: dispose removes the table but spares foreign siblings", () => {
    const view = getPipelineGalleryView({ category: "Media" } as any)!;
    const container = document.createElement("div");

    const entries = [
      entryStub({ "note.media_title": "Dune", "note.roost_id": "tiktok:1" }),
      entryStub({ "note.media_title": "Blade Runner", "note.roost_id": "tiktok:2" }),
    ];
    const handle = view.render(container, ctxStub(entries));
    expect(container.querySelector(".roost-media-list-root")).toBeTruthy();
    expect(container.querySelectorAll("tbody tr").length).toBe(2);

    // Simulate the reconcile path appending a card AFTER the substitute
    // rendered (dispatch() runs after reconcileStandardGrid on the way out).
    const foreignCard = document.createElement("div");
    foreignCard.className = "roost-card roost-card-ready";
    container.appendChild(foreignCard);

    handle.dispose();
    expect(container.querySelector(".roost-media-list-root")).toBeNull(); // own DOM gone
    expect(container.contains(foreignCard)).toBe(true);                   // foreign DOM spared
    expect(container.classList.contains("roost-media-list-host")).toBe(false);
  });
});
