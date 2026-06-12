# Plan 032: Recover recipes the extractor misses — gather by subcategory + caption/transcript extraction fixes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report — do not improvise. When done, update
> the status row in `plans/README.md`.

## Base setup (already done for you)

You are in **/tmp/roost-merge** on branch **`advisor/032-recipe-extraction`**
(off the integrated `deploy-all`, base `94f9c78`). `node_modules` is installed.
Start every shell command with `cd /tmp/roost-merge`. Confirm the target file:
`ls packages/core/src/pipeline/recipe-pipeline.ts`. Do NOT run git
branch/checkout/commit/push.

## Why this matters

A gap analysis of 98 TikTok bookmarks the user filed under `roost_subcategory:
Recipes` that have **no** `recipe_ingredients`/`recipe_steps` found that **all
98 were never processed** (`enrichment_v_recipe` absent). Root causes, in order
of leverage:

1. **Candidate gathering ignores the user's filing.** `gatherCandidates` admits
   a note only if its *embedding-cache* category is in a hardcoded set OR a tag
   matches — it never checks `roost_subcategory: Recipes`. Notes filed as Recipes
   whose embedding landed as "comedy/vlog/etc." are dropped before triage.
2. **Caption recipes lose to the transcript.** Triage classifies off the
   transcript; when a full recipe is in the caption but the transcript is
   unrelated chatter (e.g. `@sawyer_hackett`: gyoza recipe in caption, political
   commentary in transcript), it triages "skip" and the on-disk recipe is lost.
3. **Narrated transcripts aren't extracted.** 8 notes have a transcript that
   *narrates* the recipe conversationally (no bulleted list); extraction returns
   empty, and the runner caches the empty result as "done."

This plan does the three **S-effort, no-new-I/O** fixes: gather by frontmatter
category, route caption-recipes straight to extraction, and make extraction pull
recipes from narrative speech (with a repair retry + empty→retry). Together they
recover ~20 of the 98 immediately and **unblock the larger ASR plan (033)** —
which can't help notes that never enter the pipeline.

## Current state (verbatim excerpts at base)

File: `packages/core/src/pipeline/recipe-pipeline.ts`. Imports already include
`CATEGORY_FIELD, SUBCATEGORY_FIELD` from `@/config` (line 16) — they are
`"roost_category"` / `"roost_subcategory"`.

**Candidate gathering** (lines 124-162) — the admission gate is lines 133-138:

```ts
    const embedded = embeddingCache[roostId];
    const category = (embedded?.category || "").toLowerCase();
    const rawTags = Array.isArray(fm.tags) ? fm.tags : [];
    const tags: string[] = rawTags.map(t => String(t).toLowerCase());

    const categoryMatch = RECIPE_CATEGORIES.has(category);
    const tagMatch = tags.some(t =>
      RECIPE_TAG_KEYWORDS.some(kw => t.includes(kw)),
    );

    if (!categoryMatch && !tagMatch) continue;
```

`RECIPE_CATEGORIES` (line 73) and `RECIPE_TAG_KEYWORDS` (line 79) are module
consts. `RECIPE_ENRICHMENT.categoryMatches` (line 447) =
`["Recipes", "Food", "Food & Drink", "Cooking"]`.

**Triage prompt** (lines 166-181) truncates the caption to 1500 chars:

```ts
function buildTriagePrompt(c: RecipeCandidate): string {
  const text = c.description || c.title;
  return `You are classifying a social media bookmark about food or cooking.

Title: ${text.slice(0, 1500)}
Transcript: ${(c.subtitle || "No transcript available.").slice(0, 1000)}
Visual: ${(c.vision || "No description.").slice(0, 300)}
...
Respond with ONLY one word: recipe, restaurant, or skip`;
}
```

**Extraction** (lines 196-277): `buildExtractPrompt` assembles description +
transcript + vision + tags; `extractRecipe` calls `ollamaGenerate`, parses JSON,
and returns a `RecipeExtraction` — **including when `ingredients` and `steps` are
both empty** (lines 254-273 always return an object; only a JSON parse error
returns `null` at line 275).

**The runner** (`run-category-pipeline.ts:214-245`): `extractItem` returning a
truthy object is treated as **success** and cached (line 224) — so an empty
recipe is cached and never retried. Returning `null` makes it an
`extractError`; with `onExtractFailure: "retry"` (RECIPE_CONFIG line 356) the
entry is **left for next run** (not cached). The runner supports an optional
synchronous `fastPathTriage(c): TVerdict | null` (line 60, 160-175) — a non-null
verdict is cached without an LLM call. The recipe config does **not** set one.

**RECIPE_CONFIG** (lines 346-382) wires `gatherCandidates`, `triageItem`,
`extractItem: extractRecipe`, `extractVerdict: "recipe"`, `skipVerdict: "skip"`,
`onExtractFailure: "retry"`, and a `log` object.

## Commands you will need

