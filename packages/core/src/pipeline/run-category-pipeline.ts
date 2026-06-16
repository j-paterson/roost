/**
 * Generic category-enrichment pipeline runner.
 *
 * A single parameterized skeleton that every per-category enrichment pipeline
 * delegates to. The runner owns the cross-cutting shape — load cache, gather
 * candidates, fast-path + LLM triage of uncached items in concurrent batches,
 * backfill cached extractions, extract new items in concurrent batches, save
 * after each batch, emit progress logs — while each category supplies its
 * specifics through a {@link CategoryPipelineConfig}.
 *
 * Failure handling is deliberately config-driven (not normalized) so a pure
 * refactor can preserve each pipeline's current behavior:
 *   - triage failure: "leave" (uncached → retried next run) | "skip" (demote
 *     to the skip verdict so it is not re-triaged)
 *   - extract failure: "retry" (leave the entry for next run) | "demote"
 *     (overwrite the failed entry to the skip verdict)
 *
 * Optional capabilities (Phase C additions):
 *   - fastPathTriage: synchronous pre-LLM triage (tag/POI fast paths)
 *   - backfillCachedFirst: stamp cached extractions BEFORE triage (media)
 *   - writeCachedToBookmark: backfill write that sees the full cache entry
 *   - onExtractError: diagnostics for extract-phase rejections
 *   - afterCore: post-stages (media playback/deep-link resolution)
 *   - TEntry generic: cache entries may carry extra fields (media's
 *     playback/deepLink) beyond {triage, extraction}
 */
import type { App, TFile } from "obsidian";
import { forEachBatch, loadPipelineCache, savePipelineCache } from "@/pipeline/shared";

/** Cache shape shared by all category pipelines. */
export type PipelineCacheEntry<TVerdict extends string, TExtract> = {
  triage: TVerdict;
  extraction: TExtract | null;
  /** Set to true when storeExtractionInCache === false after a successful extraction.
   *  Prevents re-extraction on subsequent runs. */
  extracted?: boolean;
};
export type PipelineCache<TVerdict extends string, TExtract> =
  Record<string, PipelineCacheEntry<TVerdict, TExtract>>;

/** Context handed to afterCore post-stages. */
export interface CategoryPipelineContext<TCand, TEntry> {
  app: App;
  candidates: TCand[];
  cache: Record<string, TEntry>;
  log: (msg: string) => void;
}

export interface CategoryPipelineConfig<
  TCand extends { roostId: string; file: TFile },
  TExtract,
  TVerdict extends string,
  TResult,
  TEntry extends PipelineCacheEntry<TVerdict, TExtract> = PipelineCacheEntry<TVerdict, TExtract>,
