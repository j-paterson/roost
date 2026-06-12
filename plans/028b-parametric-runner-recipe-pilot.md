# Plan 028b: DEBT-01 Phase B — parametric `runCategoryPipeline` + recipe pilot

> **Phase B of the approved A→D consolidation.** Introduce a single generic pipeline runner
> and prove it on **recipe** as the pilot, with **zero behavior change**. The design treats
> the failing-extraction divergence as *config*, not a forced normalization — so this is a
> pure refactor. The proof: **Phase A's recipe characterization tests pass byte-unchanged.**

## Status

- **Priority**: P3
- **Effort**: L
- **Category**: tech-debt / architecture (HIGH fix-risk — the riskiest change in the repo)
- **Status**: TODO
- **Depends on**: 028a (Phase A net) — MERGED ✅ (`main` @ `8c1c18c`, 1095 tests)
- **Written against**: `8c1c18c`. Orchestrator will hand you a worktree on this base.

## Goal & non-goal

- **Goal**: create `packages/core/src/pipeline/run-category-pipeline.ts` exporting a generic
  `runCategoryPipeline(...)` + a `CategoryPipelineConfig` interface; rewrite `runRecipePipeline`
  to a thin adapter that delegates to it via a `RECIPE_CONFIG`. The recipe skeleton moves into
  the runner **parameterized**; recipe's category-specific functions stay in `recipe-pipeline.ts`.
