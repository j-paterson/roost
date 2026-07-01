# Task 7 Report: Remove dead JS trainer

## Status: DONE

## Step 1 — Grep result (proof of no runtime consumers)

```
packages/core/src/config.ts:128:export const LOGREG_MAX_ITERATIONS = 200;
packages/core/src/pipeline/train-head.ts:2:import { fitLogReg } from "@/pipeline/logreg-fit";
packages/core/src/pipeline/train-head.ts:59:export function stratifiedKFold(...)
packages/core/src/pipeline/train-head.ts:78:export function trainStackedHeadsFromRows(...)
packages/core/src/pipeline/train-head.ts:90:  const text = fitLogReg(...)
packages/core/src/pipeline/train-head.ts:91:  const vision = fitLogReg(...)
packages/core/src/pipeline/train-head.ts:94:  const folds = stratifiedKFold(...)
packages/core/src/pipeline/train-head.ts:95:  const Pt = oofProba(...)
packages/core/src/pipeline/train-head.ts:96:  const Pv = oofProba(...)
packages/core/src/pipeline/train-head.ts:98:  const metaFit = fitLogReg(...)
packages/core/src/pipeline/train-head.ts:114:function oofProba(...)
packages/core/src/pipeline/train-head.ts:125:    const fit = fitLogReg(...)
packages/core/src/pipeline/train-head.ts:135:export function trainStackedHeads(vault: Vault) ...
packages/core/src/pipeline/train-head.ts:136:  return trainStackedHeadsFromRows(...)
packages/core/src/pipeline/logreg-fit.ts:4:import { LOGREG_C, LOGREG_TOL, LOGREG_MAX_ITERATIONS } from "@/config";
packages/core/src/pipeline/logreg-fit.ts:32:export function fitLogReg(...)
packages/core/src/pipeline/logreg-fit.ts:96:  const sol = conjugateGradient(f, theta0, { maxIterations: LOGREG_MAX_ITERATIONS });
```

**All hits are definitions only** — no non-test runtime consumer outside the files being deleted. Cleared to proceed.

Note: `train-head-parity.test.ts` (a test file, excluded by `grep -v __tests__`) also imported `trainStackedHeadsFromRows`; it was deleted alongside the TS trainer.

## Files deleted

| File | Reason |
|------|--------|
| `packages/core/src/pipeline/logreg-fit.ts` | The JS logistic-regression implementation — now dead, training runs in the Python sidecar |
| `packages/core/src/pipeline/__tests__/logreg-fit.test.ts` | Tests for the deleted implementation |
| `packages/core/src/pipeline/__tests__/train-head-parity.test.ts` | TS-trainer vs sklearn parity test — moot now that the TS trainer is gone |

## Files modified

| File | Change |
|------|--------|
| `packages/core/src/pipeline/train-head.ts` | Removed `trainStackedHeadsFromRows`, `trainStackedHeads`, `stratifiedKFold`, `oofProba`, `minClassCount`, `headData`; removed imports: `fitLogReg`, `softmaxProba`, `ClassifierHeadData`, `MetaHeadData`, `OOF_FOLDS`. Kept: `TrainingRow`, `selectTrainingPositives`, `buildTrainingRows`. |
| `packages/core/src/config.ts` | Deleted `LOGREG_C`, `LOGREG_TOL`, `LOGREG_MAX_ITERATIONS`. Kept `OOF_FOLDS` (still used by retrain.ts + retrain.test.ts). |
| `packages/core/src/pipeline/__tests__/retrain-perf-guard.test.ts` | Removed `LOGREG_MAX_ITERATIONS` assertion and its import; kept `GATE_OOF < OOF_FOLDS` test; updated comment to reflect sidecar ownership. |
| `packages/core/src/pipeline/__tests__/train-head.test.ts` | Removed `stratifiedKFold` and `trainStackedHeadsFromRows` describe blocks; kept all `selectTrainingPositives` cases. |
| `packages/core/src/settings.ts` | Updated `smartAssignAutoRetrain` interface JSDoc: "Default false — opt in…" → "Default true — retrain runs off-thread in the sidecar". |

## Gate output

**tsc:** clean (exit 0, no output)

**Full test suite:**
```
Test Files  232 passed | 2 skipped (234)
Tests  1951 passed | 9 skipped (1960)
```

## Commit hash

(see git log HEAD)

## Concerns

None. `train-head-parity.test.ts` was not in the original brief's file list because it was an indirect hit (excluded by `grep -v __tests__`), but it imported `trainStackedHeadsFromRows` directly and would have failed the type-check — deleted it as part of removing the JS trainer.
