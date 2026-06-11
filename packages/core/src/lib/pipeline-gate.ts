import type { PipelineFlags } from "@/settings";
import {
  type PipelineId,
} from "@/lib/enrichments";

export type { PipelineId };

export interface LlmAvailabilityInput {
  llmBackend: "local" | "cloud" | "skip";
  anthropicApiKey: string;
  ollamaEnabled: boolean;
  ollamaStatus: "available" | "unavailable" | "unknown";
}

/** Is a usable LLM backend connected? cloud → key set; local → Ollama on+detected. */
export function llmAvailable(args: LlmAvailabilityInput): boolean {
  if (args.llmBackend === "cloud") return args.anthropicApiKey.length > 0;
  if (args.llmBackend === "local") return args.ollamaEnabled && args.ollamaStatus === "available";
  return false; // "skip"
}

export interface PipelineGateCtx {
  flags: PipelineFlags;
  llm: boolean;
}

/** A pipeline is active iff its flag is on AND an LLM is available. */
export function isPipelineActive(id: PipelineId, ctx: PipelineGateCtx): boolean {
  return ctx.llm && ctx.flags[id] === true;
}
