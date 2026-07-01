import { describe, it, expect } from "vitest";
import { seedReviewIds, greenLast } from "@/ui/lib/smart-assign/review-pass";

describe("seedReviewIds", () => {
  it("flattens all proposal ids, most-uncertain (lowest score) first, stable when scoreless", () => {
    const folders = [{ name: "A", itemIds: ["a1", "a2"] }, { name: "B", itemIds: ["b1"] }];
    const score = (id: string) => ({ a1: 8, a2: 3, b1: 5 } as Record<string, number>)[id];
    expect(seedReviewIds(folders, score)).toEqual(["a2", "b1", "a1"]);
  });
  it("keeps proposal order when no scores", () => {
    const folders = [{ name: "A", itemIds: ["a1", "a2"] }, { name: "B", itemIds: ["b1"] }];
    expect(seedReviewIds(folders, () => undefined)).toEqual(["a1", "a2", "b1"]);
  });
});

describe("greenLast", () => {
  it("puts human-assigned ids after the rest, preserving order within each group", () => {
    expect(greenLast(["a", "b", "c", "d"], new Set(["b", "d"]))).toEqual(["a", "c", "b", "d"]);
  });
});
