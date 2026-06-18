#!/usr/bin/env bash
# Stage 1 orchestrator — cheap substrate + baselines sweep.
# Pre-registered order: M7 input-text ablation → M5 centroid recipe → M0 classifier head
#   → M1 embedding top-1 baseline → M2 threshold rejection.
#
# Usage:
#   ROOST_VAULT=<vault> bash scripts/run-stage1.sh [--smoke-test]
#
# Pass --smoke-test to run only the single-item smoke check, then exit.
# All fixture IDs are excluded from centroids; guards fire on any leak.
# 'set -e' stops on first failure — fix it, then re-run.
set -e

# ── Configurable env ────────────────────────────────────────────────────────────
: "${ROOST_VAULT:?ERROR: set ROOST_VAULT to the vault path}"
: "${PYTHON:=python3}"
: "${SPLIT:=dev}"            # tuning split (tune here, report on holdout)
: "${HOLDOUT_SPLIT:=holdout}" # final report split

# Space-separated list of production-centroids*.json variants to loop over (M5).
# These are written by export-production-centroids.test.ts (ROOST_EXPORT_CENTROIDS=1).
: "${CENTROID_VARIANTS:=production-centroids.json production-centroids-noname.json production-centroids-noweight.json production-centroids-noname_noweight.json production-centroids-human_noname_noweight.json}"

# Space-separated list of embed-text variant cache names (M7).
# These are written by test-embed-configs.mjs (--split <split>, reworked variant set).
: "${EMBED_VARIANTS:=full minus-vision minus-subtitle text-only summary-only modality-flag}"

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${ROOST_VAULT}/.roost/build"

log() { echo "[run-stage1] $*"; }
section() { echo; echo "══════════════════════════════════════════════════════════════════════"; echo " $*"; echo "══════════════════════════════════════════════════════════════════════"; }

# ── Smoke-test mode ─────────────────────────────────────────────────────────────
SMOKE_ONLY=0
for arg in "$@"; do [[ "$arg" == "--smoke-test" ]] && SMOKE_ONLY=1; done

section "SMOKE TEST"
log "vault:  ${ROOST_VAULT}"
log "build:  ${BUILD_DIR}"
log "python: $(${PYTHON} --version 2>&1)"

# Verify fixture exists before any heavy run.
if [[ ! -f "${BUILD_DIR}/eval-fixture-large.json" ]]; then
    echo "ERROR: eval-fixture-large.json not found in ${BUILD_DIR}"
    echo "  Run: ROOST_VAULT=${ROOST_VAULT} ${PYTHON} ${SCRIPTS_DIR}/build-honest-fixture.py"
    exit 1
fi
log "fixture: $(python3 -c "import json; d=json.load(open('${BUILD_DIR}/eval-fixture-large.json')); print(len(d['testItems']), 'items')" 2>/dev/null || echo '(count unavailable)')"

# Verify production centroids exist.
if [[ ! -f "${BUILD_DIR}/production-centroids.json" ]]; then
    echo "ERROR: production-centroids.json not found in ${BUILD_DIR}"
    echo "  Run: ROOST_EXPORT_CENTROIDS=1 npx vitest run \\"
    echo "    packages/core/src/pipeline/__tests__/export-production-centroids.test.ts"
    exit 1
fi
log "centroids: $(python3 -c "import json; d=json.load(open('${BUILD_DIR}/production-centroids.json')); print(len(d), 'categories')" 2>/dev/null || echo '(count unavailable)')"

# Smoke test: run selftest (fast — no vault needed).
log "Running honest_eval_selftest.py …"
cd "${SCRIPTS_DIR}"
${PYTHON} honest_eval_selftest.py

# Smoke test: run data-characterization (Stage 0 — requires vault + cache).
log "Running Stage 0 data-characterization (smoke: up to 30s) …"
ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} data-characterization.py 2>&1 | head -60

# Smoke test: one item through honest-eval (dev split, production centroids).
log "Smoke: honest-eval.py --split dev --rejection maxsim (first 10 lines) …"
ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} honest-eval.py \
    --split dev \
    --centroids production-centroids.json \
    --rejection maxsim 2>&1 | head -10

