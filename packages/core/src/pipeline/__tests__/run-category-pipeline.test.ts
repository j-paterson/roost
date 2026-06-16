/**
 * Direct unit tests for runCategoryPipeline's optional capabilities, added in
 * DEBT-01 Phase C: fastPathTriage, onExtractError, backfillCachedFirst,
 * writeCachedToBookmark, afterCore. The base skeleton is characterized by the
 * per-pipeline integration harness (pipeline-runners.harness.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter, TFile, type App } from "obsidian";
import {
  runCategoryPipeline,
  type CategoryPipelineConfig,
} from "@/pipeline/run-category-pipeline";

type Verdict = "yes" | "skip";
interface Result { yes: number; errors: number }
interface Cand { roostId: string; file: TFile }

function makeApp(baseDir: string): App {
  const adapter = new FileSystemAdapter();
  adapter.basePath = baseDir;
  return { vault: { adapter } } as unknown as App;
}

function cand(id: string): Cand {
  return { roostId: id, file: Object.assign(new TFile(), { path: `${id}.md` }) };
}

const CACHE_FILE = "rcp-test-cache.json";

function cachePathFor(tmp: string): string {
  return path.join(tmp, ".roost", "cache", CACHE_FILE);
}

function seedCache(tmp: string, entries: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmp, ".roost", "cache"), { recursive: true });
  fs.writeFileSync(cachePathFor(tmp), JSON.stringify(entries));
}

function readCache(tmp: string): Record<string, { triage: string; extraction: unknown }> {
  return JSON.parse(fs.readFileSync(cachePathFor(tmp), "utf-8"));
}

/** Base config: every required member supplied; tests override what they probe. */
function baseConfig(
  over: Partial<CategoryPipelineConfig<Cand, string, Verdict, Result>>,
): CategoryPipelineConfig<Cand, string, Verdict, Result> {
  return {
    cacheFile: CACHE_FILE,
    concurrency: 2,
    extractVerdict: "yes",
    skipVerdict: "skip",
    onExtractFailure: "retry",
    onTriageFailure: "leave",
    gatherCandidates: () => [],
    triageItem: async () => "yes",
    extractItem: async () => "data",
    writeToBookmark: async () => {},
    buildResult: (cands, cache, errors) => ({
      yes: cands.filter(c => cache[c.roostId]?.triage === "yes" && cache[c.roostId]?.extraction).length,
      errors,
    }),
    log: {
      candidatesFound: n => `found ${n}`,
      triageExtractCounts: (u, e, c) => `${u}/${e}/${c}`,
      triageProgress: (d, t) => `triage ${d}/${t}`,
      wroteCached: n => `cached ${n}`,
      extracting: n => `extracting ${n}`,
      extractProgress: (d, t) => `extract ${d}/${t}`,
      done: () => "done",
    },
    ...over,
  };
}

