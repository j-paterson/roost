# Plan 053: Make the 5 embedded-only pipelines also gather items by the category you filed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report. When done, update this plan's
> status row in `plans/README.md` unless a reviewer told you they maintain it.
>
> **Drift check (run first)**:
> `git diff --stat ae7335a..HEAD -- packages/core/src/pipeline/places-pipeline.ts packages/core/src/pipeline/products-pipeline.ts packages/core/src/pipeline/workouts-pipeline.ts packages/core/src/pipeline/tutorials-pipeline.ts packages/core/src/pipeline/home-pipeline.ts packages/core/src/pipeline/recipe-pipeline.ts`
> Compare the "Current state" excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes which items each pipeline processes → can increase LLM work)
- **Depends on**: `plans/052-pending-pipeline-tracking.md` — 052 factors each pipeline's matcher
  into `gather<Name>CandidateIds`; this plan adds a filed-category branch to that same matcher.
  Land 052 first. (If 052 is not yet landed, this plan can still edit `gatherCandidates` directly,
  but then it WILL collide with 052 — sequence them.)
- **Category**: direction (feature)
- **Planned at**: commit `ae7335a`, 2026-06-15

## Why this matters

The pipelines discover candidates by the LLM's one-word `embedded.category` guess, then *write* the
canonical `roost_category` (e.g. "Places"). So the normal flow is: Smart Assign embeds → pipeline
discovers by `embedded.category` → pipeline files it as "Places". But if you **manually file** an
item into a pipeline's category (via Smart Assign confirm or by editing `roost_category`), 5 of the
7 pipelines will NOT pick it up — only **recipe** does, because plan 032 gave it a
`FILED_RECIPE_CATEGORIES` branch. That means "I assigned this to Workouts, the workout pipeline
should enrich it" silently does nothing for places/products/workouts/tutorials/home. This plan
extends recipe's proven filed-category pattern to those five, so the category you assign actually
drives enrichment — and (paired with 052) makes the pending badge reflect user intent.

## Current state

**Recipe is the template** (`recipe-pipeline.ts`):
```ts
// recipe-pipeline.ts:84-94
const RECIPE_FILED_CATEGORIES = ["Recipes", "Food", "Food & Drink", "Cooking"] as const;
export const FILED_RECIPE_CATEGORIES = new Set(RECIPE_FILED_CATEGORIES.map(c => c.toLowerCase()));
// ...in gatherCandidates (recipe-pipeline.ts:150-154):
const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
const filedMatch = FILED_RECIPE_CATEGORIES.has(filedCat) || FILED_RECIPE_CATEGORIES.has(filedSub);
if (!categoryMatch && !tagMatch && !filedMatch) continue;
```
`CATEGORY_FIELD` / `SUBCATEGORY_FIELD` are imported from `@/config` (they are `roost_category` /
`roost_subcategory`). `RECIPE_FILED_CATEGORIES` is reused as recipe's `EnrichmentDef.categoryMatches`.

**The five pipelines lacking the branch** — each gathers by `*_CATEGORIES.has(category)` (embedded)
OR `*_TAG_KEYWORDS` only, then `if (!categoryMatch && !tagMatch) continue;`. Their
`EnrichmentDef.categoryMatches` (the user-facing `roost_category` values) already exist:

| Pipeline file | embedded match | `categoryMatches` |
|---|---|---|
| `places-pipeline.ts` (gather ~282-299) | `PLACE_CATEGORY_SUBSTRINGS` substring | `["Places", "Travel"]` (line 734) |
| `products-pipeline.ts` (gather ~155-175) | `PRODUCT_CATEGORIES` Set | `["Product", "Products", "Gear", "Shopping"]` (472) |
| `workouts-pipeline.ts` (gather ~146-166) | `WORKOUT_CATEGORIES` Set | `["Fitness", "Workouts", "Workout", "Exercise"]` (469) |
| `tutorials-pipeline.ts` (gather ~158-178) | `TUTORIAL_CATEGORIES` Set | `["Tutorials", "Tutorial", "How-To", "Skills"]` (482) |
| `home-pipeline.ts` (gather ~185-205) | `HOME_CATEGORIES` Set | `["Home", "Interiors", "Home & Interiors", "Decor"]` (501) |

Each already imports `CATEGORY_FIELD, SUBCATEGORY_FIELD` from `@/config` (used in its write path,
e.g. `places-pipeline.ts:497`). So no new imports are needed.

**Convention:** match recipe exactly — a `FILED_<NAME>_CATEGORIES` Set derived from the def's
`categoryMatches`, and an exact-match (Set membership) filed test on `roost_category` /
`roost_subcategory`. Note: even though `places` matches `embedded.category` by *substring*, the
filed test must be **exact** Set membership against `categoryMatches` (the user files a known
taxonomy label, not free text) — same as recipe.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass |
| Build | `npm run build` | dist artifacts |

## Scope

