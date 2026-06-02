/**
 * Home pipeline E2E — sidebar play button triggers extraction.
 *
 * Pattern documented in 12-pipeline-recipe.spec.ts. Fixture:
 * bm_e2e_pipe_home_1.md with `tags: ["homedecor", "organization"]`.
 */

import {
  setupPipelineSpec, teardownPipelineSpec, runPipelineAndAssert,
  type PipelineSpecConfig, type PipelineSpecState,
} from "./pipeline-spec-helpers.js";

const CFG: PipelineSpecConfig = {
  label: "18-pipeline-home",
  category: "Home",
  cacheFile: "home-cache.json",
  outputDir: "Pipelines/Home",
  expectedIds: ["bm_e2e_pipe_home_1"],
  triagePromptMarker: "home or skip",
  triageResponse: "home",
  extractPromptMarker: "Extract the home/interior design idea",
  extraction: {
    room: "Kitchen",
    ideaType: "organization",
    title: "Test Renter Kitchen Organization",
    description: "A test home idea for the e2e fixture.",
    products: ["over-cabinet hooks", "stackable bins"],
    style: "modern",
    budget: "$",
    tips: ["measure first", "use Command strips"],
  },
  noteAssertContains: "Test Renter Kitchen Organization",
};

describe("Home pipeline E2E — play button triggers extraction", function () {
  let state: PipelineSpecState;

  before(async function () { state = await setupPipelineSpec(CFG); });
  after(async function () { await teardownPipelineSpec(CFG, state); });

  it("clicking Home play button writes notes and updates the cache", async function () {
    if (!state.stubBound) { this.skip(); return; }
    await runPipelineAndAssert(CFG, state);
  });
});
