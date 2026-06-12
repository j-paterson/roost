# Plan 028c: DEBT-01 Phase C — migrate the 4 clean pipelines to the parametric runner

> **Phase C of the approved A→D consolidation.** Migrate **home, products, tutorials, workouts**
> — the four "clean" all+catch pipelines — to delegate to `runCategoryPipeline` (added in Phase B).
> Each migration is independent, touches only its own pipeline file, and is a **pure refactor**
> gated by that pipeline's Phase A characterization tests passing **byte-unchanged**.
> **Media is NOT in this plan** (it has extra playback/deep-link passes — handled separately).

## Status

- **Priority**: P3
- **Effort**: M per pipeline (×4)
- **Category**: tech-debt / architecture (high fix-risk — user-facing enrichment paths)
- **Status**: TODO
- **Depends on**: 028b (parametric runner) — MERGED ✅ (`main` @ `b786900`)
- **Written against**: `b786900`. Each executor gets its own worktree on this base.

> **Each executor migrates exactly ONE pipeline** (told which in its dispatch). The recipe below
> is identical for all four; only the per-pipeline values differ.

## The runner you delegate to (already on main)

`packages/core/src/pipeline/run-category-pipeline.ts` exports
`runCategoryPipeline(app, syncFolder, config, onLog?)` and `CategoryPipelineConfig<TCand, TExtract, TVerdict, TResult>`.
Read it first. Its config fields: `cacheFile, concurrency, extractVerdict, gatherCandidates,
triageItem, extractItem, afterExtract?, writeToBookmark, buildResult, onExtractFailure
("retry"|"demote"), onTriageFailure ("leave"|"skip"), skipVerdict, log {candidatesFound,
triageExtractCounts, triageProgress, wroteCached, extracting, extractProgress, done}`.
Recipe (already migrated) is your reference for HOW a pipeline plugs in — read `RECIPE_CONFIG`
+ the one-line `runRecipePipeline` in `recipe-pipeline.ts`.

## The migration recipe (apply to YOUR pipeline `<X>`)

Your pipeline file is `packages/core/src/pipeline/<X>-pipeline.ts` with entry `run<X>Pipeline`.
All four currently use the **all+catch** idiom (`Promise.all(batch.map(c => extract(c).catch(...)))`)
— NOT recipe's `allSettled`. So your config uses **`onExtractFailure: "demote"`** and
**`onTriageFailure: "skip"`** (recipe used retry/leave; you use demote/skip — this is the
behavior these six already have, and the runner implements both policies).

1. **Read** `run<X>Pipeline` end-to-end. Identify: `gatherCandidates`, `triageItem`, `extract<X>`,
   `write<X>ToBookmark`, the result/tally object, every `log(...)` string, and the
   `console.warn` calls.
