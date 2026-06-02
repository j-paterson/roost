/**
 * Product pipeline E2E — sidebar play button triggers extraction.
 *
 * Pattern documented in 12-pipeline-recipe.spec.ts. Fixture:
 * bm_e2e_pipe_product_1.md with `tags: ["amazonfinds", "product"]`.
 */

import {
  setupPipelineSpec, teardownPipelineSpec, runPipelineAndAssert,
  type PipelineSpecConfig, type PipelineSpecState,
} from "./pipeline-spec-helpers.js";

const CFG: PipelineSpecConfig = {
  label: "15-pipeline-product",
  category: "Product",
  cacheFile: "products-cache.json",
  outputDir: "Pipelines/Products",
  expectedIds: ["bm_e2e_pipe_product_1"],
  triagePromptMarker: "product or skip",
  triageResponse: "product",
  extractPromptMarker: "Extract the product recommendation",
  extraction: {
    productType: "kitchen utensils",
    name: "Test Silicone Set",
    brand: "TestBrand",
    price: "$19.99",
    rating: null,
    whereToBuy: "https://example.com/test-silicone-set",
    description: "A test product for the e2e fixture.",
  },
  noteAssertContains: "Test Silicone Set",
};

describe("Product pipeline E2E — play button triggers extraction", function () {
  let state: PipelineSpecState;

  before(async function () { state = await setupPipelineSpec(CFG); });
  after(async function () { await teardownPipelineSpec(CFG, state); });

  it("clicking Product play button writes notes and updates the cache", async function () {
    if (!state.stubBound) { this.skip(); return; }
    await runPipelineAndAssert(CFG, state);
  });
});
