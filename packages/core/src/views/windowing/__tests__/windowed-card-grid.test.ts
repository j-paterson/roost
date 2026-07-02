// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
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

  it("reseed removes a hydrated card whose index falls outside the new window", () => {
    // total=20, 4 cols → 5 rows of 100px each
    // initial window: scrollTop=0, viewportHeight=200, bufferRows=0 → rows [0,2) → indices [0,8)
    // (ceil(200/100)=2 rows visible, 2*4=8 cards)
    const { grid, gridEl } = setup(20);
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));

    // hydrate index 0 and capture the node reference
    const oldNode = gridEl.querySelector<HTMLElement>('[data-idx="0"]')!;
    oldNode.classList.add("roost-card-ready");
    oldNode.dataset.roostId = "k0";
    oldNode.dataset.marker = "should-be-gone";

    // reseed with a narrower window that excludes index 0:
    // scrollTop=200, viewportHeight=100, bufferRows=0 → firstVisibleRow=2, lastVisibleRow=3
    // → windowStart=8, windowEnd=12 (indices [8,12))
    const narrowWin = computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 200, viewportHeight: 100, bufferRows: 0 });
    expect(narrowWin.windowStart).toBeGreaterThan(0); // confirm index 0 excluded
    grid.applyWindow(narrowWin, true);

    // index 0 must be absent from the DOM entirely
    expect(gridEl.querySelector('[data-idx="0"]')).toBeNull();
    // the specific node we captured must no longer be in the tree
    expect(gridEl.contains(oldNode)).toBe(false);
    // the new window's indices must be present
    expect(cardIdxs(gridEl)).toContain(narrowWin.windowStart);
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

describe("WindowedCardGrid model queries", () => {
  it("getOrderedKeys spans the full model, not just the window", () => {
    const { grid } = setup(50);
    grid.applyWindow(computeGridWindow({ total: 50, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));
    const keys = grid.getOrderedKeys();
    expect(keys.length).toBe(50);
    expect(keys[0]).toBe("k0");
    expect(keys[49]).toBe("k49");
  });

  it("scrollKeyIntoView sets scrollTop to the key's row and materializes it", () => {
    const { grid, scrollEl, gridEl } = setup(200, {
      readColumns: () => 4,
      rowHeight: () => 100,
    });
    // seed an initial window
    grid.recompute(true);
    grid.scrollKeyIntoView("k80"); // row 20 → scrollTop 2000
    expect(scrollEl.scrollTop).toBe(2000);
    // after recompute triggered by scrollKeyIntoView, index 80 is mounted
    expect(gridEl.querySelector('[data-idx="80"]')).not.toBeNull();
  });

  it("recompute no-ops while disabled", () => {
    const { grid, gridEl } = setup(50);
    grid.disable();
    grid.recompute(true);
    expect(gridEl.querySelectorAll(".roost-card").length).toBe(0);
  });
});