| Purpose   | Command                                  | Expected            |
|-----------|------------------------------------------|---------------------|
| Baseline  | `cd /tmp/roost-merge && npm test 2>&1 \| tail -3` | record passing count BEFORE changes |
| Typecheck | `npm run typecheck`                      | exit 0, no output   |
| Tests     | `npm test`                               | ≥ baseline, all pass |
| Filter    | `npm test -- recipe-pipeline`            | recipe tests pass   |

Conventions: `strictNullChecks` + `noImplicitAny`; `@/` alias →
`packages/core/src/`; conventional commits. Don't run `npm run test:e2e`.

## Scope

**In scope:**
- `packages/core/src/pipeline/recipe-pipeline.ts` (the three fixes).
- `packages/core/src/pipeline/__tests__/recipe-pipeline-integration.test.ts`
  (extend) and/or a new `recipe-extraction-recovery.test.ts` (create) — follow
  the existing recipe test's mocking pattern.
- `plans/README.md` — status row.

**Out of scope:** `run-category-pipeline.ts` (the runner already supports
everything via config — do NOT modify it); the ASR/transcript-backfill work
(that is plan 033); the embedding/smart-assign categorizer; any `views/`/`ui/`.

## Steps

### Step 1: Gather candidates the user filed as Recipes

Near `RECIPE_CATEGORIES` (line 73) add a literal set of the user-facing recipe
categories (do **not** derive it from `RECIPE_ENRICHMENT` — that const is
defined later in the file and would be a temporal-dead-zone reference):

```ts
/** roost_category / roost_subcategory values the recipe pipeline owns. A note
 *  the user (or Smart-Assign) filed under one of these enters triage even if
 *  its embedding category/tags don't match. Mirrors RECIPE_ENRICHMENT.categoryMatches. */
const FILED_RECIPE_CATEGORIES = new Set(["recipes", "food", "food & drink", "cooking"]);
```

In `gatherCandidates`, extend the admission gate (lines 133-138):

```ts
    const categoryMatch = RECIPE_CATEGORIES.has(category);
    const tagMatch = tags.some(t => RECIPE_TAG_KEYWORDS.some(kw => t.includes(kw)));
    const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
    const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
    const filedMatch = FILED_RECIPE_CATEGORIES.has(filedCat) || FILED_RECIPE_CATEGORIES.has(filedSub);

    if (!categoryMatch && !tagMatch && !filedMatch) continue;
```

**Verify:** `npm run typecheck` → exit 0.

### Step 2: Route caption-embedded recipes straight to extraction (fast-path) + widen triage

Add a synchronous caption-recipe detector and wire it as the config's
`fastPathTriage`, so a note whose caption/CONTENTS already holds a recipe is
classified "recipe" without an LLM call — immune to an unrelated transcript.

Add near the triage section:

```ts
/** True when the caption / structured description already contains a recipe —
 *  an explicit "ingredients" + "steps/method" pair, or several measurement-bearing
 *  lines. Used as a fast-path so a caption recipe is never lost to an unrelated
 *  transcript at the LLM triage step. */
function hasCaptionRecipe(c: RecipeCandidate): boolean {
  const text = c.description || c.title || "";
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasIngredientsWord = /\bingredients?\b/.test(lower);
  const hasStepsWord = /\b(steps?|method|instructions?|directions?)\b/.test(lower);
  if (hasIngredientsWord && hasStepsWord) return true;
  const measure = /(\d|½|¼|¾|cups?|tbsp|tsp|tablespoons?|teaspoons?|grams?|\bg\b|\bml\b|\boz\b|pounds?|\blb\b|cloves?|pinch)/i;
  const lines = text.split(/\n|\s\|\s/).map(l => l.trim()).filter(Boolean);
  const ingredientLines = lines.filter(l => measure.test(l)).length;
  return ingredientLines >= 4;
}
```

In `RECIPE_CONFIG` (lines 346-382) add:

```ts
  fastPathTriage: (c) => (hasCaptionRecipe(c) ? "recipe" : null),
```

and add a `fastPath` log fragment to the `log` object:

```ts
    fastPath: n => `Caption fast-path: ${n} recipes from the post text`,
```

Also widen the triage caption window so longer caption-recipes survive when the
fast-path doesn't trip — in `buildTriagePrompt`, change `text.slice(0, 1500)` to
`text.slice(0, 4000)`.

**Verify:** `npm run typecheck` → exit 0; the fast-path unit test (Step 4) passes.

### Step 3: Extract from narrative speech + repair retry + treat empty as a retry

Strengthen `buildExtractPrompt` (lines 218-240): after the existing instruction
lines, add guidance to recover an implicitly-narrated recipe:

```
The recipe may be NARRATED conversationally rather than written as a list.
Infer every ingredient mentioned (use qty: null when no amount is spoken) and
every step in the order the actions are described. Do not return empty arrays if
the text describes cooking a dish.
```

Refactor `extractRecipe` (lines 243-277) so an empty result triggers ONE repair
attempt, and a still-empty result returns `null` (so the runner's
`onExtractFailure: "retry"` leaves it for a future run — e.g. once plan 033 adds
a transcript — instead of caching an empty recipe):

