# Plan 028c-v2: DEBT-01 Phase C (v2) — migrate products, tutorials, workouts to the generalized runner

> **Final consolidation step.** With the runner generalized (fast-path hook + unified logging) and
> **home** migrated as the pilot (028b-2), migrate the remaining three fast-path pipelines —
> **products, tutorials, workouts** — as **config-only** changes. Each is independent (own file),
> a pure-functional refactor (logs already unified), gated by that pipeline's Phase A tests + its
> fast-path test passing **byte-unchanged**. **Each executor migrates ONE pipeline.**

## Status

- **Priority**: P3
- **Effort**: M per pipeline (×3)
- **Category**: tech-debt / architecture
- **Status**: TODO
- **Depends on**: 028b-2 (generalized runner + home pilot) — base on post-028b-2 main.
- **Written against**: post-028b-2 `main` (orchestrator gives the exact base SHA + worktree per pipeline).

## The template: home (already migrated in 028b-2)

Read `HOME_CONFIG` + the one-line `runHomePipeline` in `home-pipeline.ts` on the base — it is the
EXACT pattern to copy. Also read the generalized `run-category-pipeline.ts` and its
`CategoryPipelineConfig` (fields: `cacheFile, concurrency, extractVerdict, skipVerdict, label,
gatherCandidates, triageItem, extractItem, afterExtract?, writeToBookmark, buildResult,
onExtractFailure, onTriageFailure, fastPathTriage?`). The runner owns all progress logging now
(unified, via `label`) — you do NOT supply log strings.

## The migration (apply to YOUR pipeline `<X>`)

In `packages/core/src/pipeline/<X>-pipeline.ts`:
1. Read `run<X>Pipeline` and its result type. Note its `gatherCandidates`, `triageItem`,
   `extract<X>`, `write<X>ToBookmark`, the `has<X>FastPath` gate, the tally object, and the
   `[roost] <x>: extraction error for ...` warn inside the extract loop.
2. Add `<X>_CONFIG: CategoryPipelineConfig<…>` exactly like `HOME_CONFIG`:
   - `cacheFile: CACHE_FILE`, `concurrency: CONCURRENCY`, `extractVerdict: "<verdict>"`,
     `skipVerdict: "skip"`, `label: "<plural noun>"`, `onExtractFailure: "demote"`,
     `onTriageFailure: "skip"`.
   - `fastPathTriage: (c) => has<X>FastPath(c.tags) ? "<verdict>" : null`.
   - `gatherCandidates`, `triageItem`,
     `extractItem: async (c) => { try { return await extract<X>(c); } catch (err) { console.warn(\`[roost] <x>: extraction error for ${c.roostId}:\`, err); return null; } }`
     (preserves the extract-error warn; the parse warn stays inside `extract<X>`),
   - `writeToBookmark: (app, c, ex) => write<X>ToBookmark(app, c.file, ex)`,
   - `buildResult: (candidates, cache, errors) => ({ …EXACT current tally… })` — reproduce
     `run<X>Pipeline`'s return object field-for-field. For the "written/enriched" count, compute
     `candidates.filter(c => cache[c.roostId]?.triage === "<verdict>" && cache[c.roostId]?.extraction).length`
     (equals the original running `writtenCount` — backfill-written and newly-extracted items are
     disjoint and together are exactly the `<verdict>`-with-extraction set). `skipped` =
     `candidates.filter(c => cache[c.roostId]?.triage === "skip").length`; `errors` = the passed `errors`.
   - `afterExtract`: OMIT unless `run<X>Pipeline` mutates the extraction post-extract (home/products/
     tutorials/workouts are not expected to; if yours does, add it — and if it's something the
     runner can't express, STOP).
3. Replace `run<X>Pipeline`'s body with `return runCategoryPipeline(app, syncFolder, <X>_CONFIG, onLog);`.
   Keep its signature. Do NOT touch `reconstruct<X>Cache`, `<X>_ENRICHMENT`, `compute<X>BackfillFields`,
   `write<X>ToBookmark`'s body, `extract<X>`, or `has<X>FastPath`.
4. **Do NOT modify `run-category-pipeline.ts`.** If the generalized runner can't express your
   pipeline, STOP and report (config under-powered) — do NOT edit the runner.

## Per-pipeline reference (verified against base `b786900`; re-confirm on your base)

| `<X>` | entry | verdict | fast-path gate | extract fn | write fn | warn prefix |
|------|-------|---------|----------------|-----------|----------|-------------|
| products | `runProductsPipeline` | `"product"` | `hasProductFastPath` | `extractProduct` | `writeProductToBookmark` | `[roost] products: extraction error for` |
| tutorials | `runTutorialsPipeline` | `"tutorial"` | `hasTutorialFastPath` | `extractTutorial` | `writeTutorialToBookmark` | `[roost] tutorials: extraction error for` |
| workouts | `runWorkoutsPipeline` | `"workout"` | `hasWorkoutFastPath` | `extractWorkout` | `writeWorkoutToBookmark` | `[roost] workouts: extraction error for` |

(Read your file for the exact CACHE_FILE, the result object shape, and a sensible `label`.)

## Hard gate (do NOT edit any test)

Your pipeline's Phase A tests (single-post/idempotent/skip/compute-branch + the failing-extraction
test if it has one) AND its fast-path test (from 028a-2) must pass BYTE-UNCHANGED. The fast-path
test passing through the runner proves the functional fast-path survived.

## Verification / done criteria (in YOUR worktree)

```
npm run typecheck                              # exit 0
npm test                                       # 1099 passed / 8 skipped — UNCHANGED, 0 failures
npx vitest run pipeline-runners                # green incl. YOUR pipeline's cases + fast-path test
git diff --name-only <BASE>..HEAD              # EXACTLY: packages/core/src/pipeline/<X>-pipeline.ts
git diff <BASE>..HEAD -- '**/*.test.ts'        # EMPTY
git diff <BASE>..HEAD -- packages/core/src/pipeline/run-category-pipeline.ts  # EMPTY (runner untouched)
```

## STOP conditions
- The runner would need a change to fit your pipeline → STOP (config under-powered; report).
- A gated test would need editing → STOP (functional behavior changed — logs are exempt, cache/write/tally are not).
- Your pipeline has an extra pass beyond gather→fast-path→triage→extract→write (like media's playback/
  deeplink) → STOP and report (it doesn't belong in this batch).

## Commit
`refactor(pipeline): migrate <X> to runCategoryPipeline (DEBT-01 phase C)`
Stage ONLY `packages/core/src/pipeline/<X>-pipeline.ts`. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Hand-off to Phase D
After these merge, Phase D: sweep each migrated pipeline file for now-dead imports/helpers
(eslint no-unused-vars / knip) introduced by dropping the inline skeleton, and refresh the stale
`pipeline-runners.harness.test.ts:~1232` "Phase B will normalize this" comment (normalization did
not happen — behavior preserved). That's the only remaining DEBT-01 work; media/places/digest stay
standalone.
