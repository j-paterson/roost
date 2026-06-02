/**
 * Tutorial pipeline E2E — sidebar play button triggers extraction.
 *
 * Pattern documented in 12-pipeline-recipe.spec.ts. Fixture:
 * bm_e2e_pipe_tutorial_1.md with `tags: ["tutorial", "photoshop"]`.
 */

import {
  setupPipelineSpec, teardownPipelineSpec, runPipelineAndAssert,
  type PipelineSpecConfig, type PipelineSpecState,
} from "./pipeline-spec-helpers.js";

const CFG: PipelineSpecConfig = {
  label: "16-pipeline-tutorial",
  category: "Tutorial",
  cacheFile: "tutorials-cache.json",
  outputDir: "Pipelines/Tutorials",
  expectedIds: ["bm_e2e_pipe_tutorial_1"],
  triagePromptMarker: "tutorial or skip",
  triageResponse: "tutorial",
  extractPromptMarker: "Extract the tutorial",
  extraction: {
    skillArea: "Digital art",
    topic: "Test Background Removal",
    description: "A test tutorial for the e2e fixture.",
    steps: ["Open image.", "Use the magic wand tool.", "Refine edges."],
    difficulty: "beginner",
    tools: ["Photoshop"],
    timeEstimate: "30s",
  },
  noteAssertContains: "Test Background Removal",
};

describe("Tutorial pipeline E2E — play button triggers extraction", function () {
  let state: PipelineSpecState;

  before(async function () { state = await setupPipelineSpec(CFG); });
  after(async function () { await teardownPipelineSpec(CFG, state); });

  it("clicking Tutorial play button writes notes and updates the cache", async function () {
    if (!state.stubBound) { this.skip(); return; }
    await runPipelineAndAssert(CFG, state);
  });
});