**In scope** (modify):
- `packages/core/src/pipeline/places-pipeline.ts`
- `packages/core/src/pipeline/products-pipeline.ts`
- `packages/core/src/pipeline/workouts-pipeline.ts`
- `packages/core/src/pipeline/tutorials-pipeline.ts`
- `packages/core/src/pipeline/home-pipeline.ts`
- Their colocated `__tests__/` files (extend)

**Out of scope**:
- `recipe-pipeline.ts` (already has the branch) — do not touch except to read as the template.
- `media-pipeline.ts` — it already has an explicit `roost_category` filter mode; leave it.
- Changing the embedded-category or tag predicates; the write path; or any extraction logic.
- The pending-scan / badge / auto-enqueue wiring — that is plan 052.

## Git workflow

- Branch: `advisor/053-pipeline-gather-by-filed-category`
- Conventional commits, e.g. `feat(pipeline): gather by filed roost_category in 5 pipelines`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1 (per pipeline, ×5): add a `FILED_<NAME>_CATEGORIES` set + a `filedMatch` branch

For each of the five files, near the existing `*_CATEGORIES` definition add (places shown):
```ts
/** roost_category / roost_subcategory values this pipeline owns — so a note the
 *  user filed into one of these is gathered even if its embedded category/tags
 *  don't match. Mirrors recipe's FILED_RECIPE_CATEGORIES (plan 032). */
const FILED_PLACE_CATEGORIES = new Set(PLACE_ENRICHMENT.categoryMatches.map(c => c.toLowerCase()));
```
If referencing the `*_ENRICHMENT` const causes an ordering / circular issue (the def may be declared
below the gather fn), instead inline the same string list the def uses, e.g.
`const FILED_PLACE_CATEGORIES = new Set(["places", "travel"]);` — keep it a single source of truth
with `categoryMatches` (add a one-line comment that the two lists must stay in sync, matching how
recipe ties `RECIPE_FILED_CATEGORIES` to its `categoryMatches`). Then in the matcher add:
```ts
const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
const filedMatch = FILED_PLACE_CATEGORIES.has(filedCat) || FILED_PLACE_CATEGORIES.has(filedSub);
if (!categoryMatch && !tagMatch && !filedMatch) continue;   // was: !categoryMatch && !tagMatch
```
**If 052 has landed**, the matcher lives in `gather<Name>CandidateIds` (and `gatherCandidates`
consumes it) — add the `filedMatch` there, in the one place. **If 052 has not landed**, add it
directly in `gatherCandidates`; note this WILL conflict with 052 and the two must be sequenced.

**Verify** after each: `npm run typecheck` → exit 0.

### Step 2: confirm the five `categoryMatches` lists are the intended user labels

Read each def's `categoryMatches` (table above) and confirm the filed set lowercases them. These are
the labels Smart Assign / the user write into `roost_category`. Do not invent new labels.

**Verify**: `npm run typecheck` → exit 0; `npm test` → existing pipeline tests pass.

### Step 3: tests

**Verify**: `npm test` → all pass incl. new tests; `npm run build` → succeeds.

## Test plan

For each of the five pipelines, extend its colocated `__tests__` (model after the recipe test that
exercises the filed branch — search recipe's tests for `FILED_RECIPE_CATEGORIES` / a frontmatter
`roost_category` case):
- An item whose `embedded.category` does NOT match but whose `roost_category` ∈ `categoryMatches`
  → IS gathered (the new behavior).
- An item whose `roost_subcategory` ∈ `categoryMatches` → IS gathered.
- An item matching neither embedded, tags, nor filed → NOT gathered (unchanged).
If 052 landed, add the same cases to `gather-candidate-ids.test.ts` for these five.

Verification: `npm test` → all pass; `npm run typecheck` → exit 0.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; each of the 5 pipelines has a new "gathered by filed category" test
- [ ] `grep -n "filedMatch" packages/core/src/pipeline/{places,products,workouts,tutorials,home}-pipeline.ts` shows the branch in all five
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- A pipeline's `categoryMatches` is empty or absent (it would not be in `PIPELINE_ENRICHMENTS`) — report.
- Adding the filed branch causes a circular-import / use-before-declaration error you can't resolve
  by inlining the string list — report which pipeline.
- The filed branch makes a pipeline gather a surprisingly large number of items in tests (e.g. a
  too-broad `categoryMatches` label like a bare "Home" colliding with unrelated notes) — report
  before proceeding so the label set can be tightened.

## Maintenance notes

- Each `FILED_<NAME>_CATEGORIES` set must stay in sync with the def's `categoryMatches`. A reviewer
  should check the two lists match (recipe has the same coupling).
- This increases each pipeline's candidate set, so the first run after this lands may process more
  items (more LLM calls). That is the intended behavior (it enriches what the user filed); paired
  with 052's badge the user sees the new pending count and with 054 can cancel a long run.
- If a future change makes `roost_category` free-text rather than a controlled taxonomy, the exact
  Set-membership filed test would need a normalization pass.
