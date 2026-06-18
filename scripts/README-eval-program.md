# Categorization Eval Program — Operator Guide

> Phase 1: measurement rig + cheap method sweep (Stage 0 + Stage 1).
> Spec: `docs/superpowers/specs/2026-06-18-categorization-eval-program-design.md`
> Pre-registered matrix: `scripts/pre-registration.md`

## Overview

This eval program measures how well the 19-category Smart Assign classifier works on
the 4,320-item cross-platform honest fixture. The goal is a defensible comparison that
**decides** the classifier before any production deployment.

**Methodology note:** all tools below use the REAL production scorer
(`scoreAgainstCategories` / `buildCategoryDefs`) or read predictions it emitted —
never a Python reimplementation of those functions. GT is always the human `collection`
field; `roost_category` is never used as ground truth.

## Tools (reused / reworked — not new scripts)

### `honest-eval.py` (extended, same file)
The standing measurement entry point. Extensions added for Phase 1:
- `--predictions <file>` — score an external `predictions.json` through all existing
  guards (the TS exporter writes this; Python only grades it). The internal `rank()`
  is replaced by a lookup; guards are untouched.
- `--by-platform` — split ACCURACY / OSCR / AUROC / AUPR / AURC by platform prefix
  in `roost_id` (tiktok / twitter).
- Prints **OSCR + AUROC + AUPR + AURC** together (never OSCR alone).

Original flags unchanged: `--split`, `--cache`, `--centroids`, `--rejection`,
`--op-lambda`, `--op-r`.

### `classifier-head-diagnostic.py` (reworked, same file)
Was: scores against the old 119-item `strategy-results.json` test set.
Now: sources test IDs from `eval-fixture-large.json` (dev / holdout split) and the
19 canonical categories. Label-loading and LOO / strict-holdout logic unchanged.
Interprets whether embedding geometry caps performance (M0 in the pre-registered matrix).

### `test-embed-configs.mjs` (reworked, same file)
Was: a manual config-comparison script with ad-hoc variants.
Now: the pre-registered M7 variant set (full / no_vision / no_subtitle / text_only /
summary_only / modality_flag), each emitted as a named `.roost/build/<variant>.json`
cache. `honest-eval.py --cache <variant> --by-platform` scores each one; no new scorer.

### `honest_eval_lib.py` (extended, same file)
`auroc()` and `aupr()` are already present (do not re-add). `honest_eval_selftest.py`
has selftest cases for both. All contamination-guard functions are unchanged.

### `honest_eval_selftest.py` (extended, same file)
Unit tests for AUROC, AUPR, and the `--predictions` loader (synthetic separable and
inseparable inputs). Run with `python scripts/honest_eval_selftest.py`; expect all to pass.

### `phase5-threshold-sweep.py` (optional, Slice-1)
Energy / margin rejection variants for M2. The threshold wall is largely the OSCR/AURC
read from `honest-eval.py --rejection maxsim`; this sweep is optional confirmation.

### `finetune-hard-neg.py` (Slice 3, gated)
Reworked for 19 categories + the larger honest fixture. Run only if M0 shows geometry
is the bottleneck (classifier plateau) and cheap levers are exhausted.

### `export-production-centroids.test.ts` (unchanged)
Vitest-driven exporter calling the real `gatherVaultCollections` + `buildCategoryDefs`.
Writes `production-centroids*.json` variants to `.roost/build/`. Stage 1 M5 centroid
loop reads these. Run:
```
ROOST_EXPORT_CENTROIDS=1 npx vitest run \
  packages/core/src/pipeline/__tests__/export-production-centroids.test.ts
```

### TS prediction exporter (new — `export-predictions.test.ts`)
Mirror of `export-production-centroids.test.ts`. Runs embedding top-1 over the full
fixture (centroids held out) and writes `predictions-embedding-top1.json` in the
`{ "<roost_id>": { "pred": "<category|__none__>", "score": <float> } }` shape.
Activated by `ROOST_EXPORT_PREDICTIONS=1`.

---

## Stage 0 — Data characterization

**Purpose:** settle whether the TikTok subtitle is mostly music-noise (→ drop from embed),
and understand per-platform label coverage before any modeling decision.

**Script:** `scripts/data-characterization.py` (operator-run; needs live vault + cache).

```bash
export ROOST_VAULT=<vault>
python scripts/data-characterization.py [--fixture large] [--sync-folder Bookmarks]
```

