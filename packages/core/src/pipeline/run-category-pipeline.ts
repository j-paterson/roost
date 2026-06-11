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
  /** The triage verdict that means "extract this" and is the pipeline's positive class. */
  extractVerdict: TVerdict;
  gatherCandidates(app: App, syncFolder: string): TCand[];
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
  /** Log-string fragments to reproduce each pipeline's per-message strings verbatim. */
  log: {
    candidatesFound(n: number): string;
    triageExtractCounts(uncached: number, needExtract: number, complete: number): string;
    triageProgress(done: number, total: number): string;
    wroteCached(n: number): string;
    extracting(n: number): string;
    extractProgress(done: number, total: number): string;
    done(result: TResult): string;
  };
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
  const candidates = config.gatherCandidates(app, syncFolder);
  log(config.log.candidatesFound(candidates.length));

  const uncached = candidates.filter(c => !cache[c.roostId]);
  const needExtract = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction,
  ).length;
  log(config.log.triageExtractCounts(
    uncached.length,
    needExtract,
    candidates.length - uncached.length - needExtract,
  ));

  // 2. Triage uncached items
  let triageCount = 0;
  for (let i = 0; i < uncached.length; i += config.concurrency) {
    const batch = uncached.slice(i, i + config.concurrency);
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
        triageCount++;
      } else if (config.onTriageFailure === "skip") {
        // A triage throw becomes the skip verdict so it is not re-triaged.
        cache[batch[j].roostId] = { triage: config.skipVerdict, extraction: null };
      }
      // onTriageFailure === "leave": do nothing (uncached → retried next run).
    }

    savePipelineCache(vault, config.cacheFile, cache);
    log(config.log.triageProgress(triageCount, uncached.length));
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
  log(config.log.wroteCached(alreadyCached.length));

  const toExtract = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction,
  );
  log(config.log.extracting(toExtract.length));

  let extractCount = 0;
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
        extractCount++;
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
    log(config.log.extractProgress(extractCount, toExtract.length));
  }

  const result = config.buildResult(candidates, cache, extractErrors);
  log(config.log.done(result));
  return result;
}
