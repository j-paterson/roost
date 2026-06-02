import { useState, useCallback } from "react";
import { getEnrichmentForCategory } from "@/lib/enrichments";
import type { PipelineRowState } from "@/ui/components/library-tree";
import type { IRoostPlugin } from "@/types/plugin";
import { isCategoryPipelineActive, PIPELINE_INACTIVE_MESSAGE } from "@/lib/pipeline-gate-plugin";

/** Pipeline state is keyed by run scope so a subcategory run doesn't
 *  stomp the parent's running indicator. Top-level: "Media". Subcategory:
 *  "Media::Books". library-tree renders each row by looking up its own
 *  scope key. */
function pipelineScopeKey(category: string, subcategory?: string): string {
  return subcategory ? `${category}::${subcategory}` : category;
}

export type UseRoostPipelineRowsParams = {
  plugin: IRoostPlugin;
  log: (msg: string) => void;
};

export function useRoostPipelineRows({ plugin, log }: UseRoostPipelineRowsParams) {
  const [pipelineState, setPipelineState] = useState<Record<string, PipelineRowState>>({});

  const handleRunPipeline = useCallback(async (category: string, subcategory?: string) => {
    const enrichment = getEnrichmentForCategory(category);
    if (!enrichment) return;
    if (!isCategoryPipelineActive(category, plugin)) {
      log(`Pipeline for "${category}" — ${PIPELINE_INACTIVE_MESSAGE}`);
      return;
    }
    const key = pipelineScopeKey(category, subcategory);
    const controller = new AbortController();
    setPipelineState(s => ({ ...s, [key]: { status: "running", controller } }));
    try {
      await enrichment.runBackfill(plugin, {
        onLog: log,
        signal: controller.signal,
        filter: { category, subcategory },
      });
      // Pipeline mutated frontmatter on existing items; force Bases
      // views to re-read so new fields (media_spotify_id, etc.) show.
      plugin.fireDataRefresh();
      setPipelineState(s => ({ ...s, [key]: { status: "done", finishedAt: Date.now() } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPipelineState(s => ({ ...s, [key]: { status: "error", error: msg, finishedAt: Date.now() } }));
    }
  }, [plugin, log]);

  const handleCancelPipeline = useCallback((category: string, subcategory?: string) => {
    const key = pipelineScopeKey(category, subcategory);
    setPipelineState(s => {
      s[key]?.controller?.abort();
      return s;
    });
  }, []);

  return { pipelineState, handleRunPipeline, handleCancelPipeline };
}
