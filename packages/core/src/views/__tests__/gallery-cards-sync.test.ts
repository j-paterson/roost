// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { syncGalleryCardFromEntry } from "../gallery-cards";

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
