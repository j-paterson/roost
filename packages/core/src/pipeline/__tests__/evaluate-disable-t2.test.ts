import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { scoreAgainstCategories, __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

function vec(seed: number, dim = 8): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i) / 2 + 0.5);
}

function mkCache(): Record<string, EmbeddingCacheEntry> {
  return {
    item1: { vision: null, vec: vec(1), summary: "a video about pasta carbonara", category: "food" },
    item2: { vision: null, vec: vec(2), summary: "a barbell back squat tutorial", category: "fitness" },
  };
}

function mkCats(): CategoryDef[] {
  return [
    { name: "Italian", description: "italian food", centroid: vec(1) },
    { name: "Strength", description: "strength training", centroid: vec(2) },
    { name: "Cardio", description: "cardio workouts", centroid: vec(3) },
  ];
}

describe("scoreAgainstCategories disableT2Rerank", () => {
  let urls: string[] = [];
  beforeEach(() => {
    __resetScoreCacheForTests();
    urls = [];
    __setRequestUrlImpl(async (req) => {
      urls.push(req.url);
      // Return a T1-style single-letter response. T2 would parse as JSON;
      // returning "A" for both means: T1 picks A, T2 fails to parse → falls
      // through to a_only. With T2 disabled we should never see a T2 call.
      return { status: 200, json: { response: "A" }, text: "A" };
    });
  });

  afterEach(() => __resetRequestUrlImpl());

  it("invokes only one LLM call per item when disableT2Rerank is true", async () => {
    const result = await scoreAgainstCategories({
      itemIds: ["item1"],
      cache: mkCache(),
      categories: mkCats(),
      disableT2Rerank: true,
      threshold: 0,
    });
    // One LLM call, not two.
    expect(urls.length).toBe(1);
    // Picks the first candidate (A → top1 of cosine-ranked categories).
    expect(result.assignments.size).toBe(1);
  });

  it("invokes two LLM calls per item by default", async () => {
    await scoreAgainstCategories({
      itemIds: ["item1"],
      cache: mkCache(),
      categories: mkCats(),
      threshold: 0,
    });
    expect(urls.length).toBe(2);
  });
});
