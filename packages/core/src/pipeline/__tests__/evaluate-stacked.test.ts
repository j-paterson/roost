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
import type { StackedHeads } from "@/pipeline/classifier-head";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a unit vector with 1 at position i in a dim-dimensional space. */
function unit(i: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
}

/**
 * Build a StackedHeads fixture with C=3 classes and dim=4 embeddings.
 *
 * Classes: ["Italian", "Strength", "Cardio"] — matches mkCats() so
 * stackedHeadsClassesMatch passes.
 *
 * Text/vision heads: W[c][c] = 10, rest 0; b = 0.
 *   unit(0) → argmax 0 → "Italian"
 *   unit(1) → argmax 1 → "Strength"
 *   unit(2) → argmax 2 → "Cardio"
 *
 * Meta head: inDim = 2*C = 6.
 * feat = [...pText (len 3), ...pVision (len 3)]
 * W[c] has 10 at positions c (pText[c]) and c+3 (pVision[c]).
 *   unit(0)/unit(0) → pText≈[1,0,0], pVision≈[1,0,0] → z[0]≈20 → "Italian"
 *   unit(1)/unit(1) → pText≈[0,1,0], pVision≈[0,1,0] → z[1]≈20 → "Strength"
 *
 * Crucially, vecText and vec point to DIFFERENT slots for item2 (vecText=unit(1), vec=unit(2))
 * so the test confirms vecText drives the text head while vec drives the vision head:
 *   pText from unit(1) ≈ [0,1,0], pVision from unit(2) ≈ [0,0,1]
 *   feat ≈ [0,1,0, 0,0,1]
 *   z[0]=10*0+10*0=0, z[1]=10*1+10*0=10, z[2]=10*0+10*1=10  → softmax favours index 1 or 2
 *   But z[1]=z[2]=10 so we need a tiebreak. Add small b bias: b[1]=0.1 > b[2]=0 → "Strength".
 */
function mkStackedHeads(): StackedHeads {
  const C = 3;
  const dim = 4;
  const classes = ["Italian", "Strength", "Cardio"];

  // Single-embedding base head: W[c][c] = 10, rest 0; b = [0,0,0].
  const makeBaseHead = () => ({
    classes,
    W: Array.from({ length: C }, (_, c) =>
      Array.from({ length: dim }, (__, d) => (d === c ? 10 : 0)),
    ),
    b: Array<number>(C).fill(0),
    dim,
  });

  // Meta head: inDim = 2*C = 6.
  // W[c] has 10 at pText[c] (index c) and pVision[c] (index c+3).
  // b[1] = 0.1 to break the item2 tie in favour of "Strength".
  const inDim = 2 * C;
  const W = Array.from({ length: C }, (_, c) =>
    Array.from({ length: inDim }, (__, d) => (d === c || d === c + C ? 10 : 0)),
  );
  const b = Array<number>(C).fill(0);
  b[1] = 0.1; // tiny bias to break the item2 tie: Strength over Cardio
  const meta = { classes, W, b, inDim };

  return { text: makeBaseHead(), vision: makeBaseHead(), meta };
}

/**
 * Cache where item1 has both vec and vecText pointing at unit(0) (→ Italian),
 * and item2 has vecText=unit(1) but vec=unit(2) — confirms vecText drives the
 * text head, while vec drives the vision head.
 *
 * item2 vision head: unit(2) → z[0]=0, z[1]=0 (neither class matches dim 2).
 * Softmax will be [0.5, 0.5] for the vision head.
 * But text head: unit(1) → class 1 = "Strength" decisively.
 * Meta: pText=[~0,~1], pVision=[0.5,0.5] → z[0]=10*~0+10*0.5=~5, z[1]=10*~1+10*0.5=~15
 * → argmax=1 → "Strength". ✓
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
