import { describe, it, expect } from "vitest";
import { PIPELINE_ENRICHMENT_IDS } from "@/lib/enrichments";
import { DEFAULT_SETTINGS } from "@/settings";

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
});
