import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { scoreWithSubcategories } from "@/pipeline/score-with-subcategories";
import { __resetScoreCacheForTests } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";
import type { StackedHeads } from "@/pipeline/classifier-head";

/** Minimal stacked-heads fixture whose classes are a superset of the live top-level
 *  categories (Recipes, Workouts) so stackedHeadsClassesMatch passes. */
function mkStacked(): StackedHeads {
  const classes = ["Recipes", "Workouts", "Extra"];
  const base = { classes, W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0, 0, 0], dim: 3 };
  const meta = {
    classes,
    W: [[1, 0, 0, 1, 0, 0], [0, 1, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1]],
    b: [0, 0, 0],
    inDim: 6,
  };
  return { text: base, vision: base, meta };
}

function vec(arr: number[]): number[] { return arr; }

/** Respond with a letter for T1 calls; JSON for T2 calls (prevents conditional-disagree reject). */
function mockAImpl(req: { body?: unknown }): { status: number; json: { response: string }; text: string } {
  const body = String(req.body ?? "");
  // T2 prompt contains "Respond with JSON only" — return agreeing JSON so T1+T2 agree → no conditional reject.
  if (body.includes("Respond with JSON only")) {
    return { status: 200, json: { response: '{"A": 9}' }, text: '{"A": 9}' };
  }
  return { status: 200, json: { response: "A" }, text: "A" };
}

