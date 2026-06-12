# Plan 028d: DEBT-01 Phase D — final cleanup

## Status

- **Priority**: P3
- **Effort**: XS
- **Category**: tech-debt / hygiene
- **Status**: TODO
- **Depends on**: 028c-v2 (all 5 pipelines migrated) — base on current `main` (`27e0a06`).

## Context

The DEBT-01 consolidation is functionally complete: recipe + home + products + tutorials +
workouts all delegate to the generalized `runCategoryPipeline`. **A dead-import sweep was run
(eslint `no-unused-vars`) and found ZERO new dead code** — the migrations left nothing to remove.
The only remaining item is two now-inaccurate comments.

## The only change: refresh two stale comments

In `packages/core/src/pipeline/__tests__/pipeline-runners.harness.test.ts`, the failing-extraction
characterization tests carry comments predicting a "Phase B will normalize this" change that did
NOT happen — the retry-vs-demote difference was deliberately **preserved via config**
(`onExtractFailure`/`onTriageFailure`), not normalized. Update ONLY these two comment lines:

- **Line ~1232** currently:
  `// characterizes current allSettled error handling — Phase B will normalize this; update intentionally if it changes.`
  Replace with:
  `// characterizes recipe's failure policy: allSettled leaves a failed item for retry. Preserved as-is by runCategoryPipeline (onExtractFailure:"retry") — intentionally NOT normalized.`

- **Line ~1265** currently:
  `// characterizes current all+catch error handling — Phase B will normalize this; update intentionally if it changes.`
  Replace with:
  `// characterizes the all+catch failure policy: a failed item is demoted to the skip verdict. Preserved as-is by runCategoryPipeline (onExtractFailure:"demote") — intentionally NOT normalized.`

Change NOTHING else — no assertion, no test input, no other line. (Locate by the
`Phase B will normalize` text in case line numbers drifted.)

## Verification / done criteria

```
npm run typecheck                              # exit 0
npm test                                       # 1099 passed / 8 skipped — UNCHANGED
git diff <BASE>..HEAD                          # ONLY the two comment lines in the harness test file
git diff <BASE>..HEAD --stat                   # 1 file, ~2 lines changed
```

## STOP conditions
- The `Phase B will normalize` text isn't found (already changed) → STOP, report.
- Anything other than the two comments would need changing → STOP.

## Commit
`docs(test): refresh stale fast-path-vs-demote comments after DEBT-01 consolidation`
Stage only the harness test file. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## After this: DEBT-01 is COMPLETE
5 of 8 pipelines unified on `runCategoryPipeline`; media/places/digest standalone by design;
no dead code; full suite green.
