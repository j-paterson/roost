# Pre-Registration — Categorization Eval Program Phase 1

> Frozen before any Stage 1 runs. Do not add variants post-hoc.
> Approved: 2026-06-18. Seed: 1729.

## Fixture

| | |
|---|---|
| File | `eval-fixture-large.json` (dev ∪ holdout) |
| Split | `dev` for tuning; `holdout` for final report |
| Seed | **1729** (fixed, recorded in fixture JSON) |
| GT source | Human `collection` field only — **never** `roost_category` |
| Holdout fraction | ~30% per category (stratified); dev/holdout disjoint (asserted) |
| Negatives | Items with `roost_id` but no `collection`; capped at 100, seeded |

All fixture IDs (`large` = dev ∪ holdout) are excluded from every centroid and
covariance computation. `assert_no_fixture_leak` fires if any leak is detected.

## Metric set (report all, never OSCR alone)

### Closed-set (sanity anchor)
- **ACCURACY** — top-1 over knowns, no rejection threshold.

### Rejection (headline — report as a group)
- **OSCR** — area under CCR-vs-FPR (Dhamija et al. NeurIPS 2018). Higher is better.
- **AUROC** — area under ROC, in-distribution vs OOD by score. Higher is better.
- **AUPR** — area under Precision-Recall, in-distribution as positive. Higher is better.
- **AURC** — area under risk-coverage (Franc et al. 2307.05199). Lower is better.

Reported together via `honest-eval.py`. OSCR alone is misleading (TPR-independent,
per adversarial literature review 2026-06-18).

### Matched-coverage comparison
Rejection methods are compared on the risk-coverage curve or at a fixed coverage
point. A method must not be credited for operating at a different threshold than its
comparator.

### Double-score view
When a method exposes two signals (e.g. LLM NONE-flag + cosine score), report both:
one for OOD-vs-ID discrimination and one for misclassification detection.

### Secondary
Deployment operating-point view (λ/r) from `honest-eval.py` — tune on dev, report
on holdout. λ and r are deployment choices, not eval parameters.

## Method matrix (M0–M7, pre-registered)

### Stage 0 — Data characterization (free, run first)
**Script:** `scripts/data-characterization.py`

Output: console report + optional `data-characterization.md`.
Settles whether the TikTok subtitle is mostly music-noise (→ drop it from embed).

---

### Stage 1 — Cheap substrate + baselines (no LLM, no training)

#### M7 — Input-text ablation (run first; one variable at a time)
**Script (reworked):** `scripts/test-embed-configs.mjs`

Hold centroid recipe fixed. Re-embed the fixture under these variants, in this order:

| Variant key | Description |
|---|---|
| `full` | Production baseline: `vision + summary + category + title + subtitle` |
| `no_vision` | Drop `vision` field |
| `no_subtitle` | Drop `subtitle` / transcript |
| `text_only` | `title` only (no LLM fields) |
| `summary_only` | `summary` only |
| `modality_flag` | Full text but mark "transcript absent or noise" instead of feeding raw subtitle |

Each variant is emitted as a named cache in `.roost/build/<variant>.json` and scored
via `honest-eval.py --cache <variant> --by-platform`.

Winner = best variant on **dev** ACCURACY + OSCR (primary). Held for M5 and M1/M2.

#### M5 — Centroid recipe (hold M7 winner fixed)
**Driver:** `run-stage1.sh` loop over `honest-eval.py --centroids <variant>`

Variants (already exported by `export-production-centroids.test.ts`):

| File | Description |
|---|---|
| `production-centroids.json` | Production baseline (name-blend + HUMAN_WEIGHT, all members) |
| `production-centroids-noname.json` | Isolate name-blend: remove it |
| `production-centroids-noweight.json` | Isolate HUMAN_WEIGHT: remove it |
| `production-centroids-noname_noweight.json` | Pure mean, all members |
| `production-centroids-human_noname_noweight.json` | Pure mean, human-only members |

Plus `--centroids mean` (in-Python plain mean, honest labels only — may be degenerate;
the script exits with a clear message if so).

#### M0 — Classifier head diagnostic
**Script (reworked):** `scripts/classifier-head-diagnostic.py`

LogReg / kNN on the v2 embeddings with **19-category honest fixture** as test set
(strict-holdout + LOO). Interprets whether embedding geometry is the bottleneck.
- If classifier ≥ baseline → geometry is fine; cheap levers suffice.
- If classifier plateaus → M6 (fine-tune) justified.

#### M1 — Embedding top-1 (the bar)
**Driver:** `honest-eval.py --split holdout --rejection maxsim --by-platform`

Using M7's winning input and M5's winning centroids.

#### M2 — Threshold rejection
**Driver:** `honest-eval.py --split holdout --rejection maxsim`

maxsim is the baseline rejection signal. The ~0.43 F1 wall from the historical sweep
may shift on the larger fixture; OSCR+AURC read is what matters.
`phase5-threshold-sweep.py` (Slice-1 optional) can sweep energy/margin variants.

---

### Stage 2 — LLM tests (Slice 2, gated — not pre-registered here)
M3 (LLM top-1) and M4 (LLM-librarian NONE rejection). Run after Stage 1 settles.
Smoke-test one item before any full ~4,320-call run. Use score cache.

### Stage 3 — Fine-tune (Slice 3, gated — not pre-registered here)
M6 (`finetune-hard-neg.py`) gated on M0 geometry plateau.

---

## Guards (enforced, must not be disabled)

1. **GT guard:** `assert_gt_not_roost_category("collection")` fires in every label loader.
   GT is the human `collection` field only.

2. **Fixture-leak guard:** `assert_no_fixture_leak(member_ids, fixture_ids)` fires before
   any centroid is used. All of `eval-fixture-large.json` (dev ∪ holdout) must be absent
   from centroid members and covariance inputs.

3. **Disjoint guard:** `assert_disjoint(dev_ids, holdout_ids)` fires at fixture load time.

4. **Matched-coverage comparison:** rejection methods are never credited for a more
   permissive threshold. Compare at matched coverage or on the full curve.

5. **No post-hoc variant expansion:** the M0–M7 matrix above is frozen. Adding a new
   variant after seeing results requires a written amendment to this file with a
   justification. Multiple-comparisons discipline: 4,320 items is large but not infinite.

6. **Faithfulness:** `scoreAgainstCategories` / `buildCategoryDefs` are never reimplemented
   in Python. The TS exporter calls the real production functions; Python only scores
   predictions that the TS exporter writes.
