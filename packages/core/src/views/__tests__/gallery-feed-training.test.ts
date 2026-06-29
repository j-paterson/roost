import { describe, it, expect } from "vitest";
import { computeAdvance } from "@/views/gallery-feed-mode";

// computeAdvance is the pure core of advanceAfterAction: given the remaining roostIds
// (after the judged item left the filtered set) and the judged item's index, return the
// roostId that should become active (the item that took the judged slot, else the last).
describe("computeAdvance", () => {
  it("activates the item now occupying the judged index", () => {
    expect(computeAdvance(["a", "c", "d"], 1)).toBe("c"); // b was at index 1, judged & removed
  });
  it("clamps to the last item when the judged item was last", () => {
    expect(computeAdvance(["a", "b"], 2)).toBe("b");
  });
  it("returns null when the queue is now empty", () => {
    expect(computeAdvance([], 0)).toBeNull();
  });
});