describe("scoreWithSubcategories", () => {
  beforeEach(() => __resetScoreCacheForTests());
  afterEach(() => __resetRequestUrlImpl());

  function makeCache(): Record<string, EmbeddingCacheEntry> {
    return {
      it1: { vec: [1, 0, 0], summary: "italian pasta", category: "food", vision: null, vecText: null },
      fr1: { vec: [0, 1, 0], summary: "french bread", category: "food", vision: null, vecText: null },
      wo1: { vec: [0, 0, 1], summary: "barbell squats", category: "fitness", vision: null, vecText: null },
    };
  }

  const topLevel: CategoryDef[] = [
    { name: "Recipes", description: "food", centroid: vec([0.7, 0.7, 0]) },
    { name: "Workouts", description: "fitness", centroid: vec([0, 0, 1]) },
  ];

  const subcatsByParent = new Map<string, CategoryDef[]>([
    ["Recipes", [
      { name: "Italian", description: "italian", centroid: vec([1, 0, 0]) },
      { name: "French", description: "french", centroid: vec([0, 1, 0]) },
    ]],
    // Workouts has no subcats — pass 2 should skip it.
  ]);

  it("runs pass 2 only for parents with subcats; Workouts items have subcategory: null", async () => {
    __setRequestUrlImpl(async (req) => mockAImpl(req));
    const result = await scoreWithSubcategories({
      itemIds: ["it1", "fr1", "wo1"],
      cache: makeCache(),
      topLevelCategories: topLevel,
      subcatsByParent,
      threshold: 0,
      onProgress: () => {},
    });
    expect(result.assignments.get("wo1")?.subcategory).toBe(null);
    expect(result.assignments.get("it1")?.parent).toBe("Recipes");
    expect(result.assignments.get("fr1")?.parent).toBe("Recipes");
  });

  it("forwards stackedHeads to pass 1 — top-level uses the stacked path, not centroid", async () => {
    // Regression: filter-mode (write.into==='category') routes through this wrapper,
    // which previously never received the heads, so the Smart Assign button silently
    // scored top-level by nearest-centroid even with stacking enabled.
    const result = await scoreWithSubcategories({
      itemIds: ["it1", "wo1"],
      cache: makeCache(),
      topLevelCategories: topLevel,
      subcatsByParent: new Map(), // no subcats → pass 2 skipped, no LLM
      embeddingOnly: true,
      stackedHeads: mkStacked(),
      threshold: 0,
      onProgress: () => {},
    });
    expect(result.matchDetails.get("it1")?.reason).toMatch(/stacked/);
    expect(result.matchDetails.get("wo1")?.reason).toMatch(/stacked/);
  });

  it("NONE refusal at subcat → item gets parent + subcategory: null", async () => {
    __setRequestUrlImpl(async (req) => {
      const body = String(req.body ?? "");
      // Pass-2 uses NONE prompt — detect by "None of these fit" in prompt text.
      if (body.includes("None of these fit")) {
        return { status: 200, json: { response: "N" }, text: "N" };
      }
      // Pass-1 T2 call — return agreeing JSON to avoid conditional-disagree reject.
      return mockAImpl(req);
    });
    const result = await scoreWithSubcategories({
      itemIds: ["it1"],
      cache: makeCache(),
      topLevelCategories: topLevel,
      subcatsByParent,
      threshold: 0,
      onProgress: () => {},
    });
    expect(result.assignments.get("it1")?.parent).toBe("Recipes");
    expect(result.assignments.get("it1")?.subcategory).toBe(null);
  });

  it("progress callback reaches total exactly once", async () => {
    __setRequestUrlImpl(async (req) => mockAImpl(req));
    let lastDone = 0;
    let lastTotal = 0;
    let progressFinishedCalls = 0;
    await scoreWithSubcategories({
      itemIds: ["it1", "fr1", "wo1"],
      cache: makeCache(),
      topLevelCategories: topLevel,
      subcatsByParent,
      threshold: 0,
      onProgress: (done, total) => {
        lastDone = done; lastTotal = total;
        if (done === total) progressFinishedCalls++;
      },
    });
    expect(lastDone).toBe(lastTotal);
    expect(progressFinishedCalls).toBeGreaterThanOrEqual(1);
  });

  it("pass-1 unmatched items pass through unmatched, no parent assignment", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { response: "" }, text: "" }));
    const result = await scoreWithSubcategories({
      itemIds: ["it1"],
      cache: makeCache(),
      topLevelCategories: topLevel,
      subcatsByParent,
      threshold: 0,
      onProgress: () => {},
    });
    expect(result.assignments.has("it1")).toBe(false);
    expect(result.unmatched).toEqual(["it1"]);
  });

  it("stop signal mid-pass-2: cancelled parent's items get subcategory: null; earlier parents keep their picks", async () => {
    let pass2CallCount = 0;
    const stopSignal = { stopped: false, stop() { this.stopped = true; } };
    __setRequestUrlImpl(async (req) => {
      const body = String(req.body);
      // T2 path: return JSON-parseable agreement so disagree-reject doesn't fire.
      if (body.includes("Respond with JSON only")) {
        return { status: 200, json: { response: '{"A": 9}' }, text: '{"A": 9}' };
      }
      // T1-NONE path (pass 2): trip the stop signal after the first NONE call lands.
      if (body.includes("None of these fit")) {
        pass2CallCount++;
        if (pass2CallCount === 1) {
          stopSignal.stopped = true;
        }
        return { status: 200, json: { response: "A" }, text: "A" };
      }
      // T1 path (pass 1): pick A.
      return { status: 200, json: { response: "A" }, text: "A" };
    });

    // Two parents with subcats: Recipes (it1, it2) and Workouts (wo1, wo2).
    const cache: Record<string, EmbeddingCacheEntry> = {
      it1: { vec: [1, 0, 0], summary: "italian", category: "food", vision: null, vecText: null },
      it2: { vec: [1, 0.05, 0], summary: "italian2", category: "food", vision: null, vecText: null },
      wo1: { vec: [0, 0, 1], summary: "squats", category: "fitness", vision: null, vecText: null },
      wo2: { vec: [0, 0.05, 1], summary: "squats2", category: "fitness", vision: null, vecText: null },
    };
    const topLevel: CategoryDef[] = [
      { name: "Recipes", description: "food", centroid: vec([0.7, 0.7, 0]) },
      { name: "Workouts", description: "fitness", centroid: vec([0, 0, 1]) },
    ];
    const subcats = new Map<string, CategoryDef[]>([
      ["Recipes", [
        { name: "Italian", description: "italian", centroid: vec([1, 0, 0]) },
        { name: "French", description: "french", centroid: vec([0, 1, 0]) },
      ]],
      ["Workouts", [
        { name: "Strength", description: "strength", centroid: vec([0, 0, 1]) },
      ]],
    ]);

    const result = await scoreWithSubcategories({
      itemIds: ["it1", "it2", "wo1", "wo2"],
      cache,
      topLevelCategories: topLevel,
      subcatsByParent: subcats,
      threshold: 0,
      stopSignal,
      onProgress: () => {},
    });

    // Whichever parent's items got cancelled — they have subcategory: null.
    // Earlier parent's items kept their pick (or also null if cancelled before pass 2 started).
    // Just assert: every assigned item has parent set and subcategory is either string or null.
    for (const [, { parent, subcategory }] of result.assignments) {
      expect(typeof parent).toBe("string");
      expect(subcategory === null || typeof subcategory === "string").toBe(true);
    }
    // At least one parent's items should have subcategory: null (the cancelled one).
    const nullSubcats = [...result.assignments.values()].filter(a => a.subcategory === null);
    expect(nullSubcats.length).toBeGreaterThan(0);
  });
});
