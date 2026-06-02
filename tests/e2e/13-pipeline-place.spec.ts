/**
 * Place pipeline E2E — sidebar play button triggers extraction.
 *
 * Pattern documented in 12-pipeline-recipe.spec.ts. Fixture:
 * bm_e2e_pipe_place_1.md with `tags: ["travel", "restaurant"]`.
 */

import {
  setupPipelineSpec, teardownPipelineSpec, runPipelineAndAssert,
  type PipelineSpecConfig, type PipelineSpecState,
} from "./pipeline-spec-helpers.js";

const CFG: PipelineSpecConfig = {
  label: "13-pipeline-place",
  category: "Places",
  cacheFile: "places-cache.json",
  outputDir: "Pipelines/Places",
  expectedIds: ["bm_e2e_pipe_place_1"],
  triagePromptMarker: "place or skip",
  triageResponse: "place",
  // No-POI extraction prompt — see places-pipeline.ts buildExtractPromptNoPoi.
  extractPromptMarker: "Extract place/location information",
  extraction: {
    name: "Trattoria Da Test",
    city: "Rome",
    country: "Italy",
    placeType: "restaurant",
    description: "A neighborhood trattoria with classic Roman fare.",
    vibes: ["cozy", "local"],
    bestFor: "casual dinner",
    tips: ["go before 7pm", "cash preferred"],
    address: null,
  },
  noteAssertContains: "Trattoria Da Test",
};

describe("Place pipeline E2E — play button triggers extraction", function () {
  let state: PipelineSpecState;

  before(async function () { state = await setupPipelineSpec(CFG); });
  after(async function () { await teardownPipelineSpec(CFG, state); });

  it("clicking Places play button writes notes and updates the cache", async function () {
    if (!state.stubBound) { this.skip(); return; }
    await runPipelineAndAssert(CFG, state);
  });
});