if [[ "${SMOKE_ONLY}" -eq 1 ]]; then
    log "Smoke test complete. Re-run without --smoke-test for the full sweep."
    exit 0
fi

# ── Stage 0 — Data characterization ─────────────────────────────────────────────
section "STAGE 0 — Data characterization"
log "Full report …"
ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} data-characterization.py

# ── M7 — Input-text ablation ─────────────────────────────────────────────────────
section "M7 — Input-text ablation (embed-text variants)"
log "Running test-embed-configs.mjs --split large to emit variant caches …"
log "(requires the embedding sidecar / Ollama running)"
ROOST_VAULT="${ROOST_VAULT}" node "${SCRIPTS_DIR}/test-embed-configs.mjs" --split large

log "Scoring each embed-text variant with honest-eval --by-platform …"
for variant in ${EMBED_VARIANTS}; do
    cache_file="${BUILD_DIR}/${variant}.json"
    if [[ ! -f "${cache_file}" ]]; then
        log "  SKIP ${variant} — cache not found at ${cache_file}"
        continue
    fi
    echo
    echo "── M7 variant: ${variant} (split=${SPLIT}) ──"
    ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} honest-eval.py \
        --split "${SPLIT}" \
        --cache "${variant}.json" \
        --centroids production-centroids.json \
        --rejection maxsim \
        --by-platform
done

# ── M5 — Centroid recipe loop ─────────────────────────────────────────────────────
section "M5 — Centroid recipe variants"
log "Looping over production-centroids*.json variants …"
for centroid_file in ${CENTROID_VARIANTS}; do
    if [[ ! -f "${BUILD_DIR}/${centroid_file}" ]]; then
        log "  SKIP ${centroid_file} — not found in ${BUILD_DIR}"
        continue
    fi
    echo
    echo "── M5 centroid: ${centroid_file} (split=${SPLIT}) ──"
    ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} honest-eval.py \
        --split "${SPLIT}" \
        --cache v2 \
        --centroids "${centroid_file}" \
        --rejection maxsim \
        --by-platform
done

# ── M0 — Classifier head diagnostic ─────────────────────────────────────────────
section "M0 — Classifier head diagnostic (LogReg/kNN on honest fixture)"
log "Running classifier-head-diagnostic.py on --split ${SPLIT} (LOO is O(N^2); dev keeps it tractable) …"
ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} classifier-head-diagnostic.py --split "${SPLIT}"

# ── M1 + M2 — Embedding top-1 baseline + threshold rejection ────────────────────
section "M1 + M2 — Embedding top-1 + maxsim rejection (FINAL REPORT on holdout)"
log "Tuning split=${SPLIT} …"
ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} honest-eval.py \
    --split "${SPLIT}" \
    --cache v2 \
    --centroids production-centroids.json \
    --rejection maxsim \
    --by-platform

echo
log "Final report split=${HOLDOUT_SPLIT} …"
ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} honest-eval.py \
    --split "${HOLDOUT_SPLIT}" \
    --cache v2 \
    --centroids production-centroids.json \
    --rejection maxsim \
    --by-platform

# ── M1 from TS exporter predictions (if available) ──────────────────────────────
PREDS_FILE="${BUILD_DIR}/predictions-embedding-top1.json"
if [[ -f "${PREDS_FILE}" ]]; then
    section "M1 — TS exporter predictions (faithful production scorer)"
    log "Scoring predictions-embedding-top1.json via --predictions flag …"
    ROOST_VAULT="${ROOST_VAULT}" ${PYTHON} honest-eval.py \
        --split "${HOLDOUT_SPLIT}" \
        --predictions "${PREDS_FILE}" \
        --by-platform
else
    log "NOTE: predictions-embedding-top1.json not found — skipping TS exporter scoring."
    log "  Generate it with:"
    log "    ROOST_EXPORT_PREDICTIONS=1 npx vitest run \\"
    log "      packages/core/src/pipeline/__tests__/export-predictions.test.ts"
fi

section "DONE — Stage 1 sweep complete"
log "Review the output above. Settle M7 winner → M5 winner before running Stage 2."
log "Stage 2 (LLM, smoke-tested) and Stage 3 (fine-tune, gated) are separate runs."
