import { describe, it, expect } from "vitest";
import { computeMountWindow } from "@/views/feed/feed-panel";

describe("computeMountWindow", () => {
  it("returns a centered window when in the middle", () => {
    expect(computeMountWindow(5, 100, 5)).toEqual(new Set([3, 4, 5, 6, 7]));
  });

  it("clamps to 0 at the start", () => {
    expect(computeMountWindow(0, 100, 5)).toEqual(new Set([0, 1, 2]));
    expect(computeMountWindow(1, 100, 5)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("clamps to total-1 at the end", () => {
    expect(computeMountWindow(99, 100, 5)).toEqual(new Set([97, 98, 99]));
  });

  it("handles total smaller than window", () => {
    expect(computeMountWindow(1, 3, 5)).toEqual(new Set([0, 1, 2]));
  });

  it("handles total === 0", () => {
    expect(computeMountWindow(0, 0, 5)).toEqual(new Set());
  });
});
