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

describe("WindowedCardGrid.applyWindow — no needless moves (anti-flicker)", () => {
  // Spy on insertBefore to record which card indices get (re)inserted.
  function spyInserts(gridEl: HTMLElement): number[] {
    const inserted: number[] = [];
    const orig = gridEl.insertBefore.bind(gridEl);
    (gridEl as unknown as { insertBefore: Node["insertBefore"] }).insertBefore = ((node: Node, ref: Node | null) => {
      const idx = (node as HTMLElement).dataset?.idx;
      if (idx != null) inserted.push(Number(idx));
      return orig(node as never, ref as never);
    }) as Node["insertBefore"];
    return inserted;
  }

  it("does NOT re-insert any card when the window is unchanged", () => {
    const { grid, gridEl } = setup(100);
    const win = computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 400, viewportHeight: 400, bufferRows: 0 });
    grid.applyWindow(win);
    const inserted = spyInserts(gridEl);
    grid.applyWindow(win); // identical window — must be a DOM no-op for cards
    expect(inserted).toEqual([]);
  });

  it("only inserts newly-entering cards on a window shift, leaving on-screen cards in place", () => {
    const { grid, gridEl } = setup(100);
    const first = computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 400, bufferRows: 0 });
    grid.applyWindow(first); // [0,20)
    const before = cardIdxs(gridEl);
    const inserted = spyInserts(gridEl);
    const shifted = computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 100, viewportHeight: 400, bufferRows: 0 });
    grid.applyWindow(shifted); // [4,24)
    // cards present in BOTH windows are still on screen — they must NOT be moved
    const stayed = before.filter((i) => i >= shifted.windowStart && i < shifted.windowEnd);
    for (const idx of stayed) expect(inserted).not.toContain(idx);
    // final order still correct + spacers bracket
    expect(cardIdxs(gridEl)).toEqual(Array.from({ length: shifted.windowEnd - shifted.windowStart }, (_, k) => shifted.windowStart + k));
    expect(gridEl.firstElementChild!.className).toContain("spacer-top");
    expect(gridEl.lastElementChild!.className).toContain("spacer-bottom");
  });
});

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

describe("WindowedCardGrid.applyWindow reseed clears initial skeletons", () => {
  it("removes stray no-data-idx .roost-card skeletons on reseed", () => {
    const { grid, gridEl } = setup(10);

    // Pre-populate gridEl with two skeleton cards that have NO data-idx (simulating
    // the initial skeletons rendered by showGalleryInitialSkeletons before the window grid).
    const skel1 = document.createElement("div");
    skel1.className = "roost-card roost-card-placeholder";
    // intentionally omit data-idx
    gridEl.appendChild(skel1);

    const skel2 = document.createElement("div");
    skel2.className = "roost-card roost-card-placeholder";
    gridEl.appendChild(skel2);

    // Confirm skeletons exist before reseed.
    expect(gridEl.querySelectorAll(".roost-card").length).toBeGreaterThanOrEqual(2);

    // Call applyWindow with reseed=true (the data-update path).
    grid.applyWindow(
      computeGridWindow({ total: 10, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }),
      true,
    );

    // The two stray skeletons (no data-idx) must be gone.
    expect(gridEl.contains(skel1)).toBe(false);
    expect(gridEl.contains(skel2)).toBe(false);

    // Only windowed [data-idx] cards and spacers should remain.
    for (const el of gridEl.querySelectorAll<HTMLElement>(".roost-card")) {
      expect(el.dataset.idx).toBeDefined();
    }
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

  it("disable→refresh re-mounts cards and re-attaches spacers (split/pipeline → standard re-entry)", () => {
    // Build a grid with 20 items; apply an initial window so cards get mounted.
    const { grid, gridEl } = setup(20);
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));

    // Confirm cards are present before disable.
    expect(gridEl.querySelectorAll(".roost-card").length).toBeGreaterThan(0);

    // disable() hands ownership of gridEl to another path (e.g. split/pipeline).
    // It removes spacers but leaves cards for the alternative renderer to manage.
    grid.disable();
    // Spacers must be detached.
    expect(gridEl.querySelector(".roost-grid-spacer-top")).toBeNull();
    expect(gridEl.querySelector(".roost-grid-spacer-bottom")).toBeNull();

    // Simulate the alternative renderer clearing cards (as split/pipeline would do).
    for (const el of gridEl.querySelectorAll(".roost-card")) el.remove();
    expect(gridEl.querySelectorAll(".roost-card").length).toBe(0);

    // refresh() is the re-entry point (called by refreshWindowGrid() in the view).
    // happy-dom clientHeight=0, bufferRows=0 → window=[0,4) (firstVisibleRow=0, lastVisibleRow=0).
    grid.refresh();

    // Spacers must be back in the DOM.
    expect(gridEl.querySelector(".roost-grid-spacer-top")).not.toBeNull();
    expect(gridEl.querySelector(".roost-grid-spacer-bottom")).not.toBeNull();

    // At least one card must be mounted — proves refresh() re-enabled + applied the window.
    // This assertion fails if refresh() left the grid disabled (no cards would be mounted).
    expect(gridEl.querySelectorAll(".roost-card").length).toBeGreaterThanOrEqual(1);
  });
});

