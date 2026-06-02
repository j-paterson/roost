import { describe, it, expect } from "vitest";
import { mmrTrim } from "../mmr";

interface Item {
  id: string;
  vec: number[] | null;
}

function it_(id: string, vec: number[] | null): Item {
  return { id, vec };
}

describe("mmrTrim", () => {
  it("returns input as-is when items.length <= targetCount", () => {
    const items = [it_("a", [1, 0]), it_("b", [0, 1])];
    expect(mmrTrim(items, 5)).toEqual(items);
  });

  it("returns up to targetCount items when input is larger", () => {
    const items = [
      it_("a", [1, 0, 0]),
      it_("b", [0, 1, 0]),
      it_("c", [0, 0, 1]),
      it_("d", [1, 0, 0]),
      it_("e", [0, 1, 0]),
    ];
    const result = mmrTrim(items, 3);
    expect(result).toHaveLength(3);
  });

  it("at lambda=1 (pure relevance) picks items closest to centroid first", () => {
    // Items a,b,c at centroid; d,e are outliers
    const items = [
      it_("a", [1, 1, 0]),
      it_("b", [1, 1, 0]),
      it_("c", [1, 1, 0]),
      it_("d", [0, 0, 1]),
      it_("e", [0, 0, 1]),
    ];
    const result = mmrTrim(items, 2, 1.0);
    // The centroid is dominated by [1,1,0] direction; relevance-only picks those.
    expect(result.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("at lambda=0 (pure diversity) maximizes spread", () => {
    const items = [
      it_("a", [1, 0, 0]),
      it_("b", [1, 0, 0]),
      it_("c", [0, 1, 0]),
      it_("d", [0, 0, 1]),
    ];
    const result = mmrTrim(items, 3, 0.0);
    // Pure diversity should reach into orthogonal vectors b, c, d (after seed).
    const ids = result.map((i) => i.id);
    // At minimum the result should include the orthogonal-to-seed picks.
    expect(ids).toContain("c");
    expect(ids).toContain("d");
  });

  it("appends no-vec items at end up to targetCount", () => {
    const items = [
      it_("a", [1, 0, 0]),
      it_("b", [0, 1, 0]),
      it_("c", null),
      it_("d", null),
    ];
    const result = mmrTrim(items, 3, 0.7);
    expect(result).toHaveLength(3);
    // Last item should be one of the no-vec ones (they're appended after MMR).
    expect([result[2].id]).toEqual(expect.arrayContaining([expect.stringMatching(/^(c|d)$/)]));
  });

  it("returns slice when all items have null vec", () => {
    const items = [it_("a", null), it_("b", null), it_("c", null)];
    expect(mmrTrim(items, 2)).toEqual([items[0], items[1]]);
  });

  it("preserves insertion order in returned items when input is small enough", () => {
    const items = [it_("a", [1, 0]), it_("b", [0, 1])];
    const result = mmrTrim(items, 5);
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
