// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import type { BasesEntry } from "obsidian";
import { syncGalleryCardFromEntry, hydrateGalleryCard } from "../gallery-cards";
import type { GalleryCardHandlers, GalleryCardConfig } from "../gallery-cards";

function mockEntry(rid: string, category: string): BasesEntry {
  return {
    file: { path: `Bookmarks/${rid}.md`, basename: rid },
    getValue: (key: string) => {
      if (key === "note.roost_id") return rid;
      if (key === "note.roost_category") return category;
      return null;
    },
  } as unknown as BasesEntry;
}

// Polyfill Obsidian DOM augmentations (happy-dom does not ship these).
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
    proto.createEl = function (tag: string, opts?: { cls?: string; text?: string }) {
      const el = document.createElement(tag) as any;
      if (opts?.cls) el.className = opts.cls;
      if (opts?.text) el.textContent = opts.text;
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

function makeMinimalCfg(): GalleryCardConfig {
  return {
    imagePropId: "note.cover",
    imageFit: "cover",
    imageRatio: 0.75,
    showPlatform: false,
    showAuthor: false,
    showTags: false,
  };
}

function makeHandlers(overrides: Partial<GalleryCardHandlers> = {}): GalleryCardHandlers {
  return {
    viewMode: "grid",
    expandState: { expandedEl: null } as any,
    uncertainRoostIds: null,
    matchedRoostIds: null,
    matchDetailMap: null,
    humanAssignedRoostIds: null,
    isSelectionActive: () => false,
    isSelected: () => false,
    onSelectionToggle: () => {},
    onFeedSelect: () => {},
    onExpand: () => {},
    resolveImageUrl: () => "https://example.com/img.jpg",
    resolveVideoUrl: () => null,
    hasMultipleImages: () => false,
    isTextTileCover: () => false,
    pipelineTypeForEntry: () => null,
    ...overrides,
  };
}

describe("syncGalleryCardFromEntry", () => {
  it("updates dataset.category from entry frontmatter", () => {
    const el = document.createElement("div");
    el.dataset.category = "Old";
    syncGalleryCardFromEntry(el, mockEntry("bm_1", "Music"));
    expect(el.dataset.category).toBe("Music");
  });

  it("clears match badge when item is no longer matched", () => {
    const el = document.createElement("div");
    el.dataset.matched = "1";
    const cover = document.createElement("div");
    cover.className = "roost-card-cover";
    cover.appendChild(Object.assign(document.createElement("div"), { className: "roost-card-match-badge" }));
    el.appendChild(cover);

    syncGalleryCardFromEntry(el, mockEntry("bm_1", "Music"), { matchedRoostIds: new Set() });
    expect(el.dataset.matched).toBeUndefined();
    expect(cover.querySelector(".roost-card-match-badge")).toBeNull();
  });
});

describe("hydrateGalleryCard — human-assigned state", () => {
  it("sets data-assigned=human and omits match badge when roostId is in humanAssignedRoostIds", () => {
    const el = document.createElement("div");
    el.className = "roost-card roost-card-placeholder";
    el.dataset.idx = "0";

    const handlers = makeHandlers({
      humanAssignedRoostIds: new Set(["bm_human"]),
      matchedRoostIds: new Set(["bm_human"]), // also matched — badge must still be suppressed
    });

    hydrateGalleryCard(el, mockEntry("bm_human", "Music"), makeMinimalCfg(), handlers);

    expect(el.dataset.assigned).toBe("human");
    expect(el.querySelector(".roost-card-match-badge")).toBeNull();
  });

  it("matched card NOT in humanAssignedRoostIds keeps data-matched=1 and shows the badge", () => {
    const el = document.createElement("div");
    el.className = "roost-card roost-card-placeholder";
    el.dataset.idx = "0";

    const handlers = makeHandlers({
      humanAssignedRoostIds: null,
      matchedRoostIds: new Set(["bm_matched"]),
      matchDetailMap: null,
    });

    hydrateGalleryCard(el, mockEntry("bm_matched", "Music"), makeMinimalCfg(), handlers);

    expect(el.dataset.matched).toBe("1");
    expect(el.dataset.assigned).toBeUndefined();
    expect(el.querySelector(".roost-card-match-badge")).not.toBeNull();
  });
});