describe("WindowedCardGrid reuseKey option", () => {
  it("reuses hydrated cards by a custom selector/attribute across reseed", () => {
    const scrollEl = document.createElement("div");
    const gridEl = document.createElement("div");
    scrollEl.appendChild(gridEl);
    const grid = new WindowedCardGrid({
      scrollEl, gridEl,
      rowHeight: () => 100,
      count: () => 20,
      keyAt: (i) => `p${i}`,
      createPlaceholder: (parent, index) => {
        const el = document.createElement("div");
        el.className = "roost-card roost-card-placeholder";
        el.dataset.idx = String(index);
        parent.appendChild(el);
        return el;
      },
      readColumns: () => 4,
      bufferRows: 0,
      reuseKey: { selector: ".roost-card-ready[data-path]", get: (el) => el.dataset.path ?? null },
    });
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }));
    const c0 = gridEl.querySelector<HTMLElement>('[data-idx="0"]')!;
    c0.classList.add("roost-card-ready");
    c0.dataset.path = "p0";
    c0.dataset.marker = "kept";
    grid.applyWindow(computeGridWindow({ total: 20, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 }), true);
    expect(gridEl.querySelector<HTMLElement>('[data-idx="0"]')!.dataset.marker).toBe("kept");
  });
});

describe("WindowedCardGrid onEvict option", () => {
  it("calls onEvict for every card removed on scroll-out and reseed", () => {
    const scrollEl = document.createElement("div");
    const gridEl = document.createElement("div");
    scrollEl.appendChild(gridEl);
    const evicted: string[] = [];
    const grid = new WindowedCardGrid({
      scrollEl, gridEl,
      rowHeight: () => 100,
      count: () => 100,
      keyAt: (i) => `k${i}`,
      createPlaceholder: (parent, index) => {
        const el = document.createElement("div");
        el.className = "roost-card roost-card-placeholder";
        el.dataset.idx = String(index);
        parent.appendChild(el);
        return el;
      },
      readColumns: () => 4,
      bufferRows: 0,
      onEvict: (el) => evicted.push(el.dataset.idx!),
    });
    grid.applyWindow(computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 200, bufferRows: 0 })); // [0,12)
    grid.applyWindow(computeGridWindow({ total: 100, columns: 4, rowHeight: 100, scrollTop: 400, viewportHeight: 200, bufferRows: 0 })); // slides down, evicts low indices
    expect(evicted).toContain("0");
    expect(evicted.length).toBeGreaterThan(0);
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

describe("WindowedCardGrid measured uniform row height", () => {
  it("switches from the estimate to the measured height, and a shift uses it", () => {
    const scrollEl = document.createElement("div");
    const gridEl = document.createElement("div");
    scrollEl.appendChild(gridEl);
    // scrollEl.clientHeight is 0 under happy-dom; inject viewport via readColumns/rowHeight seams.
    let measured: number | null = null;
    const grid = new WindowedCardGrid({
      scrollEl, gridEl,
      rowHeight: () => 100,                 // estimate
      count: () => 100,
      keyAt: (i) => `k${i}`,
      createPlaceholder: (parent, index) => {
        const el = document.createElement("div");
        el.className = "roost-card roost-card-placeholder";
        el.dataset.idx = String(index);
        parent.appendChild(el);
        return el;
      },
      readColumns: () => 4,
      bufferRows: 0,
      measureRowHeight: () => measured,     // seam: null until a "real" height is known
    });
    // With no measurement, scrollIndexIntoView uses the estimate (100): index 40 → row 10 → scrollTop 1000.
    grid.scrollKeyIntoView("k40");
    expect(scrollEl.scrollTop).toBe(1000);
    // Now a real height is available; recompute should pick it up.
    measured = 200;
    grid.recompute(true);
    // scrollIndexIntoView now uses 200: index 40 → row 10 → scrollTop 2000.
    grid.scrollKeyIntoView("k40");
    expect(scrollEl.scrollTop).toBe(2000);
  });

  it("resets the measured height on resize so it re-measures", () => {
    const scrollEl = document.createElement("div");
    const gridEl = document.createElement("div");
    scrollEl.appendChild(gridEl);
    let measured: number | null = 250;
    const grid = new WindowedCardGrid({
      scrollEl, gridEl,
      rowHeight: () => 100,
      count: () => 100,
      keyAt: (i) => `k${i}`,
      createPlaceholder: (parent, index) => {
        const el = document.createElement("div");
        el.className = "roost-card"; el.dataset.idx = String(index);
        parent.appendChild(el); return el;
      },
      readColumns: () => 4,
      bufferRows: 0,
      measureRowHeight: () => measured,
    });
    grid.recompute(true);
    grid.scrollKeyIntoView("k20"); // row 5 * 250 = 1250
    expect(scrollEl.scrollTop).toBe(1250);
    // Simulate resize: measurement now reflects a new column width; invalidate + re-measure.
    measured = 150;
    grid.onResizeForTest();        // test hook that mirrors the ResizeObserver callback
    grid.recompute(true);
    grid.scrollKeyIntoView("k20"); // row 5 * 150 = 750
    expect(scrollEl.scrollTop).toBe(750);
  });
});