```ts
async function runExtract(prompt: string): Promise<RecipeExtraction | null> {
  const raw = await ollamaGenerate(prompt, { numPredict: 2048, numCtx: 4096 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    return { /* …the existing mapping at lines 254-273, unchanged… */ };
  } catch {
    return null;
  }
}

async function extractRecipe(c: RecipeCandidate): Promise<RecipeExtraction | null> {
  let result = await runExtract(buildExtractPrompt(c));
  const isEmpty = (r: RecipeExtraction | null) =>
    !r || (r.ingredients.length === 0 && r.steps.length === 0);
  if (isEmpty(result)) {
    // One forceful repair pass — the first attempt found no list.
    const repair = buildExtractPrompt(c) +
      "\n\nThe previous attempt returned no ingredients or steps. This post DOES " +
      "contain a recipe — re-read the description and transcript carefully and list " +
      "every ingredient and every step in order.";
    result = await runExtract(repair);
  }
  // Empty after repair → null so the runner leaves it for a later run (e.g. once
  // a transcript is backfilled) rather than caching an empty recipe as 'done'.
  return isEmpty(result) ? null : result;
}
```

Keep the existing field-mapping (lines 254-273) verbatim inside `runExtract`
(including `recipeLink: null` — the caller's `afterExtract` still attaches it).

**Verify:** `npm run typecheck` → exit 0; the extraction unit tests (Step 4) pass.

### Step 4: Tests

Follow the mocking pattern in
`packages/core/src/pipeline/__tests__/recipe-pipeline-integration.test.ts` and
`ollama-generate.test.ts` (the `obsidian` stub + an `ollamaGenerate` mock hook;
read both before writing). Add tests (extend the integration test or a new file):

- **gather-by-filing**: a note whose frontmatter has `roost_subcategory: "Recipes"`
  but whose embedding-cache category is e.g. `"comedy"` and tags contain no
  recipe keyword → appears in `gatherCandidates(...)` output. (Mock
  `buildFileIndex`/`metadataCache`/`loadEmbeddingCache`.)
- **caption fast-path**: `hasCaptionRecipe` returns true for a description with
  "Ingredients: …\nSteps: …" and for one with ≥4 measurement lines; false for a
  bare hook caption like `"Not 'Marry Me' chicken??? 😰"`.
- **narrative + repair + empty→null**: mock `ollamaGenerate` to return
  empty-recipe JSON twice → `extractRecipe` returns `null`; return a valid recipe
  on the first call → returns it; return empty then valid → returns the valid
  (repair worked).

**Verify:** `npm test -- recipe-pipeline` and `npm test` → all pass.

## Done criteria

- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0, ≥ the baseline you recorded; new tests for the three
      behaviors exist and pass.
- [ ] `grep -n "FILED_RECIPE_CATEGORIES\|filedMatch" packages/core/src/pipeline/recipe-pipeline.ts` → present.
- [ ] `grep -n "fastPathTriage\|hasCaptionRecipe" packages/core/src/pipeline/recipe-pipeline.ts` → present.
- [ ] `grep -n "runExtract\|repair" packages/core/src/pipeline/recipe-pipeline.ts` → present.
- [ ] `run-category-pipeline.ts` is unchanged (`git diff --stat origin/main -- packages/core/src/pipeline/run-category-pipeline.ts` empty).
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- `recipe-pipeline.ts` doesn't match the excerpts (drift) — STOP.
- Making `extractRecipe` return `null` on empty breaks an existing recipe
  characterization test that asserts an empty-recipe write — STOP and report
  (that test encodes the old behavior; the maintainer must decide).
- A fix would require editing `run-category-pipeline.ts` — it shouldn't; the
  config hooks cover it. STOP rather than modify the shared runner.

## Maintenance notes

- After this lands, re-running "Run Recipe extraction pipeline" gathers the 98
  (+ future Recipes notes), fast-paths caption recipes, and extracts narrated
  ones. It will **not** recover the ~29 recipe-in-video notes with no transcript
  — those need **plan 033 (ASR transcript backfill)**, which this plan unblocks
  (they now enter the pipeline and sit as triage-recipe/extraction-null until a
  transcript exists).
- **Miscategorization (deferred):** ~48 of the 98 are genuinely not recipes
  (reactions, restaurant recs, vlogs). After Step 1 they will be gathered and
  triaged "skip"/"restaurant" — correctly producing nothing. A follow-up could
  record that verdict (e.g. a `recipe_status: none` marker) so the UI can re-file
  them out of Recipes; that's a product decision about auto-recategorizing the
  user's notes and is intentionally out of scope here.
- Reviewer focus: the fast-path heuristic's false-positive rate (a non-recipe
  caption with 4 measurement-ish lines would be force-extracted — acceptable, it
  just yields an empty→null and a retry), and that `extractRecipe`'s null-on-empty
  doesn't cause perpetual re-extraction churn (it only re-runs when the pipeline
  is manually re-run).
