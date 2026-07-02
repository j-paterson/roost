import { describe, it, expect } from "vitest";
import { computeGridWindow, parseColumnCount } from "../compute-grid-window";

const base = { total: 100, columns: 4, rowHeight: 100, scrollTop: 0, viewportHeight: 500, bufferRows: 0 };

describe("parseColumnCount", () => {
  it("counts resolved px tracks", () => {
    expect(parseColumnCount("180px 180px 180px")).toBe(3);
  });
  it("falls back for empty/none", () => {
    expect(parseColumnCount("", 1)).toBe(1);
    expect(parseColumnCount("none", 7)).toBe(7);
  });
});

describe("computeGridWindow", () => {
  it("windows the first screen at scrollTop 0", () => {
    // 500px viewport / 100px rows = rows 0..5 (ceil), cols 4 → indices [0,24)
    const w = computeGridWindow(base);
    expect(w.windowStart).toBe(0);
    expect(w.windowEnd).toBe(24);
    expect(w.topSpacerPx).toBe(0);
    // totalRows=25, last row index rendered = 5 → bottom = (25-1-5)*100 = 1900
    expect(w.bottomSpacerPx).toBe(1900);
  });

  it("row-aligns the window start to a column multiple when scrolled", () => {
    const w = computeGridWindow({ ...base, scrollTop: 1000 }); // row 10
    expect(w.windowStart % base.columns).toBe(0);
    expect(w.windowStart).toBe(40); // firstVisibleRow 10 * 4 cols
    expect(w.topSpacerPx).toBe(1000);
  });

  it("applies buffer rows above and below, clamped at edges", () => {
    const top = computeGridWindow({ ...base, scrollTop: 0, bufferRows: 2 });
    expect(top.windowStart).toBe(0); // clamped, no negative rows
    const mid = computeGridWindow({ ...base, scrollTop: 1000, bufferRows: 2 });
    expect(mid.windowStart).toBe((10 - 2) * 4); // 32
  });

  it("clamps the window end to total", () => {
    const w = computeGridWindow({ ...base, scrollTop: 100_000 });
    expect(w.windowEnd).toBe(100);
    expect(w.bottomSpacerPx).toBe(0);
  });

  it("returns an empty window for total 0", () => {
    expect(computeGridWindow({ ...base, total: 0 })).toEqual({
      windowStart: 0, windowEnd: 0, topSpacerPx: 0, bottomSpacerPx: 0,
    });
  });

  it("treats fewer-than-one-row totals as a single row", () => {
    const w = computeGridWindow({ ...base, total: 2 });
    expect(w.windowEnd).toBe(2);
    expect(w.bottomSpacerPx).toBe(0);
  });

  it("guards against zero columns and zero rowHeight", () => {
    expect(() => computeGridWindow({ ...base, columns: 0, rowHeight: 0 })).not.toThrow();
  });
});
