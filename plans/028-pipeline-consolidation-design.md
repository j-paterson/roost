# Plan 028: Pipeline consolidation — DESIGN (DEBT-01)

> ⚠️ **DESIGN ONLY — NOT cleared for execution.** This is the highest fix-risk change
> in the repo (it rewrites the control flow of 7 user-facing enrichment pipelines). The
> audit deferred DEBT-01 precisely because "consolidation before characterization tests
> exist would be the riskiest change in the repo for modest payoff." Those tests now
> partially exist, so this design is presentable — but it needs an explicit maintainer
> go-ahead, and it must be executed **phase-by-phase, one pipeline at a time**, never as
> a single big-bang refactor. My advisor recommendation (worth it / defer) is in the last
> section.

## Status

- **Priority**: P3 (debt; not a bug)
- **Effort**: L (~2–3 focused days; subagent line-estimate ~52h)
- **Category**: tech-debt / architecture
- **Status**: DESIGN — awaiting go/no-go
- **Finding**: DEBT-01
- **Written against commit**: `960199f`
- **Depends on**: 006 (write-path char tests) ✅, TESTS-02 / 023 (sync parser char tests) ✅,
  and a NEW prerequisite test phase (Phase A below) that does not exist yet.

## The problem, quantified (verified against the code)

Seven category enrichment pipelines share one near-identical control-flow skeleton,
differing only in taxonomy, prompts, extraction schema, and frontmatter fields:

| Pipeline | File | Lines | Entry | Triage verdicts |
|---|---|---|---|---|
| home | `home-pipeline.ts` | 562 | `runHomePipeline` | home / skip |
| media | `media-pipeline.ts` | 874 | `runMediaPipeline` | media / skip (+ deep-link resolution) |
| places | `places-pipeline.ts` | 792 | `runPlacesPipeline` | place / skip (+ geonames/nominatim) |
| products | `products-pipeline.ts` | 527 | `runProductsPipeline` | product / skip |
| recipe | `recipe-pipeline.ts` | 523 | `runRecipePipeline` | **recipe / restaurant / skip** |
| tutorials | `tutorials-pipeline.ts` | 561 | `runTutorialsPipeline` | tutorial / skip |
| workouts | `workouts-pipeline.ts` | 530 | `runWorkoutsPipeline` | workout / skip |

The repeated skeleton per file is: `gatherCandidates` → cache load → triage loop (batched,
`CONCURRENCY = 3`) → cached-extraction backfill → extraction loop (batched) → write →
result tally. Roughly **~1,645 lines of near-identical boilerplate** (≈140-line skeleton +
≈95-line `gatherCandidates`, ×7) plus **~2,800 lines** of same-structure / different-content
prompt & parse code. (digest-pipeline.ts at 965 lines is a different shape — see Out of scope.)

**What is ALREADY factored out** (do NOT re-extract):
- `pipeline/shared.ts` (389 lines): `ollamaGenerate`, `loadEmbeddingCache`/`saveEmbeddingCache`,
  `readRawJson`, `extractDescription`, `loadPipelineCache<T>`/`savePipelineCache<T>`,
  cosine/centroid math, `stripPreamble`/`stripJsonFence`.
- **The registry seam already exists.** Every pipeline exports an `EnrichmentDef`
  (`@/lib/enrichments`) — e.g. `RECIPE_ENRICHMENT` (`recipe-pipeline.ts:498-523`) with
  `id`, `runBackfill`, `categoryMatches`, `fieldsWritten`, `chips`. The harness test already
  drives the pipelines *through this registry*. This is the natural home for a config object.
- `computeRecipeBackfillFields` (`recipe-pipeline.ts:301`) is already a **separately exported,
  testable** pure function. Several pipelines follow this `computeXBackfillFields` +
  `writeXToBookmark` split — the variation is already isolated from the I/O.

## Why this is the repo's riskiest change (the real hazards)

These are concrete, verified divergences that a naive "extract the common skeleton" pass
would silently flatten — each is a behavior-change risk:

1. **Triage verdict sets differ.** Recipe has THREE outcomes (`recipe`/`restaurant`/`skip`,
   `recipe-pipeline.ts:203-212`); others are binary. A parametric runner must treat the
   verdict set as per-pipeline config, not a fixed `verdict | "skip"`.
2. **Batching idiom has already drifted.** recipe uses `Promise.allSettled`
   (`recipe-pipeline.ts:383,423`); the other pipelines use `Promise.all(...).catch(...)`.
   These differ in error semantics (a rejection in `all` short-circuits the batch map's
   error handler per-item vs `allSettled` never rejects). Consolidating to ONE idiom is the
   *point*, but it WILL change the failure behavior of whichever pipelines don't currently
   match the chosen idiom — that must be pinned by tests first and reviewed deliberately.
3. **Subcategory backfill rules vary** (`computeRecipeBackfillFields:316-332` vs media's
   complex rule-2 vs pipelines with none). Must be a per-config callback, not inlined.
4. **`gatherCandidates` extracts different per-category fields** (recipe's `recipeLink` from
   author bio, media's `spotifyTrackId`, places' POI). The candidate type is per-pipeline.
5. **Cache reconstruction** (`reconstructRecipeCache:466`) reads category-specific
   frontmatter back into the cache shape — per-pipeline, registry-invoked on first backfill.
