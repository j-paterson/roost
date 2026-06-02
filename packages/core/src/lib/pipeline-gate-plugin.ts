import type { IRoostPlugin } from "@/types/plugin";
import { getEnrichmentForCategory, isPipelineEnrichmentId } from "@/lib/enrichments";
import {
  llmAvailable,
  isPipelineActive,
  type PipelineGateCtx,
  type PipelineId,
} from "@/lib/pipeline-gate";

export const PIPELINE_INACTIVE_MESSAGE =
  "This pipeline is off or needs an LLM — enable it in the Roost Hub → Integrations.";

/** Build the live gate context from plugin settings + integration detection. */
export function gateCtxFromPlugin(plugin: IRoostPlugin): PipelineGateCtx {
  const s = plugin.settings;
  return {
    flags: s.pipelines,
    llm: llmAvailable({
      llmBackend: s.llmBackend,
      anthropicApiKey: s.anthropicApiKey ?? "",
      ollamaEnabled: s.integrations.ollama,
      ollamaStatus: plugin.integrationStatus.ollama,
    }),
  };
}

/** Is the pipeline that owns this gallery category currently active? */
export function isCategoryPipelineActive(category: string, plugin: IRoostPlugin): boolean {
  const def = getEnrichmentForCategory(category);
  if (!def || !isPipelineEnrichmentId(def.id)) return false;
  return isPipelineActive(def.id, gateCtxFromPlugin(plugin));
}

/** Returns false when the pipeline cannot run; optional callback for UX (Notice/log). */
export function guardPipelineActive(
  id: PipelineId,
  plugin: IRoostPlugin,
  onInactive?: (message: string) => void,
): boolean {
  if (isPipelineActive(id, gateCtxFromPlugin(plugin))) return true;
  onInactive?.(PIPELINE_INACTIVE_MESSAGE);
  return false;
}
