// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { WindowedCardGrid, type WindowedCardGridOptions } from "../windowed-card-grid";
import { computeGridWindow } from "../compute-grid-window";

// Build a controller over a synthetic model of `total` items whose key is `k{i}`.
function setup(total: number, opts: Partial<WindowedCardGridOptions> = {}) {
  const scrollEl = document.createElement("div");
  const gridEl = document.createElement("div");
  scrollEl.appendChild(gridEl);

  const createPlaceholder = (parent: HTMLElement, index: number) => {
    const el = document.createElement("div");
    el.className = "roost-card roost-card-placeholder";
    el.dataset.idx = String(index);
    parent.appendChild(el);
    return el;
  };

  const grid = new WindowedCardGrid({
    scrollEl, gridEl,
    rowHeight: () => 100,
    count: () => total,
    keyAt: (i) => (i >= 0 && i < total ? `k${i}` : null),
    createPlaceholder,
    syncKept: () => {},
    readColumns: () => 4,
    bufferRows: 0,
    ...opts,
  });
  return { grid, scrollEl, gridEl };
}

function cardIdxs(gridEl: HTMLElement): number[] {
  return [...gridEl.querySelectorAll<HTMLElement>(".roost-card")].map((el) => Number(el.dataset.idx));
}

describe("WindowedCardGrid.applyWindow (index-stable)", () => {
  it("mounts only the windowed indices, in order, between spacers", () => {
    const { grid, gridEl } = setup(100);
    grid.applyWindow(computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));
    // 200px / 100 = rows 0..2 (ceil) * 4 cols = indices [0,12)
    expect(cardIdxs(gridEl)).toEqual([0,1,2,3,4,5,6,7,8,9,10,11]);
    // spacers present, top first & bottom last
    expect(gridEl.firstElementChild!.className).toContain("spacer-top");
    expect(gridEl.lastElementChild!.className).toContain("spacer-bottom");
  });

  it("sets spacer heights from the window", () => {
    const { grid, gridEl } = setup(100);
    const win = computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 1000, viewportHeight: 200, bufferRows: 0 });
    grid.applyWindow(win);
    const top = gridEl.querySelector<HTMLElement>(".roost-grid-spacer-top")!;
    const bottom = gridEl.querySelector<HTMLElement>(".roost-grid-spacer-bottom")!;
    expect(top.style.height).toBe(`${win.topSpacerPx}px`);
    expect(bottom.style.height).toBe(`${win.bottomSpacerPx}px`);
  });

  it("keeps a hydrated card that stays in-window when the window slides", () => {
    const { grid, gridEl } = setup(100);
    grid.applyWindow(computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));
    // hydrate index 8 in place
    const eight = gridEl.querySelector<HTMLElement>('[data-idx="8"]')!;
    eight.classList.add("roost-card-ready");
    eight.dataset.roostId = "k8";
    eight.dataset.marker = "same-node";
    // slide down by one row (indices 4..15)
    grid.applyWindow(computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 100, viewportHeight: 200, bufferRows: 0 }));
    const stillThere = gridEl.querySelector<HTMLElement>('[data-idx="8"]')!;
    expect(stillThere.dataset.marker).toBe("same-node"); // reused, not recreated
    expect(cardIdxs(gridEl)).not.toContain(0); // index 0 unmounted
  });
});

describe("WindowedCardGrid.applyWindow reseed (data-update, keep-by-roost_id)", () => {
  it("reuses a hydrated card by key and syncs it, dropping absent keys", () => {
    const synced: number[] = [];
    const { grid, gridEl } = setup(20, { syncKept: (_el, i) => synced.push(i) });
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));
    const c0 = gridEl.querySelector<HTMLElement>('[data-idx="0"]')!;
    c0.classList.add("roost-card-ready");
    c0.dataset.roostId = "k0";
    c0.dataset.marker = "kept";
    // reseed same window
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }), true);
    const after = gridEl.querySelector<HTMLElement>('[data-idx="0"]')!;
    expect(after.dataset.marker).toBe("kept");   // same node reused across reseed
    expect(synced).toContain(0);                  // syncKept called for kept card
  });
});

describe("WindowedCardGrid.disable/enable", () => {
  it("disable detaches spacers", () => {
    const { grid, gridEl } = setup(20);
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));
    grid.disable();
    expect(gridEl.querySelector(".roost-grid-spacer-top")).toBeNull();
    expect(gridEl.querySelector(".roost-grid-spacer-bottom")).toBeNull();
  });
});
