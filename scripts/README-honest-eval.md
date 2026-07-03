# Honest Smart Assign eval (contamination-safe)

The standing, offline measurement for Smart Assign categorization. Supersedes the
ad-hoc `cost-opt-eval*`, `ensemble-eval`, and `phase5-threshold-sweep` scripts for
the honest metric (those are kept for history). Dev-tool only — nothing here ships
in the plugin and it touches no training or production code.

## Invariants (enforced in code, not by convention)
- **Ground truth = human `collection`** (non-`auto`), **never** `roost_category`.
  Grading against the system's own output is the contamination that produced the
  historical false results. `assert_gt_not_roost_category` is a tripwire in the
  label loader and the entry point.
- **All fixture items (dev ∪ holdout = `large`) are excluded** from centroids
  *and* from any covariance — at build time, by the exporter. `assert_no_fixture_leak`.
- **dev/holdout are disjoint**; fixed seed (`1729`); raw accuracy (no corrections).

## Primary metrics (threshold-free — no λ/r to tune)
- **OSCR** — area under CCR-vs-FPR (open-set classification rate; higher better).
  Dhamija et al., NeurIPS 2018.
- **AURC** — area under risk-coverage (selective classification; lower better).
- **ACCURACY** — plain top-1 over knowns, no rejection. Sanity anchor.
- The deployment **operating-point** view (λ = mis-filing cost, r = out-of-set base
  rate) is **secondary** — tune on dev, report on holdout. λ/r are deployment
  choices, not eval parameters.

## Components
- `honest_eval_lib.py` — loaders, centroid math, metrics, contamination guards.
- `honest_eval_selftest.py` — assertion-based unit tests (12).
- `build-honest-fixture.py` — vault → `.roost/build/eval-fixture-{large,dev,holdout}.json`.
- `export-production-centroids.test.ts` (in `packages/core/src/pipeline/__tests__/`) —
  vitest-driven exporter calling the **real** production `gatherVaultCollections` +
  `buildCategoryDefs`, so centroids match production exactly, with the fixture held out.
- `honest-eval.py` — entry point; runs guards, prints the metrics above.

## Run
```bash
PY="<vault>/.roost/venv/bin/python3"; export ROOST_VAULT="<vault>"
cd scripts
$PY build-honest-fixture.py        # build fixtures (vault-local, gitignored)
# regenerate production-faithful centroids (fixture strictly held out):
ROOST_EXPORT_CENTROIDS=1 npx vitest run \
  packages/core/src/pipeline/__tests__/export-production-centroids.test.ts
$PY honest-eval.py --split dev     --rejection maxsim   # tune
$PY honest-eval.py --split holdout --rejection maxsim   # report (transfer)
$PY honest_eval_selftest.py        # unit tests (expect 12/12)
```

Fixtures and centroids live in `<vault>/.roost/build/` (gitignored — personal data).

## Flags
- `--split {dev,holdout,large}` — `large` is `dev ∪ holdout`.
- `--centroids production-centroids.json` (default, canonical) or `mean`.
  **`mean` is degenerate with the current fixture**: the fixture covers 100% of
  honest labels, so an in-Python mean built from honest labels alone is empty after
  the holdout. Use it only with a future partial-coverage fixture; the entry point
  exits with a clear message otherwise.
- `--rejection {maxsim,none}` — `none` forces all scores to 1.0 (no rejection
  signal), so OSCR/AURC are omitted and only ACCURACY + accept-all are reported.
- `--cache {v2,<name>}` — `v2` reads the vault `.bin`; otherwise an inline JSON cache
  in `.roost/build/` (e.g. a fine-tuned cache for ablations).
- `--op-lambda` (default 0.5), `--op-r` (default 0.30) — deployment operating-point params.

## Current honest baseline (production centroids, v2 embeddings)
| split   | n (known/unknown) | ACCURACY | OSCR   | AURC   |
|---------|-------------------|----------|--------|--------|
| dev     | 869 / 70          | 0.5478   | 0.3127 | 0.3524 |
| holdout | 375 / 30          | 0.5467   | 0.2888 | 0.3574 |

Stable across splits (no overfit). Under λ=0.5, the deploy-view best (~0.32) barely
beats reject-all (0.30) while accept-all is ~0.075 — i.e. with mis-filing cost the
status quo is near-net-neutral, which is the honest result the contaminated numbers
had hidden.

## Fresh rejection eval (2026-07-03)
`scripts/exp-rejection-fresh.py` (+ `rej_provenance.py`, `rej_signals.py`,
`rej_negatives.py`) measures the CURRENT production rejection cascade held-out
(train split → eval split), with a provenance preflight (every input stamped;
embeddings asserted fresh at cos ≥ 0.90 (model-identity; base-nomic re-embeds ~0.67, current v2 ≥ 0.90 — see rej_provenance.py)) and three negative layers
(leave-one-category-out, untouched unlabeled vault pool (no collection AND no roost_category; diagnostic-only, never OSCR/AUROC), optional assisted gold set via
`build-belongs-nothing-candidates.py` → `belongs-nothing-gold.json`). Metrics:
OSCR / AURC / per-category LOO OOD AUROC / operating-point. Self-test: `rej_selftest.py`.
Report: `docs/superpowers/specs/2026-07-03-fresh-rejection-eval-results.md`.
Note: centroids come from the TRAIN split (`build_centroids`), NOT the production
exporter — the fixture covers 100% of honest labels, so a full-fixture-held-out
centroid is empty.
