# Task 7 Report: Observability — retrain-log + notice

## Status: DONE

**Commit:** `8fff93a`

---

## TDD Red/Green for parseRetrainLines

### Red
Test at `packages/core/src/pipeline/__tests__/retrain-log.test.ts` importing `parseRetrainLines` from non-existent `@/pipeline/retrain-log` — vitest failed with module-not-found (TransformPluginContext error), 0 tests run.

### Green
After creating `retrain-log.ts`, all 3 tests passed in 208ms (valid+garbage parse, empty string, optional delta fields).

---

## RetrainOutcome + log wiring

`RetrainOutcome` gains `avgOverallDelta?`, `avgMacroDelta?`, `catastrophic?: string[]`. `appendRetrainLog` is called on all 6 return paths of `runRetrain`:

| Path | ran | swapped | delta fields |
|---|---|---|---|
| no eligible data | false | false | none |
| no gate folds | false | false | none |
| gate failed | true | false | avgOverallDelta, avgMacroDelta, catastrophic from foldDecision |
| trainer returned null | false | false | none |
| write failed, restored | true | false | none |
| swapped (gate passed / first head) | true | true | from foldDecision where available |

---

## Notice wiring

`Notice` imported from `"obsidian"` in `clustering.ts`. `maybeRetrainAtRunStart` now captures the `runRetrain` return; when `outcome.ran`:
- swap: `"Classifier improved (+X.X% macro)"` using `outcome.avgMacroDelta`
- reject: `"Retrain skipped — would regress {catastrophic list or 'overall/macro'}"` 

All inside the existing try/catch — notice failure cannot break the run.

---

## tsc result

```
npx tsc --noEmit -p tsconfig.json
(no output — clean)
```

---

## Full suite result

```
Test Files  192 passed | 1 skipped (193)
Tests       1734 passed | 8 skipped (1742)
Duration    7.17s
```

Zero failures. New test file adds 3 tests to the passing count.

---

## Concerns

None. The deferred class-keeps-blocking honesty flag was not added per spec (YAGNI; retrain-log carries the data to add it later).

---

## Notice fix

### FIX 1 — Distinct write-error Notice (`clustering.ts`)

Extracted a pure helper `retrainNoticeMessage(outcome: RetrainOutcome): string | null` from the inline Notice logic in `maybeRetrainAtRunStart`. The helper implements a 3-way branch:

| `outcome` condition | Notice string |
|---|---|
| `!ran` | `null` (no notice) |
| `swapped` | `"Classifier improved (+X.X% macro)"` |
| `!swapped && reason === "write failed, restored previous"` | `"Retrain failed (write error) — kept current head"` |
| `!swapped` otherwise (gate rejected) | `"Retrain skipped — would regress {classes or 'overall/macro'}"` |

`maybeRetrainAtRunStart` now calls `const msg = retrainNoticeMessage(outcome); if (msg) new Notice(msg);` — the Notice path is still inside the existing try/catch, so a Notice failure cannot break the run. `RetrainOutcome` type is imported via named type import.

### FIX 2 — Gate deltas on write-fail path (`retrain.ts`)

The write-fail return path now spreads `foldDecision?.avgOverallDelta`, `foldDecision?.avgMacroDelta`, and `foldDecision?.catastrophicClasses` into both the returned `RetrainOutcome` and the `appendRetrainLog` record. This matches what the gate-pass and gate-fail paths already do, so the log no longer loses gate metrics that were good enough to trigger a swap attempt.

### New tests (`clustering-retrain-start.test.ts`)

Six `retrainNoticeMessage` cases added:

- `ran: false` → `null`
- swap with macro delta → `"Classifier improved (+3.4% macro)"`
- swap without delta → `"Classifier improved (+?% macro)"`
- write-fail reason → `"Retrain failed (write error)…"` (asserts NOT "would regress")
- gate-fail with catastrophic classes → `"Retrain skipped — would regress nsfw, violence"`
- gate-fail with empty catastrophic → `"Retrain skipped — would regress overall/macro"`

### Run result

```
npx tsc --noEmit   → clean (no output)
npx vitest run     → Test Files 192 passed | 1 skipped (193)
                     Tests      1740 passed | 8 skipped (1748)
                     Duration   7.19s
```

+6 tests vs. prior baseline (1734 → 1740).
