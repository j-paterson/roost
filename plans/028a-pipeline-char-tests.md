# Plan 028a: DEBT-01 Phase A — characterization safety net for the 7 pipelines

> **Phase A of the approved A→D pipeline consolidation (design: `plans/028-pipeline-consolidation-design.md`).**
> This phase adds tests ONLY — no production code is refactored here. Its job is to pin the
> exact behavior the later phases (B–D) will rewrite, so a regression in the parametric-runner
> migration is caught immediately. **These tests must pass on today's unchanged code.**

## Status

- **Priority**: P2 (gates Phase B)
- **Effort**: M
- **Category**: tests / tech-debt
- **Status**: TODO
- **Depends on**: 027 (ESLint) ✅, 030 (dead-import cleanup — base on post-030 main)
- **Written against**: current `main` after 030 merges (orchestrator will give you the exact base SHA + worktree)

## Background the executor needs (no prior context assumed)

Roost has 7 "enrichment pipeline" modules under `packages/core/src/pipeline/`:
`home-pipeline.ts`, `media-pipeline.ts`, `places-pipeline.ts`, `products-pipeline.ts`,
`recipe-pipeline.ts`, `tutorials-pipeline.ts`, `workouts-pipeline.ts`. Each scans the vault for
candidate bookmarks, LLM-**triages** them (keep/skip), LLM-**extracts** structured data, and
writes `<cat>_*` frontmatter fields onto the source bookmark. They share a near-identical
skeleton (triage loop → extraction loop, both batched at `CONCURRENCY = 3`, with a pipeline
cache JSON). A future refactor will replace those 7 skeletons with one parametric runner; this
plan locks current behavior first.

**The existing test file** `packages/core/src/pipeline/__tests__/pipeline-runners.harness.test.ts`
is your template and the file you extend. Study its helpers before writing anything:
- `makeRawSyncFile(baseDir, roostId, syncFolder, embeddingCategory)` — builds a sync note +
  `raw.json` sidecar + embedding-cache entry + zero-vector `embedding-vectors.bin`.
- `installOllamaStub(triageVerdict, extractionJson)` — mocks `ollamaGenerate`: a short
  (`num_predict ≤ 10`) call returns `triageVerdict`; a longer call returns
  `JSON.stringify(extractionJson)`.
- `makeRecipeExtraction()`, `makeMediaExtraction({mediaType})`, `makePlaceExtraction()`,
  `makeProductExtraction()`, `makeWorkoutExtraction()`, `makeTutorialExtraction()`,
  `makeHomeExtraction()` — per-pipeline extraction fixtures with overrides.
Follow these EXACT patterns; do not invent a new test harness.

## What is already covered (do NOT duplicate)

- **recipe, media, product, place, workout**: full single-post run (triage→extract→write the
  `<cat>_*` fields), idempotent re-run (no churn), skip caching, and "no `Pipelines/<X>/` notes
  spawned". Media also has 3 subcategory-backfill rules + a filter-scoped run + the
  "no `media_type` field" assertion.
- **tutorial, home**: `compute*BackfillFields` pure-function branch tests + `write*ToBookmark`
  I/O idempotence — but **NO full-pipeline integration test**.

## What to ADD (this plan) — four groups, all in or beside the existing harness

> Characterization discipline: where current behavior is non-obvious (esp. Group 3), **first
> write the test, run it, OBSERVE the actual output, then encode that observed value as the
> assertion.** You are locking what the code does today, not what you think it should do. If
> something looks like a bug, do NOT fix it — pin it and note it in your report.

### Group 1 — Full-pipeline integration for the two uncovered pipelines (tutorial, home)

Mirror the recipe single-post tests (harness lines ~742-792) for **tutorial** and **home**:
- a) Single matching post → run pipeline → the source bookmark gets the pipeline's
  `fieldsWritten` set (tutorial: `tutorial_topic, tutorial_skill_area, tutorial_difficulty,
  tutorial_time_estimate, tutorial_tools, tutorial_steps`; home: `home_title, home_room,
  home_idea_type, home_style, home_budget, home_description, home_products, home_tips`), and
  NO note is created under `Pipelines/Tutorials/` or `Pipelines/Home/`.
- b) Idempotent re-run: a second run does not call `vault.modify` again (no churn).
- c) Skip path: stub triage returns `skip` → no `<cat>_*` fields written, skip is cached.
Use `installOllamaStub("tutorial", makeTutorialExtraction())` / `installOllamaStub("home",
makeHomeExtraction())`. Drive the pipeline through its `EnrichmentDef.runBackfill` exactly as the
existing cases do (registry consts: `TUTORIAL_ENRICHMENT`, `HOME_ENRICHMENT`).

### Group 2 — recipe's 3-way triage (the "restaurant" verdict)

recipe is the only pipeline whose triage returns three values (`recipe` | `restaurant` |
`skip`; `recipe-pipeline.ts` triage maps `startsWith("recipe")`/`startsWith("restaurant")`/else
`skip`). The `restaurant` path is currently untested. Add:
- Stub triage returns `"restaurant"` → run → assert: NO `recipe_*` fields written, NO
  `Pipelines/` note, and the item is cached as `restaurant` (observe the exact cache entry shape
  written to the recipe cache file and assert it). This pins that a non-extract verdict that is
  ALSO not "skip" is handled correctly — the parametric runner must preserve a per-pipeline
  verdict set, not assume binary keep/skip.

