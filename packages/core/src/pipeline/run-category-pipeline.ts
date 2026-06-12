/**
 * Generic category-enrichment pipeline runner.
 *
 * A single parameterized skeleton that every per-category enrichment pipeline
 * can delegate to. The runner owns the cross-cutting
 * shape — load cache, gather candidates, triage uncached items in concurrent
 * batches, backfill cached extractions, extract new items in concurrent
 * batches, save after each batch, and emit progress logs — while each
 * category supplies its specifics through a {@link CategoryPipelineConfig}:
 * how to gather/triage/extract/write, which verdict means "extract this",
 * how to tally the result, and how it handles failures.
 *
 * Failure handling is deliberately config-driven (not normalized) so a pure
 * refactor can preserve each pipeline's current behavior:
 *   - triage failure: "leave" (uncached → retried next run) | "skip" (demote
 *     to the skip verdict so it is not re-triaged)
 *   - extract failure: "retry" (leave the entry for next run) | "demote"
 *     (overwrite the failed entry to the skip verdict)
 */
import type { App, TFile } from "obsidian";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";

/** Cache shape shared by all category pipelines. */
export type PipelineCacheEntry<TVerdict extends string, TExtract> = {
  triage: TVerdict;
  extraction: TExtract | null;
};
export type PipelineCache<TVerdict extends string, TExtract> =
  Record<string, PipelineCacheEntry<TVerdict, TExtract>>;

export interface CategoryPipelineConfig<
  TCand extends { roostId: string; file: TFile },
  TExtract,
  TVerdict extends string,
  TResult,
> {
  cacheFile: string;
  concurrency: number;
  /** Item noun used in the unified progress messages (the per-category plural
   *  the runner interpolates into "Wrote N cached <label>" etc.). */
  label: string;
  /** The triage verdict that means "extract this" and is the pipeline's positive class. */
  extractVerdict: TVerdict;
  gatherCandidates(app: App, syncFolder: string): TCand[];
  /** Optional synchronous pre-triage pass. When present, the runner classifies
   *  each uncached candidate via this hook before the LLM triage loop; a
   *  non-null verdict auto-caches the item (skipping the LLM). Pipelines without
   *  a tag fast-path omit this; their behavior is unchanged. */
  fastPathTriage?(c: TCand): TVerdict | null;
  triageItem(c: TCand): Promise<TVerdict>;
  extractItem(c: TCand): Promise<TExtract | null>;
  /** Optional post-extract mutation (e.g. attach a candidate-derived link to the extraction). */
  afterExtract?(extraction: TExtract, c: TCand): void;
  writeToBookmark(app: App, c: TCand, extraction: TExtract): Promise<void>;
  buildResult(candidates: TCand[], cache: PipelineCache<TVerdict, TExtract>, errors: number): TResult;
  /** Failure policy — preserves each pipeline's CURRENT behavior (do not normalize).
   *  "retry" = leave the entry for next run. "demote" = overwrite the failed
   *  entry to the skip verdict so it is not retried. */
  onExtractFailure: "retry" | "demote";
  /** Triage-phase failure policy. "leave" = uncached → retried next run.
   *  "skip" = a triage throw becomes the skip verdict so it is not re-triaged. */
  onTriageFailure: "leave" | "skip";
  /** The verdict used when a failure is demoted/skipped (e.g. "skip"). */
  skipVerdict: TVerdict;
}

export async function runCategoryPipeline<
  TCand extends { roostId: string; file: TFile },
  TExtract,
  TVerdict extends string,
  TResult,
