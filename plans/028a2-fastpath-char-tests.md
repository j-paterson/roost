# Plan 028a-2: Characterize the tag fast-path (gate for the generalized-runner migration)

> **Tests-only.** Phase A's fixtures use empty tags, so the **tag fast-path** — a FUNCTIONAL
> pre-triage pass present in home/products/tutorials/workouts (and media) but NOT recipe — is
> currently untested. Before the runner is generalized to absorb it, pin it. These tests must
> pass on today's unchanged code.

## Status

- **Priority**: P2 (gates 028b-2 / 028c-v2)
- **Effort**: S
- **Category**: tests
- **Status**: TODO
- **Depends on**: 028b (runner) MERGED ✅. Base: current `main` (`b786900`).
- **Written against**: `b786900`.

## What the fast-path does (verified)

In `home/products/tutorials/workouts`-pipeline.ts, `runXPipeline` runs this BEFORE the LLM
triage loop (home example, lines 416-426):
```ts
for (const c of uncached) {
  if (hasHomeFastPath(c.tags)) {        // tag ∈ FAST_PATH_TAGS
    cache[c.roostId] = { triage: "home", extraction: null };   // auto-keep, NO LLM call
    fastCount++;
  }
}
// then the LLM triage loop runs only over uncached items NOT already cached
```
So a candidate whose tags hit `FAST_PATH_TAGS` is classified as the keep verdict **without an
LLM triage call** — even if the LLM would have said "skip". This is the functional behavior the
generalized runner must preserve, so it needs a test.

Each pipeline defines `const FAST_PATH_TAGS = new Set([...])` and `has<X>FastPath(tags)`:
- home: `FAST_PATH_TAGS` at `home-pipeline.ts:84`
- products: `products-pipeline.ts:88`
- tutorials: `tutorials-pipeline.ts:97`
- workouts: `workouts-pipeline.ts:79`
Read each set and pick ONE real tag from it for that pipeline's test.

## What to add — one fast-path test per pipeline (home, products, tutorials, workouts)

Add to `packages/core/src/pipeline/__tests__/pipeline-runners.harness.test.ts`, reusing its
helpers (`makeRawSyncFile`, `installOllamaStub`, `makeXExtraction`). Per pipeline:

**Test: "tag fast-path auto-keeps a tagged item even when LLM triage would skip it"**
1. Create a candidate that (a) is gathered by the pipeline (satisfies its category/tag gate —
   set the embedding category and/or tags so `gatherCandidates` includes it) AND (b) has a tag
   from that pipeline's `FAST_PATH_TAGS` in its bookmark frontmatter `tags`. (Inspect how the
   harness/`makeRawSyncFile` sets frontmatter `tags`; if it can't set tags, extend the fixture
   builder test-side to write the bookmark with a `tags:` frontmatter list — do NOT change
   production code.)
2. `installOllamaStub("skip", makeXExtraction())` — the LLM triage, IF consulted, returns "skip".
3. Run the pipeline via its `EnrichmentDef.runBackfill` (as the existing cases do).
4. **Assert** the fast-path won over the LLM:
   - the item's `<x>_*` fields ARE written to the source bookmark (it was kept + extracted),
     even though the triage stub said "skip";
   - and the pipeline cache entry for it is `{ triage: "<keep-verdict>", extraction: <…> }`,
     NOT `{ triage: "skip", … }`.
   This proves the tag fast-path classified it without the LLM. (Contrast: an item with NO
   fast-path tag + stub "skip" would be skipped — the existing skip tests already cover that.)

> If you discover a pipeline's fast-path tag also independently satisfies the LLM triage path
> (so the test can't distinguish fast-path from LLM-keep), make the distinction sharp by keeping
> the stub at "skip" — a skip-stub + an enriched result can ONLY happen via the fast-path. If you
> still can't construct a distinguishing fixture, STOP and report for that pipeline.

## Verification / done criteria

```
npm run typecheck                              # exit 0
npm test                                       # 1095 + 4 new = 1099 passed / 8 skipped, 0 failures
npx vitest run pipeline-runners                # harness green incl. the 4 new fast-path tests
git diff --name-only b786900..HEAD             # ONLY pipeline-runners.harness.test.ts (+ fixture-builder if you extended it, still a test file)
git diff b786900..HEAD -- 'packages/core/src/pipeline/*.ts' ':!**/__tests__/**'  # EMPTY (no production source)
```
- All 4 new tests pass on UNCHANGED production code (characterization).
- No production `.ts` changed.

## STOP conditions

- A fast-path test can't be made to distinguish fast-path-keep from LLM-keep without changing
  production code → STOP, report that pipeline.
- Adding the test requires a production change (beyond test-side fixture work) → STOP.

## Commit

`test(pipeline): characterize the tag fast-path for home/products/tutorials/workouts (DEBT-01)`
Stage only the test file(s) (`git add <files>`), never `git add -A`.
End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Hand-off

These 4 tests + Phase A's existing tests gate 028b-2 (generalize the runner with a
`fastPathTriage?` hook + unified progress logging; migrate home as the fast-path pilot) and
028c-v2 (migrate products/tutorials/workouts). The migrations must keep all of them green
byte-unchanged — that is the proof the fast-path survived the consolidation.
