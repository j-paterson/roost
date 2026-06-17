import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { scoreAgainstCategories, __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

// Distinct unit vectors so nearest-centroid is unambiguous.
function unit(i: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
}

function mkCache(): Record<string, EmbeddingCacheEntry> {
  return {
    // exactly on the "Italian" centroid → must pick Italian
    item1: { vision: null, vec: unit(0), summary: "pasta carbonara", category: "food" },
    // exactly on the "Strength" centroid → must pick Strength
    item2: { vision: null, vec: unit(1), summary: "back squat", category: "fitness" },
  };
}

function mkCats(): CategoryDef[] {
  return [
    { name: "Italian", description: "italian food", centroid: unit(0) },
    { name: "Strength", description: "strength training", centroid: unit(1) },
    { name: "Cardio", description: "cardio", centroid: unit(2) },
  ];
}

describe("scoreAgainstCategories embeddingOnly", () => {
  let urls: string[] = [];
  beforeEach(() => {
    __resetScoreCacheForTests();
    urls = [];
    __setRequestUrlImpl(async (req) => {
      urls.push(req.url); // record any LLM call — there should be none
      return { status: 200, json: { response: "A" }, text: "A" };
    });
  });
  afterEach(() => __resetRequestUrlImpl());

  it("assigns top-1 nearest centroid and makes ZERO LLM calls", async () => {
    const result = await scoreAgainstCategories({
      itemIds: ["item1", "item2"],
      cache: mkCache(),
      categories: mkCats(),
      embeddingOnly: true,
      threshold: 0,
    });
    expect(urls.length).toBe(0); // no rerank
    expect(result.assignments.get("item1")).toBe("Italian");
    expect(result.assignments.get("item2")).toBe("Strength");
    expect(result.matchDetails.get("item1")?.reason).toMatch(/^emb-top1/);
    expect(result.matchDetails.get("item1")?.decision).toBe("agree");
  });

  it("honors the similarity floor: below-threshold items go unmatched", async () => {
    const result = await scoreAgainstCategories({
      itemIds: ["item1"],
      cache: mkCache(),
      categories: mkCats(),
      embeddingOnly: true,
      threshold: 1.01, // impossible cosine → must reject
    });
    expect(urls.length).toBe(0);
    expect(result.assignments.size).toBe(0);
    expect(result.unmatched).toContain("item1");
  });

  it("items without a cached vector go unmatched (no LLM)", async () => {
    const result = await scoreAgainstCategories({
      itemIds: ["missing"],
      cache: mkCache(),
      categories: mkCats(),
      embeddingOnly: true,
      threshold: 0,
    });
    expect(urls.length).toBe(0);
    expect(result.unmatched).toContain("missing");
  });
});