2. **⚠ Preserve the extract-loop warning.** Your current extract loop wraps the extract call in
   `.catch((err) => { console.warn(`[roost] <x>: extraction error for ${c.roostId}:`, err); return null; })`.
   The runner does NOT warn on failure (recipe didn't). To preserve this EXACT observable
   behavior, wrap it in your config's `extractItem`:
   ```ts
   extractItem: async (c) => {
     try { return await extract<X>(c); }
     catch (err) { console.warn(`[roost] <x>: extraction error for ${c.roostId}:`, err); return null; }
   },
   ```
   (The OTHER warn — `[roost] <x>: failed to parse extraction ...` — lives INSIDE `extract<X>`
   and is preserved automatically. Confirm your pipeline matches this; if the warn lives
   somewhere the wrapper can't reproduce, STOP and report.)
3. **Build `<X>_CONFIG`** with: `cacheFile` (the existing CACHE_FILE const), `concurrency`
   (CONCURRENCY), `extractVerdict` (the keep verdict — `"home"`/`"product"`/`"tutorial"`/`"workout"`),
   `skipVerdict: "skip"`, `onExtractFailure: "demote"`, `onTriageFailure: "skip"`,
   `gatherCandidates`, `triageItem`, the wrapped `extractItem` (step 2),
   `writeToBookmark: (app, c, ex) => write<X>ToBookmark(app, c.file, ex)`,
   `buildResult: (candidates, cache, errors) => ({ ...the EXACT current tally... })`,
   and `log` fragments that reproduce **every current log string byte-for-byte**.
   - If your pipeline does a post-extract mutation like recipe's `extraction.recipeLink = c.recipeLink`,
     put it in `afterExtract`. If it has none, omit `afterExtract`. (home/products/tutorials/workouts
     are not expected to need one — verify.)
4. **Replace the body** of `run<X>Pipeline` with:
   `return runCategoryPipeline(app, syncFolder, <X>_CONFIG, onLog);`
   Keep its exported signature identical. Do NOT touch `reconstruct<X>Cache`, the
   `<X>_ENRICHMENT` registry const, `compute<X>BackfillFields`, or `write<X>ToBookmark`'s body.
5. **STOP** if: the runner would need a change to fit your pipeline (config under-powered — that's
   a finding, not something to force); your pipeline has a triage/extract structure that isn't the
   gather→triage→extract→write shape (e.g. an extra resolution pass — that means it's not a clean
   pipeline and shouldn't be in this batch); or a Phase A test would need editing to pass.

## Faithfulness check — the all+catch → runner equivalence (why this preserves behavior)

Your current loops vs the runner (both verified equivalent in the Phase B review):
- Triage: `Promise.all(map(c => triageItem(c).catch(()=>"skip")))` then cache every `results[j]`.
  ≡ runner `allSettled` + `onTriageFailure:"skip"`: a thrown triage → `{triage:"skip",extraction:null}`;
  a resolved verdict (incl. "skip") → cached as-is. Same end state.
- Extract: `Promise.all(map(c => extract(c).catch(warn+null)))` then
  `if (ex) {write+cache} else {cache=skip; errors++}`.
  ≡ runner + `onExtractFailure:"demote"`: success → write + cache; null/throw → `errors++` +
  `{triage:"skip",extraction:null}`. The warn is preserved by your `extractItem` wrapper.
- save-per-batch and the backfill-cached pass (writing previously-cached items before the extract
  loop) are in the runner — confirm your pipeline's structure matches (it should).

## Verification / done criteria (run in YOUR worktree)

```
npm run typecheck                              # exit 0
npm test                                       # 1095 passed / 8 skipped — UNCHANGED, 0 failures
npx vitest run pipeline-runners                # harness green incl. YOUR pipeline's cases
git diff --name-only b786900..HEAD             # EXACTLY: packages/core/src/pipeline/<X>-pipeline.ts
git diff b786900..HEAD -- '**/*.test.ts'       # EMPTY (no test edits)
git diff b786900..HEAD -- packages/core/src/pipeline/run-category-pipeline.ts  # EMPTY (runner untouched)
```
- Your pipeline's Phase A tests (single-post / idempotent / skip / failing-extraction-demote if
  present / compute* branches) pass UNCHANGED. The failing-extraction test (if your pipeline has
  one — product does) passing through the runner is the proof the demote policy is preserved.
- Diff is ONLY your `<X>-pipeline.ts`. The runner is NOT modified (if it had to be, STOP).

## Commit

`refactor(pipeline): migrate <X> to runCategoryPipeline (DEBT-01 phase C)`
Stage ONLY `packages/core/src/pipeline/<X>-pipeline.ts` (`git add` that one file), never `git add -A`.
End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Per-pipeline quick reference (verified against `b786900`)

| `<X>` | entry | verdict | extract fn | write fn | extract-error warn prefix |
|------|-------|---------|-----------|----------|---------------------------|
| home | `runHomePipeline` | `"home"` | `extractHome` | `writeHomeToBookmark` | `[roost] home: extraction error for` |
| products | `runProductsPipeline` | `"product"` | `extractProduct` | `writeProductToBookmark` | `[roost] products: extraction error for` |
| tutorials | `runTutorialsPipeline` | `"tutorial"` | `extractTutorial` | `writeTutorialToBookmark` | `[roost] tutorials: extraction error for` |
| workouts | `runWorkoutsPipeline` | `"workout"` | `extractWorkout` | `writeWorkoutToBookmark` | `[roost] workouts: extraction error for` |

(Read your pipeline for the exact CACHE_FILE, tally shape, and log strings — translate them verbatim.)

## Maintenance / hand-off

- After all four land, **Phase D** deletes any now-dead per-pipeline skeleton remnants and refreshes
  the stale `pipeline-runners.harness.test.ts:1232` comment ("Phase B will normalize this") — the
  normalization did NOT happen (behavior preserved via config), so that comment should be updated
  in a test-touching commit then (NOT here — tests stay byte-unchanged in Phase C).
- **Media** is migrated/assessed separately (its playback + deep-link resolution passes don't fit
  the gather→triage→extract→write runner; its triage/extract skeleton may migrate with the extra
  passes kept around the runner call, or media may stay standalone — decided after this batch).