- **Non-goal**: do NOT migrate any other pipeline (that's Phase C). Do NOT change recipe's
  observable behavior. Do NOT touch tests (Phase A's recipe tests are the gate — they must pass
  AS-IS). Do NOT normalize the retry-vs-demote difference (config preserves it).

## Current state (verified against `8c1c18c`)

`runRecipePipeline` (`recipe-pipeline.ts:336-435`) is the skeleton to extract. Its exact shape:
1. `cache = loadPipelineCache<CacheEntry>(vault, CACHE_FILE)` where
   `CacheEntry = { triage: "recipe"|"restaurant"|"skip"; extraction: RecipeExtraction|null }`.
2. `candidates = gatherCandidates(app, syncFolder)` → `RecipeCandidate[]`; log `Found N food/recipe candidates`.
3. `uncached = candidates.filter(c => !cache[c.roostId])`; `needExtract` count; log the
   `${u} need triage, ${n} need extraction (${complete} complete)` line.
4. **Triage loop** (batch of `CONCURRENCY=3`): `Promise.allSettled(batch.map(async c => ({roostId, triage: await triageItem(c)})))`;
   for each **fulfilled** → `cache[id] = { triage, extraction: null }`, `triageCount++`. (Rejected →
   left uncached, i.e. retried next run.) `savePipelineCache`; log `Triage: x/y`.
5. **Backfill cached**: for candidates with `cache[id].triage==="recipe" && extraction` →
   `await writeRecipeToBookmark(app, candidate.file, extraction)`; log `Wrote N cached recipes`.
6. `toExtract = candidates.filter(triage==="recipe" && !extraction)`; log `Extracting N new recipes`.
7. **Extract loop** (batch `CONCURRENCY`): `Promise.allSettled(batch.map(async c => ({roostId, extraction: await extractRecipe(c), candidate: c})))`;
   for each fulfilled **with extraction**: `extraction.recipeLink = candidate.recipeLink`,
   `cache[id].extraction = extraction`, `extractCount++`, `await writeRecipeToBookmark(...)`.
   **else `extractErrors++`** (the failed entry is left as `{triage:"recipe", extraction:null}` →
   retried — recipe's "retry" policy). `savePipelineCache`; log `Extract: x/y`.
8. Build `RecipePipelineResult { candidates, recipes, restaurants, skipped, errors }`; log Done line; return.

`triageItem` returns `"recipe"|"restaurant"|"skip"`; `extractVerdict` (the value that triggers
extraction & counts as a "recipe") is `"recipe"`. recipe-specific bits to keep in
`recipe-pipeline.ts`: `gatherCandidates`, `triageItem`, `extractRecipe`, the `recipeLink` attach,
`writeRecipeToBookmark`, the result/tally, and all constants.

## Design — the generic runner

Create `packages/core/src/pipeline/run-category-pipeline.ts`:

```ts
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
  /** Optional post-extract mutation (recipe attaches recipeLink from the candidate). */
  afterExtract?(extraction: TExtract, c: TCand): void;
  writeToBookmark(app: App, c: TCand, extraction: TExtract): Promise<void>;
  buildResult(candidates: TCand[], cache: PipelineCache<TVerdict, TExtract>, errors: number): TResult;
  /** Failure policy — preserves each pipeline's CURRENT behavior (do not normalize).
   *  recipe = "retry" (leave the entry for next run). Phase C will pass "demote" for the
   *  all+catch six (overwrite the failed entry to the skip verdict). */
  onExtractFailure: "retry" | "demote";
  /** Triage-phase failure policy. recipe (allSettled) = "leave" (uncached → retried).
   *  Phase C will pass "skip" for the all+catch six (a triage throw becomes the skip verdict). */
  onTriageFailure: "leave" | "skip";
  /** The verdict used when a failure is demoted/skipped (e.g. "skip"). */
  skipVerdict: TVerdict;
  /** Log-string fragments to reproduce the per-pipeline messages. */
  log: {
    candidatesFound(n: number): string;     // recipe: `Found ${n} food/recipe candidates`
    triageExtractCounts(uncached: number, needExtract: number, complete: number): string;
    triageProgress(done: number, total: number): string;
    wroteCached(n: number): string;          // recipe: `Wrote ${n} cached recipes`
    extracting(n: number): string;           // recipe: `Extracting ${n} new recipes`
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
  // ... reproduce steps 1-8 above EXACTLY, substituting config.* for the recipe-specifics.
  // Triage loop: always Promise.allSettled; fulfilled → cache[id] = { triage, extraction: null }.
  //   On a REJECTED triage: if config.onTriageFailure === "skip", set cache[id] =
  //   { triage: config.skipVerdict, extraction: null }; if "leave", do nothing (recipe).
  // Extract loop: Promise.allSettled; fulfilled-with-extraction → afterExtract?.(ex, c),
  //   cache[id].extraction = ex, writeToBookmark, count. On fulfilled-null OR rejected:
  //   errors++, and if config.onExtractFailure === "demote", set cache[id] =
  //   { triage: config.skipVerdict, extraction: null }; if "retry", leave the entry (recipe).
  // Save the cache after each batch; emit the config.log.* strings.
}
```

> Implementation notes for the executor:
> - Use `Promise.allSettled` for BOTH loops in the runner (recipe's idiom). The all+catch six
>   are equivalent to allSettled-with-a-failure-policy, which `onTriage/ExtractFailure` captures —
>   you do NOT need a second batching code path. (Phase C will confirm this on product.)
> - The runner must NOT import or reference `recipe-*` anything. If you find yourself needing a
>   recipe-specific branch inside the runner, the config interface is wrong — STOP and report.
> - Both failure-policy branches (`retry`/`demote`, `leave`/`skip`) must be implemented now even
>   though recipe only exercises `retry`/`leave`; Phase C plugs in the others with no runner edit.

## Wire recipe (the pilot)

In `recipe-pipeline.ts`:
- Keep every existing recipe-specific function and constant.
- Add a `RECIPE_CONFIG: CategoryPipelineConfig<RecipeCandidate, RecipeExtraction, "recipe"|"restaurant"|"skip", RecipePipelineResult>`
  wiring: `cacheFile: CACHE_FILE`, `concurrency: CONCURRENCY`, `extractVerdict: "recipe"`,
  `skipVerdict: "skip"`, `onExtractFailure: "retry"`, `onTriageFailure: "leave"`,
  `gatherCandidates`, `triageItem`, `extractItem: extractRecipe`,
  `afterExtract: (ex, c) => { ex.recipeLink = c.recipeLink; }`,
  `writeToBookmark: (app, c, ex) => writeRecipeToBookmark(app, c.file, ex)`,
  `buildResult: (candidates, cache, errors) => ({ candidates: candidates.length, recipes: …,
  restaurants: …, skipped: …, errors })` (the exact current tally), and the `log` fragments that
  reproduce the current strings verbatim.
- Replace the BODY of `runRecipePipeline` with:
  ```ts
  export async function runRecipePipeline(app, syncFolder, onLog?) {
    return runCategoryPipeline(app, syncFolder, RECIPE_CONFIG, onLog);
  }
  ```
  Keep its exported signature identical. `writeRecipeToBookmark` may need to stay as-is (still
  called by `RECIPE_CONFIG.writeToBookmark`). Do not change `reconstructRecipeCache` or
  `RECIPE_ENRICHMENT`.

## Hard gate — behavior preservation

The **Phase A recipe tests must pass byte-unchanged**. Do NOT edit them. They are:
- in `pipeline-runners.harness.test.ts`: the recipe single-post / idempotent / skip cases, the
  `recipe (3-way triage — restaurant verdict)` test, the
  `recipe (Promise.allSettled): A extracts, B fails — B left as {triage:'recipe',extraction:null} for retry`
  test, and `computeRecipeBackfillFields (branch coverage)`.
If any of these would need editing to pass, you have changed behavior — STOP and report which test
and why; do not edit the test.

## Verification / done criteria

```
npm run typecheck                              # exit 0
npm test                                       # 1095 passed / 8 skipped — UNCHANGED count, 0 failures
npx vitest run pipeline-runners                # harness green incl. all recipe cases
git diff --name-only 8c1c18c..HEAD             # EXACTLY: run-category-pipeline.ts (new) + recipe-pipeline.ts
git diff 8c1c18c..HEAD -- '**/*.test.ts'       # EMPTY (no test changes)
```
- The recipe extract-failure test passing through the new runner is the proof the "retry" policy
  survived the refactor.
- `run-category-pipeline.ts` contains ZERO references to `recipe`/`Recipe`.

## STOP conditions

- A Phase A test would need editing to pass → STOP (behavior changed); report the test + the cause.
- The config interface can't express recipe without a recipe-specific branch in the runner → STOP.
- typecheck can't be satisfied without `any`-casting away the cache generics in the runner → STOP
  and report (some cast at the recipe-config boundary is acceptable; `any` inside the runner body
  is not).
- Net test count changes (other than staying 1095) → STOP.

## Commit

`refactor(pipeline): extract parametric runCategoryPipeline; recipe pilot (DEBT-01 phase B)`
Stage only `run-category-pipeline.ts` + `recipe-pipeline.ts` (`git add <files>`), never `git add -A`.
End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Maintenance / hand-off to Phase C

Phase C migrates home/products/tutorials/workouts/media one at a time, each as `X_CONFIG` +
a one-line `runXPipeline` delegation — passing `onExtractFailure:"demote"`, `onTriageFailure:"skip"`
for the all+catch six (product's Phase A failing-extraction test is the gate that proves the
"demote" path). No runner changes should be needed; if one is, that's a signal the config
interface is under-powered — surface it rather than special-casing.