Output: per-platform report (tiktok / twitter) covering note counts, field-presence
rates, honest-label distribution, fixture sizes, and the best-effort music/noise
subtitle heuristic. The heuristic is diagnostic only — not used for GT or scoring.

**Prerequisites:** vault scanned, sidecar run at least once (embedding cache populated),
`build-honest-fixture.py` run (fixture JSON exists).

---

## Stage 1 — Cheap substrate + baselines

**Orchestrator:** `scripts/run-stage1.sh` (see below).

### Order of operations (one variable at a time)

1. **Smoke test** one item end-to-end before any full run.
2. **M7 input-text ablation** — fix centroid recipe; vary embed-text variants via
   `test-embed-configs.mjs`; score each with `honest-eval.py --cache <variant> --by-platform`.
   Settle best input before touching centroids.
3. **M5 centroid recipe** — fix input at M7 winner; loop `honest-eval.py --centroids <file>`
   over the exported `production-centroids*.json` variants. Settle best centroids.
4. **M0 classifier head** — `classifier-head-diagnostic.py` on the honest fixture with the
   19 categories. Interpret the geometry ceiling.
5. **M1 baseline** — `honest-eval.py --split holdout --rejection maxsim --by-platform`
   with M7 winner + M5 winner. This is the bar all Stage 2/3 methods must beat.
6. **M2 threshold rejection** — same run as M1 (maxsim is the default rejection signal).
   Optional energy/margin variants via `phase5-threshold-sweep.py`.

### Configurable env vars (set at top of `run-stage1.sh`)
| Variable | Default | Description |
|---|---|---|
| `ROOST_VAULT` | (required) | Path to the Obsidian vault |
| `PYTHON` | `python3` | Python interpreter (use venv if available) |
| `SPLIT` | `dev` | Fixture split for tuning runs |
| `HOLDOUT_SPLIT` | `holdout` | Split for final metric report |
| `CENTROID_VARIANTS` | (list) | Space-separated `production-centroids*.json` names |
| `EMBED_VARIANTS` | (list) | Space-separated embed-text variant names |

---

## Predictions format (`predictions.json`)

All TS exporters write, and `honest-eval.py --predictions` reads, this shape:
```json
{
  "<roost_id>": {
    "pred": "<category | __none__>",
    "score": 0.87,
    "ood": 0.12,
    "mis": 0.05
  }
}
```
- `pred` must match a centroid/category key name, or `"__none__"` for Unsorted.
- `score` ∈ [0, 1], higher = more in-set (accept confidence).
- `ood` and `mis` are optional double-score fields for methods that expose both OOD and
  misclassification signals separately.

---

## Running the full Stage 1 sweep

```bash
# 1. Set env and run smoke test
export ROOST_VAULT=<vault>
bash scripts/run-stage1.sh --smoke-test

# 2. Full Stage 1 sweep (after smoke test passes)
bash scripts/run-stage1.sh
```

`run-stage1.sh` is `set -e` — it stops on first failure. Fix the failure and re-run.

---

## Fixtures and outputs (all gitignored — personal vault data)

| Path | Description |
|---|---|
| `<vault>/.roost/build/eval-fixture-large.json` | Full fixture (dev ∪ holdout) |
| `<vault>/.roost/build/eval-fixture-dev.json` | Dev split (tuning) |
| `<vault>/.roost/build/eval-fixture-holdout.json` | Holdout split (final report) |
| `<vault>/.roost/build/production-centroids.json` | Production baseline centroids |
| `<vault>/.roost/build/production-centroids-*.json` | M5 centroid recipe variants |
| `<vault>/.roost/build/<variant>.json` | M7 embed-text variant caches |
| `<vault>/.roost/build/predictions-embedding-top1.json` | M1 TS exporter output |

---

## Contamination guards (must not be disabled)

Three guards fire automatically on every eval run:
1. `assert_gt_not_roost_category` — GT is human `collection` only.
2. `assert_no_fixture_leak` — no fixture item in any centroid or covariance.
3. `assert_disjoint` — dev ∩ holdout = ∅.

If any guard fires, the run aborts with a clear error message. Do not bypass them.

---

## See also

- `scripts/README-honest-eval.md` — the original standing eval (superseded by this program
  for Phase 1, but kept for the historical baseline table).
- `scripts/pre-registration.md` — frozen M0–M7 matrix, metric set, and guard spec.
- `docs/superpowers/specs/2026-06-18-categorization-eval-program-design.md` — full design.
