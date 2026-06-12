# Plan 028b-2: Generalize the runner (fast-path hook + unified logging); migrate home as the pilot

> **Runner v2.** The recipe-only pilot (Phase B) was unrepresentative: 5 of 7 pipelines have a
> functional **tag fast-path** the runner can't express, and they emit different progress logs.
> Per the maintainer's decision, we **unify the progress logging** (cosmetic) and add a
> **fast-path hook** (preserves the functional behavior). This plan generalizes
> `run-category-pipeline.ts`, updates `RECIPE_CONFIG` to the new (simpler) config shape, and
> migrates **home** as the fast-path pilot — proving the generalized runner on BOTH a fast-path
> (home) and a non-fast-path (recipe) pipeline.

## Status

- **Priority**: P3
- **Effort**: L (the delicate generalization step)
- **Category**: tech-debt / architecture (high fix-risk)
- **Status**: TODO
- **Depends on**: 028b (runner) ✅, 028a-2 (fast-path char tests) — base on post-028a-2 main.
- **Written against**: post-028a-2 `main` (orchestrator gives the exact base SHA + worktree).

## Decision baked in: UNIFY the progress logs

Functional behavior is preserved exactly; **progress log text is unified** (the maintainer
approved this). So the runner OWNS a single standard set of progress messages, and the per-pipeline
config no longer carries log fragments — it carries a `label` noun. Recipe's log wording changes to
the unified format too (cosmetic; recipe's Phase A tests don't assert logs, so they stay green).

## Generalize `run-category-pipeline.ts`

### 1. Config interface changes
- **Add** `fastPathTriage?(c: TCand): TVerdict | null` — when present, the runner runs a pre-triage
  pass; when absent (recipe), no pre-pass.
- **Add** `label: string` — the item noun used in unified log messages (e.g. `"recipes"`,
  `"home ideas"`).
- **Remove** the entire `log: { … fragments … }` object (replaced by unified runner-owned messages
  + `label`). Keep everything else: `cacheFile, concurrency, extractVerdict, skipVerdict,
  gatherCandidates, triageItem, extractItem, afterExtract?, writeToBookmark, buildResult,
  onExtractFailure, onTriageFailure`.

### 2. Fast-path pre-pass (new, between gather and the LLM triage loop)
```
log("Scanning bookmarks...")
candidates = config.gatherCandidates(app, syncFolder)
log(`Found ${candidates.length} candidates`)
uncached = candidates.filter(c => !cache[c.roostId])
// fast-path pre-pass (only if config.fastPathTriage present):
let fastCount = 0
if (config.fastPathTriage) {
  for (const c of uncached) {
    const v = config.fastPathTriage(c)
    if (v !== null) { cache[c.roostId] = { triage: v, extraction: null }; fastCount++ }
  }
  if (fastCount > 0) { savePipelineCache(...); log(`Tag fast-path: ${fastCount} auto-kept`) }
}
const needTriage = uncached.filter(c => !cache[c.roostId])
```
The LLM triage loop then iterates `needTriage` (NOT `uncached`). For recipe (no fastPathTriage),
`needTriage === uncached`, so behavior is unchanged.

