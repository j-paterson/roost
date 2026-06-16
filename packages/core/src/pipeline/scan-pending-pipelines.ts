/**
 * Pending-pipeline scanner — derives a per-pipeline "pending work" count from
 * each pipeline's own cache file + candidate-id predicate, without running the
 * pipeline itself.
 *
 * Pending = uncached candidates (never triaged) + candidates triaged to the
 * extract verdict but whose extraction hasn't completed yet.
 * Stale = candidates that have a non-pending cache entry but whose
 * enrichment_v_<id> frontmatter field is below the current schemaVersion.
 * Blocked = pipeline gate is off (toggle off or LLM unavailable).
 *
 * This is the anti-nag design: an item the pipeline already triaged as "skip"
 * has a cache entry and is never counted as pending.
 */
import type { IRoostPlugin } from "@/types/plugin";
import { PIPELINE_ENRICHMENTS, type PipelineId, isVersionStale } from "@/lib/enrichments";
import { isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";
import { loadPipelineCache } from "@/pipeline/shared";
import { buildFileIndex } from "@/lib/vault-utils";

export interface PendingPipelineEntry {
  pending: number;
  stale: number;
  blocked: boolean;
}

export interface PendingPipelinesResult {
  /** Per-pipeline counts, keyed by PipelineId. */
  byPipeline: Record<string, PendingPipelineEntry>;
  /** Pending roostIds per pipeline (for dedup in headline total). */
  pendingItemIds: Record<string, string[]>;
  /** Timestamp when this scan was performed. */
  scannedAt: number;
}

export function scanPendingPipelines(
  plugin: IRoostPlugin,
  now: number,
): PendingPipelinesResult {
  const byPipeline: Record<string, PendingPipelineEntry> = {};
  const pendingItemIds: Record<string, string[]> = {};

  // Build the file index once for the stale check (frontmatter lookups).
  // The gatherCandidateIds predicates build their own internal indexes
  // (memoized loadEmbeddingCache + cheap buildFileIndex).
  const fileIndex = buildFileIndex(plugin.app, plugin.settings.syncFolder);

  for (const def of PIPELINE_ENRICHMENTS) {
    // Gate check: toggled off or LLM unavailable.
    if (!isCategoryPipelineActive(def.categoryMatches[0], plugin)) {
      byPipeline[def.id] = { pending: 0, stale: 0, blocked: true };
      pendingItemIds[def.id] = [];
      continue;
    }

    if (!def.cacheFile || !def.gatherCandidateIds || !def.pendingExtractVerdict) {
      // Missing metadata — treat as no pending work, not blocked.
      byPipeline[def.id] = { pending: 0, stale: 0, blocked: false };
      pendingItemIds[def.id] = [];
      continue;
    }

    // Load the pipeline cache (sync, reads from disk).
    const cache = loadPipelineCache<{
      triage?: string;
      extraction?: unknown | null;
      extracted?: boolean;
    }>(plugin.app.vault, def.cacheFile);

    // Get the set of candidate roostIds using the cheap id-only predicate.
    const candidateIds = def.gatherCandidateIds(plugin.app, plugin.settings.syncFolder);

    let pending = 0;
    let stale = 0;
    const pendingIds: string[] = [];

    for (const id of candidateIds) {
      const entry = cache[id];

      if (!entry) {
        // Never triaged — pending.
        pending++;
        pendingIds.push(id);
        continue;
      }

      // Triaged to the extract verdict but extraction not yet done.
      const isPendingExtract =
        entry.triage === def.pendingExtractVerdict &&
        !entry.extraction &&
        !entry.extracted;
      if (isPendingExtract) {
        pending++;
        pendingIds.push(id);
        continue;
      }

      // Not pending — check if stale (schema bump since last enrichment).
      // Only items with a recorded version field can be stale.
      const file = fileIndex.get(id);
      const fm = file
        ? (plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? undefined)
        : undefined;
      if (isVersionStale(def.id as PipelineId, fm, def.schemaVersion, def.legacyAliases)) {
        stale++;
      }
    }

    byPipeline[def.id] = { pending, stale, blocked: false };
    pendingItemIds[def.id] = pendingIds;
  }

  return { byPipeline, pendingItemIds, scannedAt: now };
}
