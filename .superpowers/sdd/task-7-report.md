# Task 7 acceptance-gate report

## Status
Script written and syntax-checked. Cannot do a full end-to-end run because the trained head JSONs do not yet exist (training is an operational step).

---

## Forward-pass trace vs TS contract

### Single-head baseline

**TS contract (classifyWithHead):**
```
x_norm = l2norm(vecVision)
z[c]   = dot(W[c], x_norm) + b[c]
pred   = classes[argmax(softmax(z))]
```

**Script implementation (`forward_single`, line ~108):**
```python
x = l2norm(vec.astype(np.float64))   # vec = vec_vision (vision-on embedding)
z = W @ x + b
return classes[int(np.argmax(softmax(z)))]
```
- Input: `vec_vision` = `embed(cover_text(iid, cover_cache, cap))` = cover description + caption.
- L2-normalised before the dot product. Matches TS exactly.

---

### Stacked-heads forward pass

**TS contract (classifyStacked):**
```typescript
const pText   = softmax(matmul(W_text,   l2norm(vecText))   + b_text)
const pVision = softmax(matmul(W_vision, l2norm(vecVision)) + b_vision)
const feat    = [...pText, ...pVision]          // text FIRST, length 2C
const zMeta   = matmul(W_meta, feat) + b_meta
pred          = classes_meta[argmax(softmax(zMeta))]
```

**Script implementation (`forward_stacked`, line ~129):**
```python
p_text   = softmax(W_t @ l2norm(vec_text.astype(np.float64))   + b_t)
p_vision = softmax(W_v @ l2norm(vec_vision.astype(np.float64)) + b_v)
feat     = np.concatenate([p_text, p_vision])   # text FIRST — length 2C
z_meta   = W_m @ feat + b_m
return classes_meta[int(np.argmax(softmax(z_meta)))]
```

**Feature-order invariant confirmed:**
- `feat` = `[p_text(C), p_vision(C)]`, indices [0,C) = text, [C,2C) = vision.
- Matches `train-stacked-heads.py` export: `feat_meta = np.hstack([P_text_oof, P_vision_oof])`.
- Matches TS: `feat = [...pText, ...pVision]`.
- Swapping the two blocks would corrupt every prediction silently; the index ordering here is the canonical source of truth in Python-land.

**Embeddings:**
- `vec_text`   = `embed(cap)` — caption only (text-only, no cover). Mirrors `exp-stacking-cascade.py`'s `Xe` path.
- `vec_vision` = `embed(cover_text(iid, cover_cache, cap))` — cover description prepended to caption. Mirrors `Xc` path.
- Both use the same surrogate-safe guard: `.encode("utf-8","ignore").decode("utf-8")[:10000]`.

---

## Gate criteria as implemented

1. **Overall non-regression per platform:** stacked top-1 >= single-head top-1 on BOTH TikTok and Twitter. A single-platform fail is a GATE FAIL.
2. **Per-category regression cap (default 5pp):** no category on either platform may regress by more than `--cat-regression-margin` (default 0.05). Any regression beyond the margin is a GATE FAIL.
3. **Exit codes:** 0 = PASS, 2 = FAIL, 1 = pre-flight error (missing files, class mismatch).

---

## Missing-file behaviour

Before loading any head JSON, the script calls `check_heads()` which iterates over all four required names:
```
classifier-head.json
classifier-head-text.json
classifier-head-vision.json
meta-head.json
```
If any are missing it prints:
```
ERROR: Required head JSON files are missing:
  MISSING  <vault>/.roost/cache/classifier-head-text.json
  ...

Run   scripts/train-stacked-heads.py --split all   first, then re-run this gate.
```
Then exits with code 1. No attempt is made to fabricate or substitute head files.

A secondary check validates that all four heads expose the same sorted class list and that meta-head `inDim == 2 * C`. Mismatches print a clear actionable error and exit 1.

---

## Syntax check

```
py_compile: OK
```
(`/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks/.roost/venv/bin/python3 -m py_compile scripts/acceptance-gate-stacking.py`)

---

## Sample selection

Reuses `exp-tiktok-gating.sample()` and `exp-twitter-gating.sample()` verbatim (loaded via `importlib`). These functions apply:
- Honest-label loading (human `collection`, not `roost_category`)
- seed `1729` shuffle
- Category-floor filter (min 6 items per category to avoid degenerate classes)
- Default cap of 900 items per platform (matches the powered design that clears p<0.05)

The gate does NOT use the gating scripts' internal embed/CV logic — it builds both embeddings on-the-fly and applies the trained head JSONs directly, matching the production inference path.

---

