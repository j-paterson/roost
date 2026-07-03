import { describe, it, expect } from "vitest";
import { orderReviewIdsByGrid, greenLast } from "@/ui/lib/smart-assign/review-pass";

describe("orderReviewIdsByGrid", () => {
  it("orders proposals by the grid order", () => {
    const gridOrder = ["c", "a", "b", "d"];       // gallery display order
    const proposals = ["a", "b", "c"];
    expect(orderReviewIdsByGrid(gridOrder, proposals)).toEqual(["c", "a", "b"]);
  });
  it("appends proposals not present in the grid, preserving their input order", () => {
    const gridOrder = ["c", "a"];
    const proposals = ["a", "x", "c", "y"];        // x,y not in grid
    expect(orderReviewIdsByGrid(gridOrder, proposals)).toEqual(["c", "a", "x", "y"]);
  });
  it("returns the proposal order when the grid order is empty (fallback)", () => {
    expect(orderReviewIdsByGrid([], ["a", "b"])).toEqual(["a", "b"]);
  });
  it("ignores grid ids that are not proposals", () => {
    expect(orderReviewIdsByGrid(["z", "a", "z"], ["a"])).toEqual(["a"]);
  });
});

describe("greenLast", () => {
  it("puts human-assigned ids after the rest, preserving order within each group", () => {
    expect(greenLast(["a", "b", "c", "d"], new Set(["b", "d"]))).toEqual(["a", "c", "b", "d"]);
  });
});
