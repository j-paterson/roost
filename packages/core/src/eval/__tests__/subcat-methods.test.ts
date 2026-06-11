import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { predictCosine, predictT1, predictEnsemble, runCell, predictT1Margin, predictT1Gate, predictT1None } from "@/eval/subcat-methods";
import type { CellResult } from "@/eval/subcat-methods";
import type { CategoryDef } from "@/pipeline/evaluate";
import { __resetScoreCacheForTests } from "@/pipeline/evaluate";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import type { EmbeddingCacheEntry } from "@/types/roost";
import type { ScenarioFile } from "@/eval/subcat-scenarios";

function vec(arr: number[]): number[] { return arr; }

const CATS: CategoryDef[] = [
  { name: "Italian", description: "italian food", centroid: vec([1, 0, 0]) },
  { name: "French", description: "french food", centroid: vec([0, 1, 0]) },
  { name: "Japanese", description: "japanese food", centroid: vec([0, 0, 1]) },
];

describe("predictCosine", () => {
  it("picks the centroid with max cosine similarity", () => {
    const p = predictCosine(vec([0.9, 0.1, 0.1]), CATS, 0);
    expect(p.predictedSubcat).toBe("Italian");
    expect(p.sim).toBeGreaterThan(0.9);
    expect(p.llmCalls).toBe(0);
  });

  it("returns null when max sim is below the floor", () => {
    // Equal similarity to all 3 ≈ 0.577; floor 0.7 trips.
    const p = predictCosine(vec([1, 1, 1]), CATS, 0.7);
    expect(p.predictedSubcat).toBe(null);
    expect(p.sim).toBeLessThan(0.7);
  });

  it("handles zero-vector inputs without NaN", () => {
    const p = predictCosine(vec([0, 0, 0]), CATS, 0);
    // Cosine with zero magnitude is 0; argmax breaks ties by first element.
    expect(p.predictedSubcat).toBe("Italian");
    expect(p.sim).toBe(0);
  });

  it("returns null when no categories are provided", () => {
    const p = predictCosine(vec([1, 0, 0]), [], 0);
    expect(p.predictedSubcat).toBe(null);
    expect(p.sim).toBe(0);
  });
});

describe("predictT1", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  it("returns the picked subcategory and counts one LLM call", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => {
      calls++;
      return { status: 200, json: { response: "B" }, text: "B" };
    });
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian food", centroid: [1, 0, 0] },
      { name: "French", description: "french food", centroid: [0, 1, 0] },
    ];
    const p = await predictT1("x", cache, cats, 0);
    // T1 returned "B" → second candidate by topK ordering. The category def
    // ordering is preserved when topK >= categories.length.
    expect(p.llmCalls).toBe(1);
    expect(p.predictedSubcat).not.toBe(null);
    expect(calls).toBe(1);
  });

  it("returns null when chosen sim is below the floor", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [0.3, 0.3, 0.3], summary: "ambiguous", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1("x", cache, cats, 0.95);
    expect(p.predictedSubcat).toBe(null);
  });
});

describe("predictEnsemble", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  it("invokes two LLM calls per item", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => {
      calls++;
      return { status: 200, json: { response: "A" }, text: "A" };
    });
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    await predictEnsemble("x", cache, cats, 0);
    expect(calls).toBe(2);
  });
});

describe("runCell", () => {
  beforeEach(() => __resetScoreCacheForTests());

  // Fake cache + categoryDefs so cosine-only gives deterministic results.
  function buildEvalInputs() {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    // Italian items lie along [1,0,0]; French along [0,1,0].
    for (let i = 0; i < 3; i++) cache[`it${i}`] = { vec: [1, 0.05 * i, 0], summary: "", category: "food", vision: null };
    for (let i = 0; i < 3; i++) cache[`fr${i}`] = { vec: [0.05 * i, 1, 0], summary: "", category: "food", vision: null };
    cache["neg1"] = { vec: [0.4, 0.4, 0.4], summary: "", category: "food", vision: null }; // ambiguous
    return cache;
  }
  const scenarios: ScenarioFile = {
    generatedAt: "2026-04-27",
    stats: { parentsIncluded: 1, totalPositives: 6, totalNegatives: 1 },
    parents: [{
      parent: "Recipes",
      subcategories: ["Italian", "French"],
      parentCentroid: null,
      positives: [
        { itemId: "it0", trueSubcat: "Italian" },
        { itemId: "it1", trueSubcat: "Italian" },
        { itemId: "it2", trueSubcat: "Italian" },
        { itemId: "fr0", trueSubcat: "French" },
        { itemId: "fr1", trueSubcat: "French" },
        { itemId: "fr2", trueSubcat: "French" },
      ],
      negatives: [{ itemId: "neg1" }],
    }],
  };

  it("runs cosine-only across all items and reports correct counts", async () => {
    const cache = buildEvalInputs();
    const cell: CellResult = await runCell({
      method: "cosine",
      floor: 0.5,
      scenarios,
      cache,
      onProgress: () => {},
    });
    expect(cell.method).toBe("cosine");
    expect(cell.floor).toBe(0.5);
    expect(cell.perItem).toHaveLength(7);
    // All 6 positives should land on the right subcat at floor 0.5.
    expect(cell.metrics.positiveAccuracy).toBeCloseTo(1.0, 2);
    // Negative neg1 has max sim ≈ 0.577 — above 0.5 → method picks a subcat
    // (wrong). Floor compliance = 0.
    expect(cell.metrics.floorCompliance).toBe(0);
  });

  it("respects the floor — at 0.95 the negative routes to parent", async () => {
    const cache = buildEvalInputs();
    const cell = await runCell({
      method: "cosine",
      floor: 0.95,
      scenarios,
      cache,
      onProgress: () => {},
    });
    // Negative now correctly routes to parent (sim < 0.95 → null).
    expect(cell.metrics.floorCompliance).toBe(1);
    // Positives: only the items with sim ≥ 0.95 remain — depending on the
    // exact item vectors, some may now route to parent. Assert a lower bound
    // on combinedAccuracy as a smoke check.
    expect(cell.metrics.combinedAccuracy).toBeGreaterThanOrEqual(0.5);
  });
});

