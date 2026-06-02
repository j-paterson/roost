// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { reconcileStandardGrid } from "../gallery-grid-reconcile";

function mockEntry(rid: string): BasesEntry {
  return {
    file: { path: `Bookmarks/${rid}.md`, basename: rid },
    getValue: (key: string) => (key === "note.roost_id" ? rid : null),
  } as unknown as BasesEntry;
}

function card(rid: string, idx: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "roost-card roost-card-ready";
  el.dataset.roostId = rid;
  el.dataset.idx = idx;
  return el;
}

describe("reconcileStandardGrid", () => {
  it("removes cards not in the new set and keeps the rest", () => {
    const container = document.createElement("div");
    container.appendChild(card("a", "0"));
    container.appendChild(card("b", "1"));

    const result = reconcileStandardGrid({
      containerEl: container,
      entries: [mockEntry("a"), mockEntry("c")],
      indices: [0, 1],
      newTotal: 2,
      filteredCount: 2,
      estimatedHeight: 100,
      hydrationObserver: null,
      createPlaceholder: (parent, index) => {
        const ph = document.createElement("div");
        ph.className = "roost-card roost-card-placeholder";
        ph.dataset.idx = String(index);
        parent.appendChild(ph);
      },
      syncKeptCard: () => {},
    });

    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.added).toBe(1);
    expect(container.querySelector('[data-roost-id="b"]')).toBeNull();
    expect(container.querySelector('[data-roost-id="a"]')).not.toBeNull();
    expect(container.querySelectorAll(".roost-card-placeholder").length).toBe(1);
  });

  it("reorders kept cards to match filtered index order", () => {
    const container = document.createElement("div");
    container.appendChild(card("a", "0"));
    container.appendChild(card("b", "1"));

    reconcileStandardGrid({
      containerEl: container,
      entries: [mockEntry("b"), mockEntry("a")],
      indices: [0, 1],
      newTotal: 2,
      filteredCount: 2,
      estimatedHeight: 100,
      hydrationObserver: null,
      createPlaceholder: () => {},
      syncKeptCard: () => {},
    });

    const ids = [...container.querySelectorAll<HTMLElement>(".roost-card-ready")].map(
      el => el.dataset.roostId,
    );
    expect(ids).toEqual(["b", "a"]);
  });
});
