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

describe("reconcileStandardGrid — large interleaved set", () => {
  it("keeps 25 even cards, drops 25 odd cards, adds new entries, correct DOM order and data-idx", () => {
    const N = 50;
    const container = document.createElement("div");

    // Pre-populate 50 ready cards: e0..e49
    for (let i = 0; i < N; i++) {
      container.appendChild(card(`e${i}`, String(i)));
    }

    // Build entries array: 25 kept evens (e0,e2,...,e48) + 10 new (n0..n9)
    // entries order: n0, e0, n1, e2, n2, e4, n3, e6, n4, e8, n5, e10, n6, e12, n7, e14, n8, e16, n9, e18, e20, e22, e24, e26, e28, e30, e32, e34, e36, e38, e40, e42, e44, e46, e48
    const entries: BasesEntry[] = [];
    const indices: number[] = [];

    // Interleave n0..n9 with e0,e2,...,e18 (first 10 even pairs), then remaining evens e20..e48
    let entryIdx = 0;
    const newIds = ["n0","n1","n2","n3","n4","n5","n6","n7","n8","n9"];
    const evenIds = Array.from({ length: 25 }, (_, k) => `e${k * 2}`);  // e0,e2,...,e48

    // First 20 positions: interleave new with even
    for (let i = 0; i < 10; i++) {
      entries.push(mockEntry(newIds[i]));
      indices.push(entryIdx++);
      entries.push(mockEntry(evenIds[i]));
      indices.push(entryIdx++);
    }
    // Remaining 15 even entries
    for (let i = 10; i < 25; i++) {
      entries.push(mockEntry(evenIds[i]));
      indices.push(entryIdx++);
    }

    const newTotal = indices.length; // 10 + 25 = 35

    let syncKeptCount = 0;
    const syncKeptCard = () => { syncKeptCount++; };

    const createdPlaceholders: number[] = [];
    const createPlaceholder = (parent: HTMLElement, index: number, height: number) => {
      const ph = document.createElement("div");
      ph.className = "roost-card roost-card-placeholder";
      ph.dataset.idx = String(index);
      createdPlaceholders.push(index);
      parent.appendChild(ph);
    };

    const result = reconcileStandardGrid({
      containerEl: container,
      entries,
      indices,
      newTotal,
      filteredCount: newTotal,
      estimatedHeight: 100,
      hydrationObserver: null,
      createPlaceholder,
      syncKeptCard,
    });

    // 1. Removed 25 odd cards (e1, e3, ..., e49)
    expect(result.removed).toBe(25);

    // 2. Kept 25 even cards
    expect(result.kept).toBe(25);

    // 3. Added = newTotal - kept = 35 - 25 = 10
    expect(result.added).toBe(newTotal - 25);
    expect(result.added).toBe(10);

    // 4. Container children in order match interleaved pattern
    const children = [...container.children] as HTMLElement[];
    expect(children.length).toBe(newTotal); // 35 total

    // Build expected sequence of (roostId | "placeholder") for each position
    const expectedSequence: string[] = [];
    for (let i = 0; i < 10; i++) {
      expectedSequence.push("placeholder"); // new entries get placeholders
      expectedSequence.push(evenIds[i]);    // kept even card
    }
    for (let i = 10; i < 25; i++) {
      expectedSequence.push(evenIds[i]);    // remaining even cards
    }

    const actualSequence = children.map(el => el.dataset.roostId ?? "placeholder");
    expect(actualSequence).toEqual(expectedSequence);

    // 5. Each kept card's dataset.idx equals its position in the filtered order (indices)
    // Even cards appear at positions: 1,3,5,...,19,20,21,...,34
    let pos = 0;
    for (let i = 0; i < 10; i++) {
      pos++; // placeholder position
      const evenCard = container.querySelector<HTMLElement>(`[data-roost-id="${evenIds[i]}"]`);
      expect(evenCard?.dataset.idx).toBe(String(pos));
      pos++;
    }
    for (let i = 10; i < 25; i++) {
      const evenCard = container.querySelector<HTMLElement>(`[data-roost-id="${evenIds[i]}"]`);
      expect(evenCard?.dataset.idx).toBe(String(pos));
      pos++;
    }

    // 6. syncKeptCard called exactly once per kept card
    expect(syncKeptCount).toBe(25);
  });
});
