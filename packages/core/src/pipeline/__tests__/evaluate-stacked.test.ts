/**
 * Integration test for the stacked-head scoring path in scoreAgainstCategories.
 *
 * TDD step 1 (red): this test was written BEFORE the implementation.
 * When `opts.stackedHeads` is present AND `embeddingOnly` is true,
 * `classifyStacked(entry.vecText ?? entry.vec, entry.vec, stackedHeads)` must
 * be used instead of `classifyWithHead` or nearest-centroid.
 *
 * Proves the existing single-head + centroid paths are unchanged: see
 * evaluate-embedding-only.test.ts (must stay green).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { scoreAgainstCategories, __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";
import { mkStackedHeads, unit } from "./helpers-stacked";

/**
 * Cache where item1 has both vec and vecText pointing at unit(0) (→ Italian),
 * and item2 has vecText=unit(1) but vec=unit(2) — confirms vecText drives the
 * text head while vec drives the vision head.
 *
 * item2 trace (mkStackedHeads meta: text weight 20, vision weight 5):
 *   text head: unit(1) → pText≈[0,1,0]
 *   vision head: unit(2) → pVision≈[0,0,1]
 *   feat≈[0,1,0, 0,0,1]
 *   z[1] = 20*1 + 5*0 = 20 (text says Strength)
 *   z[2] = 20*0 + 5*1 = 5  (vision says Cardio, outweighed)
 *   → "Strength" with conf >> HEAD_REJECT_TAU ✓
 */
function mkCache(): Record<string, EmbeddingCacheEntry> {
  return {
    item1: {
      vision: null,
      vec: unit(0),
      vecText: unit(0),
      summary: "pasta carbonara",
      category: "food",
    },
    item2: {
      vision: null,
      vec: unit(2), // deliberately different from vecText to prove vecText is used
      vecText: unit(1),
      summary: "back squat",
      category: "fitness",
    },
  };
}

function mkCats(): CategoryDef[] {
  return [
    { name: "Italian", description: "italian food", centroid: unit(0) },
    { name: "Strength", description: "strength training", centroid: unit(1) },
    { name: "Cardio", description: "cardio", centroid: unit(2) },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scoreAgainstCategories stacked path", () => {
  let urls: string[] = [];

  beforeEach(() => {
    __resetScoreCacheForTests();
    urls = [];
    __setRequestUrlImpl(async (req) => {
      urls.push(req.url);
      return { status: 200, json: { response: "A" }, text: "A" };
    });
  });
  afterEach(() => __resetRequestUrlImpl());

  it("uses classifyStacked and makes ZERO LLM calls when stackedHeads + embeddingOnly", async () => {
    const result = await scoreAgainstCategories({
      itemIds: ["item1", "item2"],
      cache: mkCache(),
      categories: mkCats(),
      embeddingOnly: true,
      stackedHeads: mkStackedHeads(),
      threshold: 0,
    });

    expect(urls.length).toBe(0); // no LLM calls at all

    expect(result.assignments.get("item1")).toBe("Italian");
    expect(result.assignments.get("item2")).toBe("Strength");

    // Reason string must indicate the stacked path, not head or emb-top1
    const r1 = result.matchDetails.get("item1")?.reason ?? "";
    const r2 = result.matchDetails.get("item2")?.reason ?? "";
    expect(r1).toMatch(/stacked/);
    expect(r2).toMatch(/stacked/);
  });

  it("uses vecText (not vec) as the text embedding when both are present", async () => {
    // item2: vecText=unit(1) (→ Strength), vec=unit(2) (→ Cardio on nearest-centroid)
    // The stacked path should produce Strength because vecText drives the text head.
    const result = await scoreAgainstCategories({
      itemIds: ["item2"],
      cache: mkCache(),
      categories: mkCats(),
      embeddingOnly: true,
      stackedHeads: mkStackedHeads(),
      threshold: 0,
    });
    expect(result.assignments.get("item2")).toBe("Strength");
  });

  it("falls back to vec when vecText is null (item predates dual-embedding)", async () => {
    const cacheWithNullVecText: Record<string, EmbeddingCacheEntry> = {
      itemA: {
        vision: null,
        vec: unit(0),
        vecText: null, // simulates pre-Task-3 item
        summary: "pizza",
        category: "food",
      },
    };
    const result = await scoreAgainstCategories({
      itemIds: ["itemA"],
      cache: cacheWithNullVecText,
      categories: mkCats(),
      embeddingOnly: true,
      stackedHeads: mkStackedHeads(),
      threshold: 0,
    });
    // With vecText=null we pass vec (unit(0)) to both heads → Italian
    expect(result.assignments.get("itemA")).toBe("Italian");
    expect(result.matchDetails.get("itemA")?.reason).toMatch(/stacked/);
  });

  it("items without a cached vec go unmatched even with stackedHeads", async () => {
    const result = await scoreAgainstCategories({
      itemIds: ["missing"],
      cache: mkCache(),
      categories: mkCats(),
      embeddingOnly: true,
      stackedHeads: mkStackedHeads(),
      threshold: 0,
    });
    expect(result.unmatched).toContain("missing");
    expect(result.assignments.size).toBe(0);
  });
});