## Concerns / caveats

- The gate score is a point estimate on a 900-item sample. It has no confidence interval; a very small delta (< ~1pp) should be treated as noise rather than a firm pass.
- The per-category regression check uses all items where that category appears; categories with few samples (below `--min-cat-n`) are excluded from the table and from the regression gate. Defaulting to 6 matches the gating scripts.
- Cover caches (`exp-keyframe-cover.json`, `exp-twitter-cover.json`) must be populated by the describe phase before running the gate; absent caches fall back silently to caption-only embeddings for both `vec_vision` and `vec_text` (they remain distinct because `vec_vision` would then equal `vec_text`, which would collapse the stacking benefit but would not crash).

---

## Final-review fix pass

Three bugs identified in the whole-branch review were fixed in this pass.

### Fix 1 — data-stability: don't overwrite a stable `entry.vec` on backfill (`describe-items.ts`)

**Problem:** The Stage 2 guard `!entry.vec || entry.vecText == null` caused both embeddings to be recomputed (and `entry.vec` overwritten) whenever `vecText` was null, even if `entry.vec` was already a stable, good vector.

**Changes:**
- `packages/core/src/pipeline/describe-items.ts` Stage 2 restructured into two explicit branches:
  - **Backfill path** (`entry.vec` present, `entry.vecText == null`): calls `embedder.embed([plainText])` (single string), sets `entry.vecText` only. `entry.vec` is never touched. Fallback: if `plainText.length <= 10`, `entry.vecText = [...entry.vec]` (copy of the existing vector).
  - **Full-compute path** (`!entry.vec`): unchanged batched `embedder.embed([visionText, plainText])` call; sets both `entry.vec` and `entry.vecText`.
- Fast-scan gate updated from `cache[id]?.vec` to `cache[id]?.vec && cache[id]?.vecText != null` so items with a stable `vec` but missing `vecText` are queued for backfill rather than skipped as `alreadyDone`.

**New test added:** `"preserves existing entry.vec when backfilling vecText (vec must not be overwritten)"` in `packages/core/src/pipeline/__tests__/describe-items-dualembed.test.ts`. Seeds a cache entry with a 0.42 sentinel vector and `vecText: null`; asserts after `describeItems`: (a) `entry.vecText` is now set, (b) `entry.vec` is still the 0.42 sentinel (unchanged), (c) only one embed call was made with one string (not two).

---

### Fix 2 — double-warn on invalid classifier-head file (`classifier-head.ts`)

**Problem:** A structurally-invalid `classifier-head.json` logged TWO warnings: one from inside `loadHeadFile` (the structural-validation branch) and one from `loadClassifierHead` (the user-facing message). The parse-error `catch` warn in `loadHeadFile` was correct and was kept.

**Change:** Removed the `console.warn(\`[roost] ${headPath} failed structural validation\`)` line from inside `loadHeadFile` (structural-validation branch only). The `catch (e)` warn for JSON parse errors remains. The richer, user-facing message in `loadClassifierHead` is now the sole warning for structural failures.

**Tests:** `classifier-head.test.ts` (39 tests) and `classifier-head-stacked.test.ts` stayed green.

---

### Fix 3 — acceptance gate must abort on empty cover caches (`acceptance-gate-stacking.py`)

**Problem:** When `exp-keyframe-cover.json` / `exp-twitter-cover.json` were absent or empty, the gate printed only a WARNING and continued. With empty cover caches the vision vector collapses to the text vector (cover descriptions are what distinguish `vec` from `vecText`), so a GATE: PASS in this state is meaningless.

**Change:** `platforms_to_run` list is now computed before the cover-cache load (moved ~8 lines earlier). After loading, if any platform being evaluated has an empty/absent cover cache, the gate prints a clear `ERROR:` message per platform and calls `sys.exit(1)`. It does NOT fall through to the evaluation loop. The existing `check_heads()` exit-1 behavior is unchanged.

---

### Test / compile output

```
# Dual-embed test file
npx vitest run packages/core/src/pipeline/__tests__/describe-items-dualembed.test.ts
Test Files  1 passed (1)  |  Tests  4 passed (4)

# Classifier-head test files
npx vitest run packages/core/src/pipeline/__tests__/classifier-head.test.ts \
              packages/core/src/pipeline/__tests__/classifier-head-stacked.test.ts
Test Files  2 passed (2)  |  Tests  39 passed (39)

# Full suite
npm test
Test Files  171 passed | 1 skipped (172)  |  Tests  1636 passed | 8 skipped (1644)

# Python compile
python3 -m py_compile scripts/acceptance-gate-stacking.py
py_compile: OK
```
