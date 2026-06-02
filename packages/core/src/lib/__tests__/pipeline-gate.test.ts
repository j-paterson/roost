import { describe, it, expect } from "vitest";
import { llmAvailable, isPipelineActive } from "@/lib/pipeline-gate";
import { PIPELINE_ENRICHMENT_IDS } from "@/lib/enrichments";
import type { PipelineFlags } from "@/settings";

const allOn = Object.fromEntries(PIPELINE_ENRICHMENT_IDS.map((id) => [id, true])) as PipelineFlags;

describe("llmAvailable", () => {
  it("cloud → available iff key set", () => {
    expect(llmAvailable({ llmBackend: "cloud", anthropicApiKey: "k", ollamaEnabled: false, ollamaStatus: "unknown" })).toBe(true);
    expect(llmAvailable({ llmBackend: "cloud", anthropicApiKey: "", ollamaEnabled: false, ollamaStatus: "unknown" })).toBe(false);
  });
  it("local → available iff ollama enabled + detected", () => {
    expect(llmAvailable({ llmBackend: "local", anthropicApiKey: "", ollamaEnabled: true, ollamaStatus: "available" })).toBe(true);
    expect(llmAvailable({ llmBackend: "local", anthropicApiKey: "", ollamaEnabled: true, ollamaStatus: "unavailable" })).toBe(false);
    expect(llmAvailable({ llmBackend: "local", anthropicApiKey: "", ollamaEnabled: false, ollamaStatus: "available" })).toBe(false);
  });
  it("skip → never available", () => {
    expect(llmAvailable({ llmBackend: "skip", anthropicApiKey: "k", ollamaEnabled: true, ollamaStatus: "available" })).toBe(false);
  });
});

describe("isPipelineActive", () => {
  it("false when no LLM even if flag on", () => {
    expect(isPipelineActive("recipe", { flags: allOn, llm: false })).toBe(false);
  });
  it("false when flag off even with LLM", () => {
    expect(isPipelineActive("recipe", { flags: { ...allOn, recipe: false }, llm: true })).toBe(false);
  });
  it("true when flag on and LLM available", () => {
    expect(isPipelineActive("recipe", { flags: allOn, llm: true })).toBe(true);
  });
});
