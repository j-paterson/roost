import type { PipelineFlags } from "@/settings";
import { PIPELINE_ENRICHMENT_IDS, type PipelineId } from "@/lib/enrichments";
import { getEnrichmentById } from "@/lib/enrichments";

export type PipelineRowStatus = "active" | "off" | "needs-llm";
export interface PipelineRow {
  id: PipelineId;
  label: string;
  blurb: string;
  enabled: boolean;
  status: PipelineRowStatus;
}

export function buildPipelineRows(flags: PipelineFlags, llm: boolean): PipelineRow[] {
  return PIPELINE_ENRICHMENT_IDS.map((id) => {
    const def = getEnrichmentById(id);
    const enabled = flags[id] === true;
    const status: PipelineRowStatus = !enabled ? "off" : llm ? "active" : "needs-llm";
    return { id, label: def?.displayName ?? id, blurb: def?.panelDetail ?? "", enabled, status };
  });
}
