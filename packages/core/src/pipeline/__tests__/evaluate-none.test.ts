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
    item1: { vec: vec(1), summary: "a video about pasta carbonara", category: "food", vision: null },
  };
}

function mkCats(): CategoryDef[] {
  return [
    { name: "Italian", description: "italian food", centroid: vec(1) },
    { name: "French", description: "french food", centroid: vec(2) },
    { name: "Strength", description: "strength training", centroid: vec(3) },
  ];
}

describe("scoreAgainstCategories noneRefusal", () => {
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    __resetScoreCacheForTests();
  });
  afterEach(() => __resetRequestUrlImpl());

  it("returns N → item lands in unmatched, never assignments", async () => {
    __setRequestUrlImpl(async (req) => {
      urls.push(req.url);
      return { status: 200, json: { response: "N" }, text: "N" };
    });
    const result = await scoreAgainstCategories({
      itemIds: ["item1"],
      cache: mkCache(),
      categories: mkCats(),
      noneRefusal: true,
      threshold: 0,
    });
    expect(result.assignments.size).toBe(0);
    expect(result.unmatched).toEqual(["item1"]);
    expect(urls.length).toBe(1);
  });

  it("returns A-E → item is assigned to that candidate", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const result = await scoreAgainstCategories({
      itemIds: ["item1"],
      cache: mkCache(),
      categories: mkCats(),
      noneRefusal: true,
      threshold: 0,
    });
    expect(result.assignments.size).toBe(1);
    expect(result.unmatched).toEqual([]);
  });

  it("invokes only one LLM call per item (no T2 in NONE mode)", async () => {
    __setRequestUrlImpl(async (req) => {
      urls.push(req.url);
      return { status: 200, json: { response: "A" }, text: "A" };
    });
    await scoreAgainstCategories({
      itemIds: ["item1"],
      cache: mkCache(),
      categories: mkCats(),
      noneRefusal: true,
      threshold: 0,
    });
    expect(urls.length).toBe(1);
  });

  it("uses isolated score-cache key — second NONE call hits cache, second non-NONE call does not", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => { calls++; return { status: 200, json: { response: "A" }, text: "A" }; });
    await scoreAgainstCategories({
      itemIds: ["item1"], cache: mkCache(), categories: mkCats(),
      noneRefusal: true, threshold: 0,
    });
    expect(calls).toBe(1);
    await scoreAgainstCategories({
      itemIds: ["item1"], cache: mkCache(), categories: mkCats(),
      noneRefusal: true, threshold: 0,
    });
    expect(calls).toBe(1);
    await scoreAgainstCategories({
      itemIds: ["item1"], cache: mkCache(), categories: mkCats(),
      threshold: 0,
    });
    expect(calls).toBe(3);
  });

  it("disableT2Rerank: true + noneRefusal: true is allowed; NONE wins", async () => {
    __setRequestUrlImpl(async (req) => { urls.push(req.url); return { status: 200, json: { response: "N" }, text: "N" }; });
    const result = await scoreAgainstCategories({
      itemIds: ["item1"], cache: mkCache(), categories: mkCats(),
      noneRefusal: true, disableT2Rerank: true, threshold: 0,
    });
    expect(result.assignments.size).toBe(0);
    expect(result.unmatched).toEqual(["item1"]);
    expect(urls.length).toBe(1);
  });
});
