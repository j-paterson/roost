/**
 * Recipe pipeline E2E — sidebar play button triggers extraction.
 *
 * Verifies the pipeline-trigger UI (library-tree.tsx:309 — the play button on
 * the Recipes tree row) drives the recipe extraction pipeline end-to-end with
 * a stubbed Ollama: triage prompt → "recipe", extract prompt → fixed JSON.
 *
 * Companion to recipe-pipeline-integration.test.ts (vitest, fake App). The
 * vitest test exercises runRecipePipeline() directly; this spec exercises the
 * full UI → runner → vault-write loop in a real Obsidian instance.
 *
 * Fixture pre-reqs: bm_e2e_pipe_recipe_{1,2}.md with `tags: ["recipe"]`. The
 * recipe pipeline matches via gatherCandidates' tagMatch path.
 */

import {
  setupPipelineSpec, teardownPipelineSpec, runPipelineAndAssert,
  type PipelineSpecConfig, type PipelineSpecState,
} from "./pipeline-spec-helpers.js";

const CFG: PipelineSpecConfig = {
  label: "12-pipeline-recipe",
  category: "Recipes",
  cacheFile: "recipe-cache.json",
  outputDir: "Pipelines/Recipes",
  expectedIds: ["bm_e2e_pipe_recipe_1", "bm_e2e_pipe_recipe_2"],
  triagePromptMarker: "recipe, restaurant, or skip",
  triageResponse: "recipe",
  extractPromptMarker: "Extract the recipe",
  extraction: {
    dish: "Test Dish",
    cuisine: "Italian",
    ingredients: [{ item: "tomato", qty: "2 cups" }],
    steps: ["Step 1.", "Step 2."],
    prepTime: "10m",
    cookTime: "20m",
    difficulty: "easy",
    notes: null,
  },
  noteAssertContains: "Test Dish",
};

describe("Recipe pipeline E2E — play button triggers extraction", function () {
  let state: PipelineSpecState;

  before(async function () { state = await setupPipelineSpec(CFG); });
  after(async function () { await teardownPipelineSpec(CFG, state); });

  it("clicking Recipes play button writes notes and updates the cache", async function () {
    if (!state.stubBound) { this.skip(); return; }
    await runPipelineAndAssert(CFG, state);
  });
});