### Group 3 — Failing-extraction behavior (THE divergence the refactor normalizes) ⚠️

recipe uses `Promise.allSettled`; the other six use `Promise.all(c => extract(c).catch(()=>null))`.
On a failed extraction these may cache differently (recipe leaves the entry as
`{triage:"recipe", extraction:null}` for retry via `extractErrors++`; the `all+catch` pipelines
may cache as skip or also leave for retry). Pin both shapes:
- a) **recipe** (allSettled): a 2-item batch where item A extracts OK and item B's extraction
  fails. Make B fail by having the ollama stub throw (or return unparseable JSON so
  `extractRecipe` returns null) for B's extraction call only. Run, then assert: A's `recipe_*`
  fields are written; B is NOT written; and the recipe cache entry for B is **exactly** what the
  code leaves today (observe it and encode it). Also assert the run's result tally (`errors`).
- b) **product** (all+catch, representative of the other six): same 2-item A-ok/B-fails setup
  via the product stub. Observe and pin product's cache entry for the failed item and the tally.
Add a one-line comment in each test noting "characterizes current <allSettled|all+catch> error
handling — Phase B will normalize this; update intentionally if it changes."
(If the harness stub can't fail a single specific item, extend the stub minimally — e.g. accept
a per-roostId override map — within this test file only; do not change pipeline source.)

### Group 4 — `compute*BackfillFields` branch tests for the four that lack them

media/tutorial/home already have these. Add pure-function branch tests for **recipe, place,
product, workout** (all four export `compute<X>BackfillFields(extraction, existingFm)`). For
each, cover its subcategory-backfill branches (verified rules below) by passing different
`existingFm`:
- **empty fm** → sets the pipeline's category + subcategory from the extraction's type field.
  - recipe → `roost_category="Recipes"`, `roost_subcategory = extraction.cuisine`
  - place → `"Places"`, `extraction.placeType`
  - product → `"Products"`, `extraction.productType`
  - workout → `"Workouts"`, `extraction.workoutType`
- **matching existing category, no subcategory** (recipe: one of `Recipes/Food/Food & Drink/
  Cooking`; place: `Places/Travel`; product: `Product/Products/Gear/Shopping`; workout:
  `Fitness/Workouts/Workout/Exercise`) → sets `roost_subcategory` only, leaves category.
- **non-matching existing category** (e.g. `"Travel"` for recipe) → sets NEITHER
  category nor subcategory.
- **subcategory already set** → never overwrites it.
- Also assert the happy-path field set (all `<cat>_*` fields + the `enrichment_v_<cat>` version)
  is present. Follow the existing media/tutorial branch tests as the exact assertion style.

## Out of scope

- NO production-code refactor (that's Phase B+). You may export a currently-internal symbol ONLY
  if a test genuinely needs it AND the change is a pure `export` keyword addition — but prefer
  driving through the public `EnrichmentDef.runBackfill` / the already-exported `compute*`
  functions; flag in your report if you had to add any `export`.
- NO `reconstruct*Cache` round-trip tests (those functions aren't touched by the refactor).
- Do NOT touch `digest-pipeline.ts`, `places` geo-resolution, or media's playback/deeplink paths.
- Do NOT modify any existing assertion in the harness — only ADD tests.

## Verification / done criteria

```
npm run typecheck                 # exit 0
npm test                          # was 1066 passed / 8 skipped; expect 1066 + N new passing, 0 failures
npm test -- pipeline-runners      # the harness file is green incl. all new tests
git diff --name-only <BASE>..HEAD # expect ONLY the harness test file (+ any new sibling *.test.ts you added); NO pipeline source .ts unless a flagged export-only change
```

- Every new test PASSES on unchanged production code (this is the proof it's a true
  characterization, not a spec change).
- Net test count strictly increases; zero failures; the 8 pre-existing skips unchanged.
- Your report states, per group, how many tests were added and — for Group 3 — the exact
  observed failing-extraction cache behavior you pinned for recipe vs product (this is the key
  hand-off fact for Phase B).

## STOP conditions

- A "characterization" test you write FAILS on current code and you can't make it pass by
  correcting the EXPECTATION (i.e. it reveals the code does something other than the spec above)
  → STOP for that case, report what the code actually does; do not change production code to fit.
- Pinning Group 3 requires changing pipeline source (not just the test file/stub) → STOP and
  report; the stub should be extendable test-side.
- Adding integration tests for tutorial/home requires more than `export`-only source changes →
  STOP and report.

## Commit

`test(pipeline): characterization net for 7 enrichment pipelines (DEBT-01 phase A)`
Stage only the test file(s) you added/changed (`git add <files>`), never `git add -A`.
End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Maintenance note (hand-off to Phase B)

Phase B introduces `runCategoryPipeline` + a recipe config and switches `runRecipePipeline` to it.
Group 1–3 tests are the gate it must keep green. The Group 3 observed behavior tells Phase B which
batching idiom is canonical and what error-caching delta (if any) is being introduced deliberately.
