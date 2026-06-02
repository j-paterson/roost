/**
 * Workout pipeline E2E — sidebar play button triggers extraction.
 *
 * Pattern documented in 12-pipeline-recipe.spec.ts. Fixture:
 * bm_e2e_pipe_workout_1.md with `tags: ["workout", "homeworkout", "hiit"]`.
 *
 * Note: matched category is "Fitness" (per pipeline-registry.ts), not "Workouts".
 */

import {
  setupPipelineSpec, teardownPipelineSpec, runPipelineAndAssert,
  type PipelineSpecConfig, type PipelineSpecState,
} from "./pipeline-spec-helpers.js";

const CFG: PipelineSpecConfig = {
  label: "17-pipeline-workout",
  category: "Fitness",
  cacheFile: "workouts-cache.json",
  outputDir: "Pipelines/Workouts",
  expectedIds: ["bm_e2e_pipe_workout_1"],
  triagePromptMarker: "workout or skip",
  triageResponse: "workout",
  extractPromptMarker: "Extract the workout routine",
  extraction: {
    workoutType: "HIIT",
    name: "Test 20-min HIIT",
    targetArea: "full body",
    exercises: [
      { name: "burpees", reps: "10" },
      { name: "mountain climbers", reps: "30s" },
    ],
    duration: "20min",
    difficulty: "intermediate",
    equipment: [],
    notes: null,
  },
  noteAssertContains: "Test 20-min HIIT",
};

describe("Workout pipeline E2E — play button triggers extraction", function () {
  let state: PipelineSpecState;

  before(async function () { state = await setupPipelineSpec(CFG); });
  after(async function () { await teardownPipelineSpec(CFG, state); });

  it("clicking Fitness play button writes notes and updates the cache", async function () {
    if (!state.stubBound) { this.skip(); return; }
    await runPipelineAndAssert(CFG, state);
  });
});