6. **media & places carry extra pipeline stages** (TMDB/AniList/Spotify resolution;
   GeoNames/Nominatim) that have no analogue elsewhere.

## Proposed seam

Extend the existing registry pattern into a **`CategoryPipelineConfig<TCand, TExtract, TVerdict>`**
consumed by a single generic runner:

```ts
// pipeline/run-category-pipeline.ts (NEW)
interface CategoryPipelineConfig<TCand, TExtract, TVerdict extends string> {
  id: string;
  cacheFile: string;
  concurrency?: number;                    // default 3
  verdicts: { extractOn: TVerdict; all: readonly TVerdict[] }; // recipe: extractOn "recipe", all ["recipe","restaurant","skip"]
  gatherCandidates(app: App, syncFolder: string): TCand[];
  triageItem(c: TCand): Promise<TVerdict>;
  extractItem(c: TCand): Promise<TExtract | null>;
  writeToBookmark(app: App, c: TCand, extraction: TExtract): Promise<void>;
  afterExtract?(c: TCand, extraction: TExtract): TExtract; // e.g. recipe attaches recipeLink (recipe-pipeline.ts:433)
  tally(cache, candidates): TResult;       // per-pipeline result shape
}

export async function runCategoryPipeline<…>(app, syncFolder, config, onLog?): Promise<TResult>
```

Each `runXPipeline` becomes a thin adapter: `return runCategoryPipeline(app, syncFolder, X_CONFIG, onLog)`.
The per-pipeline file keeps everything category-specific (taxonomy, prompts, `extractX`,
`computeXBackfillFields`, `reconstructXCache`) — only the skeleton moves out.

## Phased execution (each phase independently revertible, gated by green tests)

**Phase A — Characterization safety net FIRST (prerequisite; do this even if consolidation is later deferred).**
The existing `__tests__/pipeline-runners.harness.test.ts` drives all 7 through the registry
and checks single-post write + idempotent re-run + skip-caching — a good start but NOT
sufficient. Add, per pipeline: (a) the exact triage verdict mapping (esp. recipe's 3-way),
(b) `computeXBackfillFields` unit tests covering each subcategory-backfill branch, (c) a
batch with one failing extraction (to pin the current `all` vs `allSettled` error behavior
BEFORE it's normalized), (d) cache-reconstruction round-trip. These tests must pass on
today's code unchanged. **This phase is valuable on its own** and low-risk — it can land
regardless of whether Phases B–D ever run.

**Phase B — Introduce the runner, prove equivalence on ONE pipeline.** Build
`run-category-pipeline.ts` + `recipe`'s config; switch `runRecipePipeline` to the adapter.
Recipe is chosen as the pilot because it's mid-size, already has the cleanest
`compute*`/`write*`/`reconstruct*` split, AND it has the awkward 3-verdict case — if the
config can express recipe, it can express the binary ones. Phase A's recipe tests must stay
green byte-for-byte. Decide the canonical batching idiom here and document the behavior delta.

**Phase C — Migrate the remaining simple pipelines one at a time** (home, products, tutorials,
workouts, then media). Each is its own commit + review, gated by its Phase-A tests. STOP and
report if any pipeline's tests can't be made green without changing the config contract
(signals the abstraction is leaking).

**Phase D — Delete the now-dead per-pipeline skeletons** and confirm no orphaned constants.

## Out of scope (leave standalone)

- **digest-pipeline.ts** — different shape (weekly clustering + memory writer); not a triage→extract pipeline.
- **places-pipeline.ts** — GeoNames + Nominatim + cache versioning; revisit only after B–D prove out.
- **media's deep-link resolution** (TMDB/AniList/Spotify) — orthogonal extra stage; keep its
  control flow separate even if its triage/extract skeleton migrates.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Flattening the `all`/`allSettled` divergence silently changes error handling | Phase A test (c) pins current behavior per pipeline; normalize deliberately, document, review |
| Multi-verdict (recipe) breaks a binary-assuming runner | `verdicts.all` in config + pilot on recipe in Phase B |
| Subcategory backfill regressions (user-visible frontmatter) | `compute*` stays per-pipeline + unit-tested in Phase A |
| Generic types (`TCand`/`TExtract`) become an `any`-soup that loses safety | Per-pipeline candidate/extraction types stay concrete; runner is generic over them |
| Big-bang merge is unreviewable | One pipeline per commit/review; revert is one branch |

## Advisor recommendation (the honest call)

**Do Phase A regardless** — pinning each pipeline's triage/backfill/error behavior is pure
upside (catches the exact drift class the decomposition kept hitting) and is low-risk;
it's worth landing on its own.

**Phases B–D: proceed only if the maintainer expects to add more pipelines or actively
maintain these.** The payoff is real but it's *debt reduction, not a bug fix*: ~1,645 fewer
boilerplate lines, single-point fixes, ~30-min new-pipeline cost. Against that, it touches
7 working user-facing paths and normalizes a known behavior divergence (#2). If the pipeline
set is stable and nobody's adding categories, the leverage is **modest** and I'd **defer
B–D** in favor of higher-value work. This is a maintainer's call — hence DESIGN ONLY.

## If approved

Split into executable plans: `028a` (Phase A tests), `028b` (runner + recipe pilot),
`028c` (per-pipeline migrations, one sub-task each), `028d` (cleanup). Each gets the full
self-contained executable-plan treatment (current-state excerpts, done criteria, STOP
conditions) at that time.