describe("runCategoryPipeline extensions", () => {
  let tmp: string;
  let app: App;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcp-test-"));
    app = makeApp(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fastPathTriage: non-null verdict skips LLM triage; null falls through", async () => {
    const llmTriaged: string[] = [];
    const cands = [cand("fast"), cand("slow")];
    const result = await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => cands,
      fastPathTriage: c => (c.roostId === "fast" ? "yes" : null),
      triageItem: async c => { llmTriaged.push(c.roostId); return "yes"; },
    }));

    expect(llmTriaged).toEqual(["slow"]);     // fast-pathed item never hit the LLM
    expect(result.yes).toBe(2);               // both extracted
    const cache = readCache(tmp);
    expect(cache["fast"].triage).toBe("yes");
    expect(cache["slow"].triage).toBe("yes");
  });

  it("fastPathTriage: log.fastPath emitted once when at least one item hits", async () => {
    const logs: string[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("a"), cand("b")],
      fastPathTriage: () => "yes",
      log: { ...baseConfig({}).log, fastPath: n => `fast ${n}` },
    }), msg => logs.push(msg));
    expect(logs).toContain("fast 2");
  });

  it("fastPathTriage: log.fastPath not emitted when all items return null", async () => {
    const logs: string[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("a")],
      fastPathTriage: () => null,
      log: { ...baseConfig({}).log, fastPath: n => `fast ${n}` },
    }), msg => logs.push(msg));
    expect(logs.filter(l => l.startsWith("fast "))).toHaveLength(0);
  });

  it("backfillCachedFirst: cached writes happen before triage when set", async () => {
    seedCache(tmp, { cached: { triage: "yes", extraction: "old" } });
    const order: string[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("cached"), cand("fresh")],
      triageItem: async c => { order.push(`triage:${c.roostId}`); return "skip"; },
      writeToBookmark: async (_a, c) => { order.push(`write:${c.roostId}`); },
      backfillCachedFirst: true,
    }));
    expect(order[0]).toBe("write:cached");        // backfill ran first
    expect(order).toContain("triage:fresh");
  });

  it("default order: triage happens before cached writes when flag unset", async () => {
    seedCache(tmp, { cached: { triage: "yes", extraction: "old" } });
    const order: string[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("cached"), cand("fresh")],
      triageItem: async c => { order.push(`triage:${c.roostId}`); return "skip"; },
      writeToBookmark: async (_a, c) => { order.push(`write:${c.roostId}`); },
    }));
    expect(order[0]).toBe("triage:fresh");
  });

  it("writeCachedToBookmark: backfill write receives the full cache entry", async () => {
    seedCache(tmp, { cached: { triage: "yes", extraction: "old", extra: "payload" } });
    const seen: unknown[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("cached")],
      writeCachedToBookmark: async (_a, _c, entry) => { seen.push(entry); },
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ triage: "yes", extraction: "old", extra: "payload" });
  });

  it("onExtractError: invoked with rejection reason; demote policy caches skip", async () => {
    const errs: Array<{ id: string; err: unknown }> = [];
    const boom = new Error("ollama down");
    const result = await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("bad")],
      extractItem: async () => { throw boom; },
      onExtractFailure: "demote",
      onExtractError: (id, err) => errs.push({ id, err }),
    }));
    expect(errs).toEqual([{ id: "bad", err: boom }]);
    expect(result.errors).toBe(1);
    expect(readCache(tmp)["bad"]).toEqual({ triage: "skip", extraction: null });
  });

  it("onExtractError: NOT invoked when extractItem resolves null (parse failure)", async () => {
    const errs: unknown[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("nullret")],
      extractItem: async () => null,
      onExtractFailure: "demote",
      onExtractError: (_id, err) => errs.push(err),
    }));
    expect(errs).toEqual([]);   // null return is a quiet demote, matching bespoke behavior
    expect(readCache(tmp)["nullret"]).toEqual({ triage: "skip", extraction: null });
  });

  it("afterCore: runs after extraction, before buildResult; sees candidates + cache", async () => {
    let coreCacheSnapshot: Record<string, unknown> | null = null;
    let counter = 0;
    const result = await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("x")],
      afterCore: async ({ candidates, cache }) => {
        coreCacheSnapshot = { ...cache };
        expect(candidates).toHaveLength(1);
        counter = 42;                              // closure mutation …
      },
      buildResult: (_c, _cache, errors) => ({ yes: counter, errors }),  // … visible here
    }));
    expect(result.yes).toBe(42);
    expect(coreCacheSnapshot?.["x"]).toMatchObject({ triage: "yes", extraction: "data" });
  });

  // ── storeExtractionInCache tests ──

  it("storeExtractionInCache:false — successful extraction sets extracted:true and leaves extraction null", async () => {
    const writeArgs: { id: string; extraction: unknown }[] = [];
    const result = await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("slim")],
      triageItem: async () => "yes",
      extractItem: async () => "data",
      writeToBookmark: async (_a, c, ex) => { writeArgs.push({ id: c.roostId, extraction: ex }); },
      storeExtractionInCache: false,
      buildResult: (cands, cache, errors) => ({
        yes: cands.filter(c => (cache[c.roostId] as any)?.extracted === true || !!cache[c.roostId]?.extraction).length,
        errors,
      }),
    }));

    // writeToBookmark still called with the real extraction
    expect(writeArgs).toHaveLength(1);
    expect(writeArgs[0].extraction).toBe("data");
    // result still counts it as done
    expect(result.yes).toBe(1);
    // cache entry has extracted:true and extraction:null
    const saved = readCache(tmp);
    expect(saved["slim"]).toMatchObject({ triage: "yes", extraction: null, extracted: true });
  });

  it("storeExtractionInCache:false — an entry with {triage, extracted:true} is NOT re-extracted on next run", async () => {
    // Seed cache as if a prior run already set extracted:true
    seedCache(tmp, { done: { triage: "yes", extraction: null, extracted: true } });
    const extractCalls: string[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("done")],
      triageItem: async () => "yes",
      extractItem: async c => { extractCalls.push(c.roostId); return "data"; },
      storeExtractionInCache: false,
    }));
    // Must NOT call extractItem again for already-slim entry
    expect(extractCalls).toHaveLength(0);
  });

  it("storeExtractionInCache absent/true — behavior unchanged (stores extraction)", async () => {
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("fat")],
    }));
    const saved = readCache(tmp);
    expect(saved["fat"]).toMatchObject({ triage: "yes", extraction: "data" });
    expect((saved["fat"] as any).extracted).toBeUndefined();
  });

  it("storeExtractionInCache:false — backfillCached is a no-op (does not write cached entries)", async () => {
    // Seed cache with a slim entry that would otherwise be backfilled
    seedCache(tmp, { slim: { triage: "yes", extraction: null, extracted: true } });
    const writes: string[] = [];
    await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("slim")],
      writeToBookmark: async (_a, c) => { writes.push(c.roostId); },
      storeExtractionInCache: false,
    }));
    // backfillCached should have been a no-op
    expect(writes).toHaveLength(0);
  });

  // ── Abort / signal tests ──

  it("signal already aborted before run: no triage or extract calls, buildResult reflects empty work", async () => {
    const controller = new AbortController();
    controller.abort();
    const triaged: string[] = [];
    const extracted: string[] = [];
    const result = await runCategoryPipeline(app, "Sync", baseConfig({
      gatherCandidates: () => [cand("a"), cand("b")],
      triageItem: async c => { triaged.push(c.roostId); return "yes"; },
      extractItem: async c => { extracted.push(c.roostId); return "data"; },
    }), undefined, controller.signal);
    // Nothing should have been triaged or extracted.
    expect(triaged).toHaveLength(0);
    expect(extracted).toHaveLength(0);
    // buildResult should still complete (no throw).
    expect(result).toBeDefined();
  });

  it("signal aborted after first triage batch: stops before second batch, no throw", async () => {
    const controller = new AbortController();
    const triaged: string[] = [];
    // 4 items with concurrency=2: batch 1 = [a,b], batch 2 = [c,d].
    // Abort during triage of batch 1 so batch 2 should never start.
    const config = baseConfig({
      concurrency: 2,
      gatherCandidates: () => [cand("a"), cand("b"), cand("c"), cand("d")],
      triageItem: async c => {
        triaged.push(c.roostId);
        // Abort after processing the first batch to simulate mid-run cancel.
        if (triaged.length === 2) controller.abort();
        return "yes";
      },
      extractItem: async () => "data",
    });
    // Should not throw even though the run is cancelled.
    const result = await runCategoryPipeline(app, "Sync", config, undefined, controller.signal);
    // Only the first batch (a, b) should have been triaged.
    expect(triaged).toEqual(["a", "b"]);
    // Result is defined (partial, not an error).
    expect(result).toBeDefined();
  });
});
