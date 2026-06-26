import { describe, it, expect } from "vitest";
import { applyCategoryDelta, type LibraryTreeData } from "@/ui/lib/library-tree";

function tree(): LibraryTreeData {
  return {
    total: 100,
    unsorted: 50,
    categories: [
      { name: "Tech", count: 10 },
      { name: "Food", count: 5 },
    ],
    platforms: [{ name: "tiktok", display: "TikTok", total: 100 }],
  };
}

describe("applyCategoryDelta", () => {
  it("moves items out of unsorted into existing categories", () => {
    const out = applyCategoryDelta(tree(), new Map([["Tech", 5], ["Food", 3]]));
    expect(out.unsorted).toBe(42);
    expect(out.categories.find(c => c.name === "Tech")?.count).toBe(15);
    expect(out.categories.find(c => c.name === "Food")?.count).toBe(8);
  });

  it("appends a category that wasn't present (resurrected canonical)", () => {
    const out = applyCategoryDelta(tree(), new Map([["Content Creation", 7]]));
    expect(out.unsorted).toBe(43);
    expect(out.categories.find(c => c.name === "Content Creation")?.count).toBe(7);
  });

  it("keeps total and platforms unchanged (items don't leave the vault)", () => {
    const out = applyCategoryDelta(tree(), new Map([["Tech", 5]]));
    expect(out.total).toBe(100);
    expect(out.platforms).toEqual(tree().platforms);
  });

  it("never drives unsorted negative", () => {
    const out = applyCategoryDelta(tree(), new Map([["Tech", 999]]));
    expect(out.unsorted).toBe(0);
  });

  it("is a no-op for an empty/zero delta and does not mutate the input", () => {
    const input = tree();
    const out = applyCategoryDelta(input, new Map([["Tech", 0]]));
    expect(out).toBe(input); // same reference — no work done
    expect(input.categories.find(c => c.name === "Tech")?.count).toBe(10);
  });
});
