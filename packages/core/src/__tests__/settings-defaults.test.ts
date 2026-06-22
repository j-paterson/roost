import { describe, it, expect } from "vitest";
import { PIPELINE_ENRICHMENT_IDS } from "@/lib/enrichments";
import { DEFAULT_SETTINGS } from "@/settings";
import { VISION_MODEL, VISION_NUM_CTX } from "@/config";

describe("DEFAULT_SETTINGS", () => {
  it("integration flags default off", () => {
    expect(DEFAULT_SETTINGS.integrations).toEqual({
      ollama: false,
      sidecar: false,
      ffmpeg: false,
      vaultSearch: false,
    });
  });

  it("pipeline flags match registry ids and default on", () => {
    expect(Object.keys(DEFAULT_SETTINGS.pipelines).sort()).toEqual(
      [...PIPELINE_ENRICHMENT_IDS].sort(),
    );
    expect(Object.values(DEFAULT_SETTINGS.pipelines).every(Boolean)).toBe(true);
  });

  it("defaults smartAssignStacking to false", () => {
    expect(DEFAULT_SETTINGS.smartAssignStacking).toBe(false);
  });
});

it("vision model is qwen cover-only at num_ctx 4096", () => {
  expect(VISION_MODEL).toBe("huihui_ai/qwen2.5-vl-abliterated:latest");
  expect(VISION_NUM_CTX).toBe(4096);
});