> {
  cacheFile: string;
  concurrency: number;
  /** When false, a successful extraction sets `extracted: true` on the cache
   *  entry instead of storing the full extraction payload. The extraction is
   *  still written to frontmatter via writeToBookmark. Defaults to true.
   *  Set to false for pipelines whose cache is NOT a live data source (recipe,
   *  products, workouts, tutorials, home). */
  storeExtractionInCache?: boolean;
  /** The triage verdict that means "extract this" and is the pipeline's positive class. */
  extractVerdict: TVerdict;
  gatherCandidates(app: App, syncFolder: string): TCand[];
  /** Optional synchronous pre-LLM triage (tag/POI fast paths). A non-null
   *  verdict is cached without an LLM call; null falls through to triageItem. */
  fastPathTriage?(c: TCand): TVerdict | null;
  triageItem(c: TCand): Promise<TVerdict>;
  extractItem(c: TCand): Promise<TExtract | null>;
  /** Optional post-extract mutation (e.g. attach a candidate-derived link to the extraction). */
  afterExtract?(extraction: TExtract, c: TCand): void;
  /** Diagnostic hook for extract-phase REJECTIONS (throws). Not called for a
   *  quiet null return (parse failure) — that matches the bespoke pipelines'
   *  call-site `.catch(console.warn)` placement. */
  onExtractError?(roostId: string, err: unknown): void;
  writeToBookmark(app: App, c: TCand, extraction: TExtract): Promise<void>;
  /** Backfill-stage write override. Receives the full cache entry so pipelines
   *  with extra entry fields (media: playback/deepLink) can pass them through.
   *  Defaults to writeToBookmark(app, c, entry.extraction!). */
  writeCachedToBookmark?(app: App, c: TCand, entry: TEntry): Promise<void>;
  /** Run the cached-backfill stage BEFORE triage instead of after. Media uses
   *  this so its list table populates immediately, then grows as the slow LLM
   *  passes land more items. */
  backfillCachedFirst?: boolean;
  /** Post-core stages (media: playback + deep-link resolution). Runs after the
   *  extract phase and before buildResult; may mutate cache (saving via
   *  savePipelineCache) and closure counters that buildResult reads.
   *  A rejection propagates out of runCategoryPipeline (buildResult never
   *  runs); per-batch cache saves from earlier stages are already on disk. */
  afterCore?(ctx: CategoryPipelineContext<TCand, TEntry>): Promise<void>;
  buildResult(candidates: TCand[], cache: Record<string, TEntry>, errors: number): TResult;
  /** Failure policy — preserves each pipeline's CURRENT behavior (do not normalize).
   *  "retry" = leave the entry for next run. "demote" = overwrite the failed
   *  entry to the skip verdict so it is not retried. */
  onExtractFailure: "retry" | "demote";
  /** Triage-phase failure policy. "leave" = uncached → retried next run.
   *  "skip" = a triage throw becomes the skip verdict so it is not re-triaged. */
  onTriageFailure: "leave" | "skip";
  /** The verdict used when a failure is demoted/skipped (e.g. "skip"). */
  skipVerdict: TVerdict;
  /** Log-string fragments. Pipelines supply their own nouns. */
  log: {
    candidatesFound(n: number): string;
    triageExtractCounts(uncached: number, needExtract: number, complete: number): string;
    /** Logged once when fastPathTriage hit at least one item. */
    fastPath?(n: number): string;
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
  TEntry extends PipelineCacheEntry<TVerdict, TExtract> = PipelineCacheEntry<TVerdict, TExtract>,
>(
  app: App,
  syncFolder: string,
  config: CategoryPipelineConfig<TCand, TExtract, TVerdict, TResult, TEntry>,
  onLog?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<TResult> {
  const log = onLog || (() => {});
  const vault = app.vault;
  const cache = loadPipelineCache<TEntry>(vault, config.cacheFile);

  // 1. Gather candidates
  const candidates = config.gatherCandidates(app, syncFolder);
  log(config.log.candidatesFound(candidates.length));

  const uncached = candidates.filter(c => !cache[c.roostId]);
  const needExtract = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction && !cache[c.roostId]?.extracted,
  ).length;
  log(config.log.triageExtractCounts(
    uncached.length,
    needExtract,
    candidates.length - uncached.length - needExtract,
  ));

  // Backfill stage as a local fn so backfillCachedFirst can reorder it.
  const writeCached = config.writeCachedToBookmark
    ?? ((a: App, c: TCand, entry: TEntry) => config.writeToBookmark(a, c, entry.extraction!));
  // NOTE: this re-scans the live cache, so the two call sites (pre-triage
  // vs post-triage) may produce different write sets for newly-triaged items.
  const backfillCached = async (): Promise<void> => {
    // When storeExtractionInCache is false, the cache is slim ({triage, extracted:true})
    // — there is no extraction payload to backfill from, so this stage is a no-op.
    if (config.storeExtractionInCache === false) {
      log(config.log.wroteCached(0));
      return;
    }
    const alreadyCached: { entry: TEntry; candidate: TCand }[] = [];
    for (const c of candidates) {
      const entry = cache[c.roostId];
      if (entry?.triage === config.extractVerdict && entry.extraction) {
        alreadyCached.push({ entry, candidate: c });
      }
    }
    for (const r of alreadyCached) {
      await writeCached(app, r.candidate, r.entry);
    }
    log(config.log.wroteCached(alreadyCached.length));
  };

  if (config.backfillCachedFirst) await backfillCached();

  // 2a. Fast-path triage (no LLM call)
  if (config.fastPathTriage) {
    let fastCount = 0;
    for (const c of uncached) {
      const verdict = config.fastPathTriage(c);
      if (verdict !== null) {
        // Base-shape literal; TEntry's extra fields are all optional in practice
        // (they accrue later, e.g. media's playback), so the cast is safe.
        cache[c.roostId] = { triage: verdict, extraction: null } as TEntry;
        fastCount++;
      }
    }
    if (fastCount > 0) {
      savePipelineCache(vault, config.cacheFile, cache);
      if (config.log.fastPath) log(config.log.fastPath(fastCount));
    }
  }

  // 2b. LLM triage for remaining uncached items
  const needTriage = uncached.filter(c => !cache[c.roostId]);
  let triageCount = 0;
  await forEachBatch(needTriage, config.concurrency, async batch => {
    if (signal?.aborted) return;
    const results = await Promise.allSettled(
      batch.map(async c => {
        const triage = await config.triageItem(c);
        return { roostId: c.roostId, triage };
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        cache[r.value.roostId] = { triage: r.value.triage, extraction: null } as TEntry;
        triageCount++;
      } else if (config.onTriageFailure === "skip") {
        // A triage throw becomes the skip verdict so it is not re-triaged.
        cache[batch[j].roostId] = { triage: config.skipVerdict, extraction: null } as TEntry;
      }
      // onTriageFailure === "leave": do nothing (uncached → retried next run).
    }

    savePipelineCache(vault, config.cacheFile, cache);
    log(config.log.triageProgress(triageCount, needTriage.length));
  }, signal);

  // Stop between phases if aborted. Per-batch cache saves already persisted
  // partial progress — the run is resumable via cache-presence next time.
  if (signal?.aborted) {
    log("[cancelled] pipeline stopped after triage phase");
    const result = config.buildResult(candidates, cache, 0);
    log(config.log.done(result));
    return result;
  }

  // 3. Backfill previously cached extractions onto their source bookmarks
  if (!config.backfillCachedFirst) await backfillCached();

  const toExtract = candidates.filter(
    c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction && !cache[c.roostId]?.extracted,
  );
  log(config.log.extracting(toExtract.length));

  let extractCount = 0;
  let extractErrors = 0;
  await forEachBatch(toExtract, config.concurrency, async batch => {
    if (signal?.aborted) return;
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
        if (config.storeExtractionInCache === false) {
          // Slim mode: mark as done without storing the payload.
          cache[r.value.roostId] = { ...cache[r.value.roostId], extraction: null, extracted: true };
        } else {
          cache[r.value.roostId].extraction = extraction;
        }
        extractCount++;
        await config.writeToBookmark(app, r.value.candidate, extraction);
      } else {
        extractErrors++;
        if (r.status === "rejected") {
          config.onExtractError?.(batch[j].roostId, r.reason);
        }
        if (config.onExtractFailure === "demote") {
          // Overwrite the failed entry to the skip verdict so it is NOT retried.
          cache[batch[j].roostId] = { triage: config.skipVerdict, extraction: null } as TEntry;
        }
        // onExtractFailure === "retry": leave the entry for next run.
      }
    }

    savePipelineCache(vault, config.cacheFile, cache);
    log(config.log.extractProgress(extractCount, toExtract.length));
  }, signal);

  // Log a cancellation note if aborted during the extract phase, then fall
  // through to buildResult so partial progress is reported cleanly.
  if (signal?.aborted) {
    log("[cancelled] pipeline stopped during extract phase");
  }

  // 4. Post-core stages (media: playback + deep-link resolution)
  // Skip afterCore on abort: partial extraction is safe (cache consistent),
  // but post-core stages (deep-link resolution, playback fetch) may make
  // outbound requests that are unnecessary if the user cancelled.
  if (config.afterCore && !signal?.aborted) {
    await config.afterCore({ app, candidates, cache, log });
  }

  const result = config.buildResult(candidates, cache, extractErrors);
  log(config.log.done(result));
  return result;
}