### 3. Unified log messages (runner-owned; use `config.label`)
Emit EXACTLY this set (these become every pipeline's progress text):
- `"Scanning bookmarks..."` (before gather)
- `` `Found ${candidates.length} candidates` ``
- `` `Tag fast-path: ${fastCount} auto-kept` `` (only when fastPathTriage present AND fastCount>0)
- `` `${needTriage.length} need triage, ${needExtract} need extraction (${complete} complete)` `` (keep the existing counts line; compute needExtract/complete as today)
- `` `Triaging ${needTriage.length} items...` `` (only when needTriage.length>0)
- triage batch progress: `` `Triaged ${Math.min(i+concurrency, needTriage.length)}/${needTriage.length}` ``
- `` `Wrote ${n} cached ${config.label}` `` (only when n>0, after the backfill-cached pass)
- `` `Extracting ${n} ${config.label}...` `` (only when n>0)
- extract batch progress: `` `Extracted ${Math.min(i+concurrency, total)}/${total}` ``
- `` `Done: ${written} ${config.label}, ${skipped} skipped, ${errors} errors` `` (where written =
  count of candidates whose cache entry has `triage===extractVerdict && extraction`; skipped =
  count `triage===skipVerdict`; errors = the running extract-error count)

### 4. Everything else stays as Phase B built it
- Triage caching: allSettled; fulfilled → cache `{triage, extraction:null}`; rejected →
  `onTriageFailure` policy (`"skip"` → `{triage:skipVerdict, extraction:null}` via `batch[j]`).
- Backfill-cached pass (write previously-cached extracted items) — unchanged, before extract loop.
- Extract loop: allSettled; success → `afterExtract?`, set cache, write; null/throw →
  `onExtractFailure` policy (`"demote"` via `batch[j]`) + errors++.
- save-per-batch in both loops. The runner stays generic — ZERO pipeline-specific tokens.

## Update `RECIPE_CONFIG` (recipe-pipeline.ts) to the new interface

- Remove its `log: {…}` fragments; add `label: "recipes"`. Do NOT add `fastPathTriage` (recipe
  has none). Everything else (onExtractFailure:"retry", onTriageFailure:"leave", etc.) unchanged.
- `runRecipePipeline` stays a one-line delegation. recipe's FUNCTIONAL behavior is unchanged; only
  its progress log wording changes (acceptable, untested).

## Migrate home (the fast-path pilot)

In `home-pipeline.ts`, build `HOME_CONFIG`:
- `cacheFile: CACHE_FILE`, `concurrency: CONCURRENCY`, `extractVerdict: "home"`, `skipVerdict: "skip"`,
  `label: "home ideas"`, `onExtractFailure: "demote"`, `onTriageFailure: "skip"`.
- `fastPathTriage: (c) => hasHomeFastPath(c.tags) ? "home" : null`.
- `gatherCandidates`, `triageItem`,
  `extractItem: async (c) => { try { return await extractHome(c); } catch (err) { console.warn(\`[roost] home: extraction error for ${c.roostId}:\`, err); return null; } }`
  (preserve the extract-error warn — the parse-failure warn stays inside extractHome),
- `writeToBookmark: (app, c, ex) => writeHomeToBookmark(app, c.file, ex)`,
- `buildResult: (candidates, cache, errors) => ({ candidates: candidates.length,
  ideas: candidates.filter(c => cache[c.roostId]?.triage === "home" && cache[c.roostId]?.extraction).length,
  skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length, errors })`
  (matches HomePipelineResult; `ideas` equals the original `writtenCount` because backfill-written
  and newly-extracted home items are disjoint and together are exactly the home-with-extraction set).
- Replace `runHomePipeline`'s body with `return runCategoryPipeline(app, syncFolder, HOME_CONFIG, onLog);`.
  Keep its signature; do NOT touch `reconstructHomeCache`, `HOME_ENRICHMENT`, `computeHomeBackfillFields`,
  `writeHomeToBookmark`'s body, or `hasHomeFastPath`.

## Hard gate

These must pass BYTE-UNCHANGED (none assert logs, so unified logging is fine):
- recipe's Phase A tests (single-post/idempotent/skip/restaurant/failing-extraction/compute branches).
- home's Phase A tests + **home's fast-path test from 028a-2** (the proof the fast-path survived).
Do NOT edit any test.

## Verification / done criteria (in the worktree)

```
npm run typecheck                              # exit 0
npm test                                       # 1099 passed / 8 skipped — UNCHANGED, 0 failures
npx vitest run pipeline-runners                # green incl. recipe + home + home fast-path cases
git diff --name-only <BASE>..HEAD              # EXACTLY: run-category-pipeline.ts, recipe-pipeline.ts, home-pipeline.ts
git diff <BASE>..HEAD -- '**/*.test.ts'        # EMPTY
grep -in "recipe\|home\|product\|tutorial\|workout" run-category-pipeline.ts   # ZERO (runner stays generic)
```
- home's fast-path test passing through the generalized runner is the proof the functional
  fast-path is preserved. Behavior preserved for recipe + home; only progress-log text changed.

## STOP conditions
- The runner needs a pipeline-specific branch to fit home → STOP (config under-powered).
- A gated test would need editing to pass → STOP (functional behavior changed — logs don't count,
  but cache/write/tally do).
- typecheck needs `any` inside the runner body → STOP.

## Commit
`refactor(pipeline): generalize runCategoryPipeline (fast-path + unified logs); migrate home (DEBT-01)`
Stage only the 3 files. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Hand-off to 028c-v2
products/tutorials/workouts then migrate as config-only (each: label, fastPathTriage via
has<X>FastPath, demote/skip, extractItem warn-wrapper, buildResult). No runner change should be
needed; if one is, the config is under-powered — surface it.
