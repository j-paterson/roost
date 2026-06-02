import { describe, it, expect } from "vitest";
import { gateCtxFromPlugin, isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";
import { PIPELINE_ENRICHMENT_IDS } from "@/lib/enrichments";
import type { PipelineFlags } from "@/settings";

function allPipelinesOn(): PipelineFlags {
  return Object.fromEntries(PIPELINE_ENRICHMENT_IDS.map((id) => [id, true])) as PipelineFlags;
}

function fakePlugin(overrides?: Partial<{
  settings: { llmBackend: "local" | "cloud" | "skip"; pipelines: PipelineFlags; anthropicApiKey: string; integrations: { ollama: boolean } };
  integrationStatus: { ollama: "available" | "unavailable" | "unknown" };
}>) {
  return {
    settings: {
      llmBackend: "local" as const,
      anthropicApiKey: "",
      integrations: { ollama: true },
      pipelines: allPipelinesOn(),
      ...overrides?.settings,
    },
    integrationStatus: { ollama: "available" as const, ...overrides?.integrationStatus },
  } as never;
}

describe("gateCtxFromPlugin", () => {
  it("llm true when local + ollama on + available", () => {
    expect(gateCtxFromPlugin(fakePlugin()).llm).toBe(true);
  });
  it("llm false when ollama unavailable", () => {
    expect(gateCtxFromPlugin(fakePlugin({ integrationStatus: { ollama: "unavailable" } })).llm).toBe(false);
  });
});

describe("isCategoryPipelineActive", () => {
  it("true for Recipes when recipe pipeline on + LLM ready", () => {
    expect(isCategoryPipelineActive("Recipes", fakePlugin())).toBe(true);
  });
  it("false when pipeline flag off", () => {
    expect(
      isCategoryPipelineActive(
        "Places",
        fakePlugin({
          settings: {
            llmBackend: "local",
            anthropicApiKey: "",
            integrations: { ollama: true },
            pipelines: { ...allPipelinesOn(), place: false },
          },
        }),
      ),
    ).toBe(false);
  });
  it("false for non-pipeline category", () => {
    expect(isCategoryPipelineActive("Unsorted", fakePlugin())).toBe(false);
  });
});
