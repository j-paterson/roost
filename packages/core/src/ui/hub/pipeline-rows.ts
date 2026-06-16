import type { PipelineFlags } from "@/settings";
import { PIPELINE_ENRICHMENT_IDS, type PipelineId } from "@/lib/enrichments";
import { getEnrichmentById } from "@/lib/enrichments";
import type { PipelinesPending } from "@/ui/hub/state";

export type PipelineRowStatus = "active" | "off" | "needs-llm";
export interface PipelineRow {
  id: PipelineId;
  label: string;
  blurb: string;
  enabled: boolean;
  status: PipelineRowStatus;
  /** Items pending in this pipeline (uncached or triaged-to-extract but not done). */
  pending: number;
  /** Items with a stale schema version. */
  stale: number;
}

export function buildPipelineRows(
  flags: PipelineFlags,
  llm: boolean,
  pipelinesPending?: PipelinesPending,
): PipelineRow[] {
  return PIPELINE_ENRICHMENT_IDS.map((id) => {
    const def = getEnrichmentById(id);
    const enabled = flags[id] === true;
    const status: PipelineRowStatus = !enabled ? "off" : llm ? "active" : "needs-llm";
    const pendingEntry = pipelinesPending?.byPipeline.find(e => e.id === id);
    return {
      id,
      label: def?.displayName ?? id,
      blurb: def?.panelDetail ?? "",
      enabled,
      status,
      pending: pendingEntry?.pending ?? 0,
      stale: pendingEntry?.stale ?? 0,
    };
  });
}