describe("predictT1Margin", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  it("returns null when picked sim and runner-up sim are within margin", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [0.71, 0.71, 0], summary: "ambiguous", category: "food", vision: null },
    };
    // Italian and French centroids are both ~equidistant from the item:
    // sim(item, Italian) = sim(item, French) ≈ 0.71. Margin near 0.
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1Margin("x", cache, cats, 0, 0.05);
    expect(p.predictedSubcat).toBe(null);
  });

  it("returns the pick when the margin clears the threshold", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    // sim(item, Italian) = 1.0; sim(item, French) = 0. Margin = 1.0.
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1Margin("x", cache, cats, 0, 0.05);
    expect(p.predictedSubcat).not.toBe(null);
  });

  it("counts the same llmCalls as predictT1 (margin is post-hoc)", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => {
      calls++;
      return { status: 200, json: { response: "A" }, text: "A" };
    });
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1Margin("x", cache, cats, 0, 0.0);
    expect(p.llmCalls).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("predictT1Gate", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  it("returns null without calling T1 when parent sim is below gate", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => {
      calls++;
      return { status: 200, json: { response: "A" }, text: "A" };
    });
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [0, 0, 1], summary: "weakly Recipes", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    // Parent centroid is along [1,1,0]/sqrt(2). Item is along [0,0,1].
    // Cosine = 0 → far below gate 0.5. Should short-circuit.
    const parentCentroid = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const p = await predictT1Gate("x", cache, cats, 0, parentCentroid, 0.5);
    expect(p.predictedSubcat).toBe(null);
    expect(p.llmCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("calls T1 normally when parent sim clears the gate", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => {
      calls++;
      return { status: 200, json: { response: "A" }, text: "A" };
    });
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const parentCentroid = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const p = await predictT1Gate("x", cache, cats, 0, parentCentroid, 0.5);
    expect(p.predictedSubcat).not.toBe(null);
    expect(p.llmCalls).toBe(1);
    expect(calls).toBe(1);
  });

  it("returns null without LLM call when parentCentroid is null", async () => {
    let calls = 0;
    __setRequestUrlImpl(async () => {
      calls++;
      return { status: 200, json: { response: "A" }, text: "A" };
    });
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
    ];
    const p = await predictT1Gate("x", cache, cats, 0, null, 0.5);
    expect(p.predictedSubcat).toBe(null);
    expect(p.llmCalls).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("runCell with t1-margin", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  // Use cosine-like setup but feed via t1-margin so we exercise the dispatcher.
  function buildEvalInputs() {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    cache["it0"] = { vec: [1, 0, 0], summary: "italian", category: "food", vision: null };
    cache["fr0"] = { vec: [0, 1, 0], summary: "french", category: "food", vision: null };
    return cache;
  }

  it("dispatches t1-margin and respects the marginThreshold", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const cache = buildEvalInputs();
    const scenarios: ScenarioFile = {
      generatedAt: "2026-04-28",
      stats: { parentsIncluded: 1, totalPositives: 2, totalNegatives: 0 },
      parents: [{
        parent: "Recipes",
        subcategories: ["Italian", "French"],
        parentCentroid: [Math.SQRT1_2, Math.SQRT1_2, 0],
        positives: [
          { itemId: "it0", trueSubcat: "Italian" },
          { itemId: "fr0", trueSubcat: "French" },
        ],
        negatives: [],
      }],
    };

    const cell = await runCell({
      method: "t1-margin",
      floor: 0,
      marginThreshold: 0.5, // moderate margin
      scenarios,
      cache,
      onProgress: () => {},
    });
    expect(cell.method).toBe("t1-margin");
    expect(cell.secondaryThreshold).toBe(0.5);
    expect(cell.perItem).toHaveLength(2);
  });
});

describe("predictT1None", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  it("returns null when LLM picks N", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "N" }, text: "N" }));
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [0, 0, 1], summary: "off-topic", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1None("x", cache, cats, 0);
    expect(p.predictedSubcat).toBe(null);
    expect(p.llmCalls).toBe(1);
  });

  it("returns the picked subcategory when LLM picks a letter A-E", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1None("x", cache, cats, 0);
    expect(p.predictedSubcat).toBe("Italian");
    expect(p.llmCalls).toBe(1);
  });

  it("returns null when picked sim is below the floor", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "A" }, text: "A" }));
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vec: [0.4, 0.4, 0.4], summary: "ambiguous", category: "food", vision: null },
    };
    const cats: CategoryDef[] = [
      { name: "Italian", description: "italian", centroid: [1, 0, 0] },
      { name: "French", description: "french", centroid: [0, 1, 0] },
    ];
    const p = await predictT1None("x", cache, cats, 0.95);
    expect(p.predictedSubcat).toBe(null);
  });
});