>(
  app: App,
  syncFolder: string,
  config: CategoryPipelineConfig<TCand, TExtract, TVerdict, TResult>,
  onLog?: (msg: string) => void,
): Promise<TResult> {
  const log = onLog || (() => {});
  const vault = app.vault;
  const cache = loadPipelineCache<PipelineCacheEntry<TVerdict, TExtract>>(vault, config.cacheFile);

  // 1. Gather candidates
  log("Scanning bookmarks...");
  const candidates = config.gatherCandidates(app, syncFolder);
  log(`Found ${candidates.length} candidates`);

  const uncached = candidates.filter(c => !cache[c.roostId]);
  const needExtract = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction,
  ).length;

  // 2a. Tag fast-path pre-pass (only when a config supplies one). A non-null
  //     verdict auto-caches the item so the LLM triage loop skips it.
  let fastCount = 0;
  if (config.fastPathTriage) {
    for (const c of uncached) {
      const v = config.fastPathTriage(c);
      if (v !== null) {
        cache[c.roostId] = { triage: v, extraction: null };
        fastCount++;
      }
    }
    if (fastCount > 0) {
      savePipelineCache(vault, config.cacheFile, cache);
      log(`Tag fast-path: ${fastCount} auto-kept`);
    }
  }

  const needTriage = uncached.filter(c => !cache[c.roostId]);
  log(`${needTriage.length} need triage, ${needExtract} need extraction (${candidates.length - uncached.length - needExtract} complete)`);

  // 2b. Triage remaining items via the LLM
  if (needTriage.length > 0) {
    log(`Triaging ${needTriage.length} items...`);
    for (let i = 0; i < needTriage.length; i += config.concurrency) {
      const batch = needTriage.slice(i, i + config.concurrency);
      const results = await Promise.allSettled(
        batch.map(async c => {
          const triage = await config.triageItem(c);
          return { roostId: c.roostId, triage };
        }),
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled") {
          cache[r.value.roostId] = { triage: r.value.triage, extraction: null };
        } else if (config.onTriageFailure === "skip") {
          // A triage throw becomes the skip verdict so it is not re-triaged.
          cache[batch[j].roostId] = { triage: config.skipVerdict, extraction: null };
        }
        // onTriageFailure === "leave": do nothing (uncached → retried next run).
      }

      savePipelineCache(vault, config.cacheFile, cache);
      log(`Triaged ${Math.min(i + config.concurrency, needTriage.length)}/${needTriage.length}`);
    }
  }

  // 3. Backfill previously cached extractions onto their source bookmarks
  const alreadyCached: { extraction: TExtract; candidate: TCand }[] = [];
  for (const c of candidates) {
    const entry = cache[c.roostId];
    if (entry?.triage === config.extractVerdict && entry.extraction) {
      alreadyCached.push({ extraction: entry.extraction, candidate: c });
    }
  }
  for (const r of alreadyCached) {
    await config.writeToBookmark(app, r.candidate, r.extraction);
  }
  if (alreadyCached.length > 0) {
    log(`Wrote ${alreadyCached.length} cached ${config.label}`);
  }

  const toExtract = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction,
  );
  if (toExtract.length > 0) {
    log(`Extracting ${toExtract.length} ${config.label}...`);
  }

  let extractErrors = 0;
  for (let i = 0; i < toExtract.length; i += config.concurrency) {
    const batch = toExtract.slice(i, i + config.concurrency);
    const results = await Promise.allSettled(
      batch.map(async c => {
        const extraction = await config.extractItem(c);
        return { roostId: c.roostId, extraction, candidate: c };
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value.extraction) {
        const extraction = r.value.extraction;
        config.afterExtract?.(extraction, r.value.candidate);
        cache[r.value.roostId].extraction = extraction;
        await config.writeToBookmark(app, r.value.candidate, extraction);
      } else {
        extractErrors++;
        if (config.onExtractFailure === "demote") {
          // Overwrite the failed entry to the skip verdict so it is NOT retried.
          cache[batch[j].roostId] = { triage: config.skipVerdict, extraction: null };
        }
        // onExtractFailure === "retry": leave the entry for next run.
      }
    }

    savePipelineCache(vault, config.cacheFile, cache);
    log(`Extracted ${Math.min(i + config.concurrency, toExtract.length)}/${toExtract.length}`);
  }

  const result = config.buildResult(candidates, cache, extractErrors);
  const written = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && cache[c.roostId]?.extraction,
  ).length;
  const skipped = candidates.filter(c => cache[c.roostId]?.triage === config.skipVerdict).length;
  log(`Done: ${written} ${config.label}, ${skipped} skipped, ${extractErrors} errors`);
  return result;
}
