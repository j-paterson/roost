# Plan 038: Consolidate the enrichment system — break the import cycle, collapse the dup chip systems, unify the media version namespace

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This plan has **three independent parts (A / B / C)**, each with its
> own Verify block. If a STOP condition fires in one part, stop **that part** and
> report — the other two are unaffected and may still land. When done, update the
> status row in `plans/README.md`.

## Base setup (do this FIRST — not optional)

You are in **/tmp/roost-merge**. Branch off the integrated **`deploy-all`** line
(it carries plans 031–037: the `tweetBody` renderer + auto-run, the pipeline
action rows + canonical media deep-links, the alias-aware chip gate from 034).
`node_modules` is already installed.

```bash
cd /tmp/roost-merge
git rev-parse --short deploy-all          # expect 1515956 (037 just landed)
git checkout -b advisor/038-consolidate-enrichment-system deploy-all
git rev-parse --short HEAD                # confirm you branched off 1515956
```

Start every shell command with `cd /tmp/roost-merge`. Do **NOT** run git
branch/checkout/commit/push beyond the branch creation above (the operator
merges).

**Drift check**: if HEAD is past `1515956`, diff the files this plan touches and
compare the "Current state" excerpts below against the live code before editing;
on a material mismatch in a part, STOP that part and report.

```bash
git diff --stat 1515956..HEAD -- \
  packages/core/src/sync/article-backfill.ts \
  packages/core/src/sync/media-backfill.ts \
  packages/core/src/sync/thread-backfill.ts \
  packages/core/src/sync/tweet-body-backfill.ts \
  packages/core/src/views/gallery-cards.ts \
  packages/core/src/views/pipeline-details.ts \
  packages/core/src/pipeline/media-pipeline.ts \
  packages/core/src/sync/vault-writer/vault-index.ts
```

## Status

- **Priority**: P2 (one live dead-bug in C; A is a latent crash; B is debt)
- **Effort**: A=S, B=S, C=M (the two halves of C MUST ship together)
- **Risk**: A=LOW (mechanical), B=LOW (deletes a dup with zero CSS), C=MED
  (touches the media write field — gated by a characterization-test update)
- **Depends on**: 034 (the alias-aware chip gate must already exist on
  `deploy-all` — it does, `gallery-cards.ts:218-227`)
- **Category**: A=correctness/robustness, B=tech-debt, C=correctness (live bug)
- **Planned at**: commit `1515956` (`deploy-all`, post-037), 2026-06-12

## Why this matters

Three independent consolidations in the enrichment system, each a real defect or
debt:

- **A — the enrichments↔vault-writer import cycle is load-order-fragile.**
  `lib/enrichments.ts` builds `export const ENRICHMENTS = [...]` at module
  top-level (line 92) from the twelve `*_ENRICHMENT` value consts, then derives
  `PIPELINE_ENRICHMENTS = ENRICHMENTS.filter(e => e.categoryMatches…)` (line 108).
  Four **data-backfill** drivers (`article`/`media`/`thread`/`tweet-body`)
  value-import `VaultWriter`, which (via `@/sync/vault-writer` →
  `vault-writer/vault-index.ts:6`) value-imports `ENRICHMENTS` **back** from
  enrichments.ts — closing the loop. It only survives today because `main.ts`'s
  import order loads enrichments (`registerRoostCommands`, line 6) **before**
  tweet-body-backfill (line 12). **A reorder crashes `onload`** with
  `Cannot read properties of undefined (reading 'categoryMatches')` at
  enrichments.ts:108. We break the cycle with the lowest-risk fix and lock it
  with a regression test.

- **B — two redundant chip systems render on the same compact gallery card.**
  The declarative one (`gallery-cards.ts:213-235`) loops `ENRICHMENTS[].chips`
  into `.roost-chip-row` pills, already gated on `enrichment_v_<id>` **and
  alias-aware** (plan 034). The hand-written one (`getCompactChips(hit)` in
  `pipeline-details.ts:199-243`) builds a `' · '` string into a
  `.roost-compact-chips` div that has **zero CSS** (verified: no rule anywhere in
  `styles/`). We unify on the declarative one and delete `getCompactChips`.

- **C — media schema-version invalidation is a live dead-bug.** The media
  **extraction** pipeline writes `pipeline_v_media` (`MEDIA_FIELDS.version`,
  `media-pipeline.ts:423`, stamped on every fresh run at line 456), but the
  staleness gate in `scanIncompleteIds` reads `enrichment_v_mediaExtraction`
  (the registry id is `mediaExtraction`) **and passes no aliases**
  (`vault-index.ts:249`). So on any vault that hasn't run the manual
  namespace-migrate command, a media schema bump **never flags items stale** —
  invalidation is dead. We point the write field at the canonical name AND make
  the gate alias-aware, in one shippable change. (Shipping only one half makes
  un-migrated vaults *worse* — see the STOP conditions.)

## Decisions already made (do not re-litigate)

1. **Part A leaves `enrichments.ts` 100% unchanged.** The fix lives entirely in
   the four drivers: drop the **value** import of `VaultWriter` and acquire it via
   `await import("@/sync/vault-writer")` inside the functions that construct it.
   The recipe/LLM pipelines do **not** import vault-writer — don't touch them.
2. **Part B is a deliberate, minor behavior change.** The redundant `' · '` string
   under the cover disappears; the declarative `.roost-chip-row` pills remain
   (strictly more capable, and the only one with CSS). The expanded detail
   (`renderPipelineDetail` / gallery-expanded-extras) is a **separate,
   non-redundant** surface — do **not** touch it.
3. **Part C ships both halves together.** Fix (1) write-field + fix (2)
   alias-aware gate are one atomic change. `namespace-migrate.ts` stays unchanged
   (optional cleanup only). `reconstructMediaCache` already dual-reads both
   fields — leave it. The data-backfill writers (mediaFiles/thread/tweetBody/
   articleBody) are already canonical via `stampEnrichmentVersion` — don't touch
   them.

## Current state (verbatim at `1515956`)

### Part A — the four drivers' VaultWriter usage

`lib/enrichments.ts:80,92-111` (the cycle's far end — **DO NOT EDIT**, shown for
context):

```ts
import { MEDIA_ENRICHMENT } from "@/sync/media-backfill";   // (line 80; also article/thread/tweet-body above)
...
export const ENRICHMENTS: readonly EnrichmentDef[] = [      // (line 92)
  ARTICLE_BODY_ENRICHMENT, THREAD_ENRICHMENT, RENDERED_TWEET_ENRICHMENT, MEDIA_ENRICHMENT, ...
] as const;

export const PIPELINE_ENRICHMENTS = ENRICHMENTS.filter(     // (line 108 — crashes if ENRICHMENTS has undefined holes)
  (e): e is EnrichmentDef & { categoryMatches: readonly string[] } =>
    (e.categoryMatches?.length ?? 0) > 0,
);
```

`sync/vault-writer/vault-index.ts:6` (the back-edge — context only):

```ts
import { ENRICHMENTS, isVersionStale, enrichmentVersionField } from "@/lib/enrichments";
```

Each of the four drivers has **exactly one** `new VaultWriter` call site
(verified: `grep -c "new VaultWriter"` = 1 per file). The constructions:

**`sync/article-backfill.ts`** — value import at `:15`, construction at `:121`,
and **VaultWriter is ALSO used as a type** at `:323`
(`writer: Pick<VaultWriter, "rewriteNoteBody">`), so this file keeps an
`import type { VaultWriter }` line:

```ts
import { VaultWriter } from "@/sync/vault-writer";          // line 15  (DROP the value import)
...
  const writer = new VaultWriter({                          // line 121 (inside runArticleBackfill, already async)
    vault: plugin.app.vault,
    syncFolder: plugin.settings.syncFolder,
    metadataCache: plugin.app.metadataCache,
    onLog: log,
  });
...
export async function refreshArticleNoteBodies(
  ...,
  writer: Pick<VaultWriter, "rewriteNoteBody">,             // line 323 (TYPE use — keep an `import type`)
```

**`sync/media-backfill.ts`** — value import at `:21`, construction at `:125`
(inside `runMediaBackfill`, already `async`). No type use:

```ts
import { VaultWriter } from "@/sync/vault-writer";          // line 21  (DROP)
...
  const writer = new VaultWriter({                          // line 125
    vault: plugin.app.vault, syncFolder: plugin.settings.syncFolder,
    metadataCache: plugin.app.metadataCache, tiktokWebview, onLog: log,
  });
```

**`sync/thread-backfill.ts`** — value import at `:22`, construction at `:142`
(inside `runThreadBackfill`, already `async`). No type use:

```ts
import { VaultWriter } from "@/sync/vault-writer";          // line 22  (DROP)
...
  const writer = new VaultWriter({                          // line 142
    vault: plugin.app.vault, syncFolder: plugin.settings.syncFolder,
    metadataCache: plugin.app.metadataCache, onLog: log,
  });
```

**`sync/tweet-body-backfill.ts`** — value import at `:21`, construction at `:102`
(inside `runTweetBodyBackfill`, already `async`). No type use. **NOTE:** the
auto-run path `maybeAutoRunTweetBodyBackfill` (line 170) does **NOT** construct
its own writer — it delegates to `runTweetBodyBackfill` via its injectable `run`
param, so there is still only **one** construction site in this file:

```ts
import { VaultWriter } from "@/sync/vault-writer";          // line 21  (DROP)
...
    const writer = new VaultWriter({                        // line 102 (inside runTweetBodyBackfill)
      vault: plugin.app.vault, syncFolder: plugin.settings.syncFolder,
      metadataCache: plugin.app.metadataCache, onLog: log,
    });
```

`main.ts` import order that the cycle survives on today (context):
`registerRoostCommands` at line 6 (transitively loads `enrichments.ts` —
`register-roost-commands.ts:7` imports `ENRICHMENTS`) before
`maybeAutoRunTweetBodyBackfill` at line 12. The fix removes the dependence on
this order.

### Part B — the two chip paths

`views/gallery-cards.ts:10` (the import — **drop `getCompactChips`**):

```ts
import { getPipelineData, renderPipelineOverlay, getCompactChips } from "@/views/pipeline-details";
```

`views/gallery-cards.ts:155-165` (the redundant call + the **CSS-less** div —
**delete lines 159-163**):

```ts
  if (roostIdVal) {
    const pipelineHit = getPipelineData(roostIdVal);
    if (pipelineHit) {
      renderPipelineOverlay(coverEl, pipelineHit.type);
      const chips = getCompactChips(pipelineHit);            // line 159  ┐
      if (chips) {                                           //           │ DELETE
        const chipsEl = el.createDiv({ cls: "roost-compact-chips" }); //  │ (159-163)
        chipsEl.textContent = chips;                         //           │
      }                                                      //           ┘
    }
  }
```

`views/gallery-cards.ts:213-235` (the declarative system that **stays** — already
alias-aware from plan 034; context only):

```ts
  if (roostIdVal) {
    const chipRow = body.createDiv({ cls: "roost-chip-row" });
    let chipsRendered = 0;
    for (const enrichment of ENRICHMENTS) {
      if (!enrichment.chips?.length) continue;
      const versionField = `enrichment_v_${enrichment.id}`;
      const versionValue = safeGetValue(entry, `note.${versionField}`);
      let hasVersion = versionValue != null && versionValue !== "";
      if (!hasVersion && enrichment.legacyAliases) {          // ← alias-aware (034)
        for (const alias of enrichment.legacyAliases) { ... }
      }
      if (!hasVersion) continue;
      for (const chip of enrichment.chips) {
        const fieldValue = safeGetValue(entry, `note.${chip.field}`);
        renderChip(chipRow, { kind: chip.kind, value: fieldValue as ... });
        chipsRendered++;
      }
    }
    if (chipsRendered === 0) chipRow.remove();
  }
```

`views/pipeline-details.ts:196-243` (the **whole** function + its banner to
**delete**; the `// ── Helpers ──` banner at 245 stays):

```ts
// ── Compact card chips ──

/** Return a short chip string for compact cards, e.g. "Italian · 30min · Easy" */
export function getCompactChips(hit: PipelineHit): string | null {
  let parts: (string | null | undefined)[];
  switch (hit.type) {
    case "recipe": { const d = hit.extraction as RecipeExtraction; parts = [d.cuisine, d.cookTime, d.difficulty ? capitalize(d.difficulty) : null]; break; }
    case "place":  { const d = hit.extraction as PlaceExtraction; return [d.city, d.country].filter(Boolean).join(", ") || null; }
    case "media":  { const d = hit.extraction as MediaExtraction; parts = [d.where, d.genre]; break; }
    case "product":{ const d = hit.extraction as ProductExtraction; parts = [d.price, d.whereToBuy]; break; }
    case "workout":{ const d = hit.extraction as WorkoutExtraction; parts = [d.targetArea, d.difficulty ? capitalize(d.difficulty) : null]; break; }
    case "tutorial":{ const d = hit.extraction as TutorialExtraction; parts = [d.skillArea ? capitalize(d.skillArea) : null, d.timeEstimate]; break; }
    case "home":   { const d = hit.extraction as HomeExtraction; parts = [d.room ? capitalize(d.room) : null, d.style]; break; }
    default: return null;
  }
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

// ── Helpers ──   ← KEEP this banner and everything below it.
```

**Verified safe to delete:** `capitalize`, `PipelineHit`, and every
`*Extraction` type that `getCompactChips` references are **all still used** by the
seven `render*` functions + `renderPipelineDetail` after deletion (grep-confirmed:
`capitalize` used at lines 274/319/367/396/439/455/457/483/484/509; `PipelineHit`
defined line 30 + used by `renderPipelineDetail` line 138; extraction types used
in the switch at 149-155). So deleting `getCompactChips` orphans **no** imports.

`views/__tests__/pipeline-details.test.ts:23` + `:76-144` (the import line + the
9-case describe block to **delete in the same change**):

```ts
import {
  parseRatingStars,
  getWhereColor,
  getCompactChips,        // line 23  ← drop from the import
  renderPipelineDetail,
  buildMapsUrl,
} from "@/views/pipeline-details";
...
// ── Task 2.2: getCompactChips per-type ──   (line 76)
describe("getCompactChips", () => { ...9 it() cases... });   // lines 78-144  ← DELETE the whole block
// ── Task 2.3: Structural detail-renderer tests ──   (line 146)  ← KEEP
```

### Part C — `MEDIA_FIELDS.version` + the vault-index gate call

`pipeline/media-pipeline.ts:46-47` (the literal to drop):

```ts
const MEDIA_PIPELINE_VERSION = 2;
const MEDIA_VERSION_FIELD = "pipeline_v_media";   // line 47  ← DROP this const
```

`pipeline/media-pipeline.ts:411-424` (`MEDIA_FIELDS.version` — repoint it):

```ts
export const MEDIA_FIELDS = {
  title: "media_title", creator: "media_creator", genre: "media_genre",
  rating: "media_rating", where: "media_where", description: "media_description",
  spotifyId: "media_spotify_id", tmdbId: "media_tmdb_id", tmdbType: "media_tmdb_type",
  anilistId: "media_anilist_id", year: "media_year",
  version: MEDIA_VERSION_FIELD,   // line 423  ← change to enrichmentVersionField("mediaExtraction")
} as const;
```

`pipeline/media-pipeline.ts:456` (the fresh-run stamp — uses `MEDIA_FIELDS.version`,
so it auto-follows; context only): `updates[MEDIA_FIELDS.version] = MEDIA_PIPELINE_VERSION;`

`pipeline/media-pipeline.ts:819` (the import to widen from type-only to a value
import of `enrichmentVersionField`):

```ts
import type { EnrichmentDef } from "@/lib/enrichments";   // line 819
```

`pipeline/media-pipeline.ts:841` (the alias — **KEEP**; context only):
`legacyAliases: ["pipeline_v_media"],`

`pipeline/media-pipeline.ts:783-811` (`reconstructMediaCache` — **already
dual-reads** both fields; **leave unchanged**; context only):

```ts
export function reconstructMediaCache(app: App): ... {
  ...
    if (!fm || (typeof fm.pipeline_v_media !== "number" && typeof fm.enrichment_v_mediaExtraction !== "number")) continue;   // line 790
  ...
}
```

`sync/vault-writer/vault-index.ts:248-252` (the gate call inside
`scanIncompleteIds` — **pass `def.legacyAliases`**):

```ts
          for (const def of ENRICHMENTS) {
            if (isVersionStale(def.id, fm, def.schemaVersion)) {       // line 249  ← add def.legacyAliases
              (byCategory as unknown as Record<string, Set<string>>)[def.id]?.add(id);
            }
          }
```

`lib/enrichments.ts:195-211` (`isVersionStale` — **already accepts** the optional
4th param `legacyAliases`; no change needed; context only):

```ts
export function isVersionStale(
  id: EnrichmentId, fm: Record<string, unknown> | undefined,
  currentSchemaVersion: number, legacyAliases?: string[],   // ← already here
): boolean {
  if (!fm) return false;
  const canonical = fm[enrichmentVersionField(id)];
  if (typeof canonical === "number") return canonical < currentSchemaVersion;
  if (legacyAliases) { for (const aliasField of legacyAliases) { const v = fm[aliasField]; if (typeof v === "number") return v < currentSchemaVersion; } }
  return false;
}
```

**Test-impact note (load-bearing for Part C):** the media write path is pinned by
a characterization test —
`pipeline/__tests__/pipeline-runners.harness.test.ts:564`:
`expect(fm).toHaveProperty("pipeline_v_media");`. After the field flips, the
write produces `enrichment_v_mediaExtraction`, so **this assertion must change in
the same step** (it proves the write now stamps the canonical field — exactly the
fix's point). Other tests touching `pipeline_v_media` are **input-seeding**
(read-path) and unaffected: `reconstruct-cache.test.ts:118`,
`pipeline-details-durability.test.ts:91` (both feed it to `reconstructMediaCache`,
which dual-reads), `enrichments.test.ts:116-129` (uses `mediaFiles` +
explicit aliases), `namespace-migrate.test.ts` (tests the rename fn directly).

### Existing test files you will extend

- `packages/core/src/lib/__tests__/enrichments.test.ts` (`@vitest-environment
  node`) — already imports `ENRICHMENTS` **in isolation** (no main.ts) and has an
  "ENRICHMENTS registry" describe (line 13) + an "isVersionStale with
  legacyAliases" describe (line 114). Home for Part A's no-undefined test and
  Part C's alias-gate unit test.
- `packages/core/src/sync/__tests__/vault-index.test.ts` — exercises `VaultIndex`
  directly via `makeFakeVault`; the `VaultIndex` constructor accepts an optional
  `metadataCache`. Home for Part C's end-to-end `scanIncompleteIds` staleness
  test (only if cheap — see Step C3).
- `packages/core/src/views/__tests__/pipeline-details.test.ts` — Part B test
  deletions.
- The declarative chip primitive `renderChip` is already unit-tested
  (`views/pipeline-views/shared/__tests__/chip.test.ts`), so the surviving
  declarative path keeps coverage after Part B.

## Commands

| Purpose    | Command                                          | Expected                              |
|------------|--------------------------------------------------|---------------------------------------|
| Baseline   | `cd /tmp/roost-merge && npm test 2>&1 \| tail -6`| record the count BEFORE you start: **1172 passed, 8 skipped** |
| Typecheck  | `npm run typecheck`                              | exit 0, no output                     |
| Tests      | `npm test`                                        | all pass (≥ baseline)                 |
| A filter   | `npm test -- enrichments`                         | passes                                |
| B filter   | `npm test -- pipeline-details`                    | passes                                |
| C filter   | `npm test -- pipeline-runners.harness enrichments vault-index` | passes                  |

Conventions: `strictNullChecks` + `noImplicitAny` (not full strict); `@/` alias →
`packages/core/src/`; frontmatter only via `buildFrontmatter` /
`updateNoteFrontmatter`; the `obsidian` package is auto-aliased to the stub. Do
**not** run `npm run test:e2e` unless asked.

## Scope

**In scope** (modify only these):

- **Part A**: `sync/article-backfill.ts`, `sync/media-backfill.ts`,
  `sync/thread-backfill.ts`, `sync/tweet-body-backfill.ts`,
  `lib/__tests__/enrichments.test.ts` (one new assertion).
- **Part B**: `views/gallery-cards.ts`, `views/pipeline-details.ts`,
  `views/__tests__/pipeline-details.test.ts`.
- **Part C**: `pipeline/media-pipeline.ts`,
  `sync/vault-writer/vault-index.ts`,
  `pipeline/__tests__/pipeline-runners.harness.test.ts` (update the one
  assertion), `lib/__tests__/enrichments.test.ts` + `sync/__tests__/vault-index.test.ts`
  (new gate tests).
- `plans/README.md` — status row.

**Out of scope** (do NOT touch):

- `lib/enrichments.ts` — **unchanged** in all three parts (Part A's whole point;
  Part C only reuses its existing `isVersionStale`/`enrichmentVersionField`).
- `lib/namespace-migrate.ts` — stays as optional cleanup (Maintenance note only).
- `reconstructMediaCache` (already dual-reads), the data-backfill writers
  (already canonical via `stampEnrichmentVersion`), the recipe/LLM pipelines (no
  vault-writer import).
- `renderPipelineDetail` / `gallery-expanded-extras.ts` (the expanded detail is a
  separate, non-redundant surface — Part B leaves it).
- The chip gate in `gallery-cards.ts:213-235` (already correct from 034) — Part C
  does **not** touch it.

---

## Part A — Break the enrichments↔vault-writer import cycle

### Step A1: Drop the value import + dynamic-import VaultWriter in all four drivers

For **each** of the four files, replace the value import with a dynamic import at
the single `new VaultWriter` call site. The pattern (apply per file):

- **Delete** the line `import { VaultWriter } from "@/sync/vault-writer";`.
- **Immediately before** the `const writer = new VaultWriter({...})` line, add:
  ```ts
  const { VaultWriter } = await import("@/sync/vault-writer");
  ```
  (The enclosing function is already `async` in every case — no signature change.)

Per-file specifics:

1. **`sync/article-backfill.ts`** — VaultWriter is **also a type** (`:323`
   `Pick<VaultWriter, "rewriteNoteBody">`). So **replace** the value import with a
   type import instead of deleting it outright:
   ```ts
   import type { VaultWriter } from "@/sync/vault-writer";   // was: import { VaultWriter } (line 15)
   ```
   then add `const { VaultWriter } = await import("@/sync/vault-writer");` just
   before line 121. (The runtime binding from the dynamic import shadows the
   erased type name inside `runArticleBackfill`; the `import type` line is erased
   at compile time, so there is no value-import edge — the cycle is broken.)

2. **`sync/media-backfill.ts`** — delete the `:21` value import; add the dynamic
   import before `:125`.

3. **`sync/thread-backfill.ts`** — delete the `:22` value import; add the dynamic
   import before `:142`.

4. **`sync/tweet-body-backfill.ts`** — delete the `:21` value import; add the
   dynamic import before `:102` (the only call site — the auto-run path delegates
   and constructs nothing).

**GOTCHA — all four must be fixed.** If even one driver keeps the value import,
the cycle survives. After editing, this grep must return **nothing**:

```bash
grep -rn 'import { VaultWriter } from "@/sync/vault-writer"' \
  packages/core/src/sync/article-backfill.ts \
  packages/core/src/sync/media-backfill.ts \
  packages/core/src/sync/thread-backfill.ts \
  packages/core/src/sync/tweet-body-backfill.ts
```

And this grep must show a dynamic import in **all four**:

```bash
grep -rln 'await import("@/sync/vault-writer")' packages/core/src/sync/*-backfill.ts
# expect: article-backfill.ts, media-backfill.ts, thread-backfill.ts, tweet-body-backfill.ts
```

### Step A2: Regression test — `ENRICHMENTS` initialises with no holes in isolation

In `packages/core/src/lib/__tests__/enrichments.test.ts`, add an assertion to the
existing `describe("ENRICHMENTS registry", …)` block (this file imports
`ENRICHMENTS` from `../enrichments` directly — **without** main.ts or
register-roost-commands, so it reproduces the fragile load order):

```ts
it("every registered enrichment initialises (no module-init-order holes)", () => {
  // Locks the import-cycle fix (plan 038A): if a driver re-introduces a value
  // import of VaultWriter, importing enrichments in isolation (as this file does)
  // can leave undefined holes in ENRICHMENTS, and PIPELINE_ENRICHMENTS' filter on
  // e.categoryMatches throws at module load.
  expect(ENRICHMENTS.length).toBeGreaterThan(0);
  expect(ENRICHMENTS.every((e) => e !== undefined)).toBe(true);
  // PIPELINE_ENRICHMENTS is derived at module top-level; importing it proves the
  // .filter(e => e.categoryMatches) ran without throwing.
  expect(PIPELINE_ENRICHMENT_IDS.length).toBeGreaterThan(0);
});
```

(`PIPELINE_ENRICHMENT_IDS` is already imported at the top of this test file.)

### Verify — Part A

```bash
cd /tmp/roost-merge
npm run typecheck                 # exit 0
npm test -- enrichments           # passes (incl. the new no-holes test)
```

- [ ] `npm run typecheck` exits 0.
- [ ] The two greps in Step A1 confirm zero value imports + four dynamic imports.
- [ ] `npm test -- enrichments` passes including the new assertion.

---

## Part B — Collapse the two chip systems to one (delete `getCompactChips`)

### Step B1: Remove the redundant call + CSS-less div from `gallery-cards.ts`

In `views/gallery-cards.ts`:

1. **Delete lines 159-163** (the `getCompactChips` call and the
   `.roost-compact-chips` div), leaving the `if (roostIdVal) { ... pipelineHit ...
   renderPipelineOverlay(...) }` block as:
   ```ts
   if (roostIdVal) {
     const pipelineHit = getPipelineData(roostIdVal);
     if (pipelineHit) {
       renderPipelineOverlay(coverEl, pipelineHit.type);
     }
   }
   ```
2. **Drop `getCompactChips`** from the import on line 10:
   ```ts
   import { getPipelineData, renderPipelineOverlay } from "@/views/pipeline-details";
   ```

The declarative chip block at 213-235 is **untouched** — it remains the single
chip system.

### Step B2: Delete `getCompactChips` from `pipeline-details.ts`

In `views/pipeline-details.ts`, delete the `// ── Compact card chips ──` banner
(line 196) through the closing brace of `getCompactChips` (line 243). **Keep** the
`// ── Helpers ──` banner at line 245 and everything below it
(`kvRow`/`pillList`/`numberedList`/`capitalize` + the seven `render*` functions +
`parseRatingStars`/`getWhereColor`/`renderPipelineDetail`).

No import cleanup is needed — `capitalize`, `PipelineHit`, and all `*Extraction`
types remain used by the renderers (verified in Current state).

### Step B3: Delete the `getCompactChips` tests (same change)

In `views/__tests__/pipeline-details.test.ts`:

1. Remove `getCompactChips,` from the import block (line 23).
2. Delete the `// ── Task 2.2: getCompactChips per-type ──` banner (line 76)
   through the end of the `describe("getCompactChips", …)` block (line 144).
   **Keep** the `// ── Task 2.3 ──` section (line 146 onward).

This must be in the **same** change as B1/B2, or typecheck + tests break on the
now-missing export.

### Verify — Part B

```bash
cd /tmp/roost-merge
npm run typecheck                 # exit 0
npm test -- pipeline-details      # passes (getCompactChips block gone)
grep -rn "getCompactChips\|roost-compact-chips" packages/core/src   # expect: NOTHING
```

- [ ] `npm run typecheck` exits 0.
- [ ] `grep -rn "getCompactChips" packages/core/src` → **no hits** (export, call,
      and tests all gone).
- [ ] `grep -rn "roost-compact-chips" packages/core/src` → **no hits**.
- [ ] `npm test -- pipeline-details` passes; the declarative `renderChip` test
      (`chip.test.ts`) still passes (`npm test -- chip`).
- [ ] The declarative chip loop at `gallery-cards.ts:213-235` is **unchanged**
      (`git diff packages/core/src/views/gallery-cards.ts` shows only the
      159-163 deletion + the line-10 import edit).

---

## Part C — Unify the media version namespace (BOTH halves, together)

> **Ship both fixes in one step group.** Fix (1) alone (write-field flip without
> the alias gate) makes un-migrated vaults *worse*. See STOP conditions.

### Step C1: Point `MEDIA_FIELDS.version` at the canonical field

In `pipeline/media-pipeline.ts`:

1. **Widen the import** on line 819 from type-only to also bring in the value
   `enrichmentVersionField`:
   ```ts
   import { enrichmentVersionField, type EnrichmentDef } from "@/lib/enrichments";
   ```
   (This adds a value import of `@/lib/enrichments` to media-pipeline — that is
   **fine**: media-pipeline does **not** import vault-writer, so it is **not** part
   of the Part A cycle. Verified: `grep "vault-writer" media-pipeline.ts` = none.)
2. **Delete** the `MEDIA_VERSION_FIELD` const (line 47).
3. **Repoint** `MEDIA_FIELDS.version` (line 423):
   ```ts
   version: enrichmentVersionField("mediaExtraction"),   // was: MEDIA_VERSION_FIELD ("pipeline_v_media")
   ```
   The fresh-run stamp at line 456 (`updates[MEDIA_FIELDS.version] = …`) follows
   automatically. **KEEP** `legacyAliases: ["pipeline_v_media"]` on
   `MEDIA_EXTRACTION_ENRICHMENT` (line 841) and **leave `reconstructMediaCache`
   unchanged** (it already dual-reads both fields, line 790).

Consequence to expect (not a bug): `media-pipeline-migrate.ts:115` writes
`[MEDIA_FIELDS.version]: 1` for legacy `Pipelines/Media` notes — it will now write
the **canonical** `enrichment_v_mediaExtraction: 1` instead of `pipeline_v_media:
1`. That is *more* correct (the gate then sees it, and `1 < 2` flags it stale →
re-extract). It has **no test pinning the literal field name** (verified — the
only write-path assertion is the harness test updated in Step C3). Do not change
`media-pipeline-migrate.ts`.

### Step C2: Make the `scanIncompleteIds` gate alias-aware

In `sync/vault-writer/vault-index.ts`, pass the enrichment's `legacyAliases` to
the existing `isVersionStale` call (line 249):

```ts
          for (const def of ENRICHMENTS) {
            if (isVersionStale(def.id, fm, def.schemaVersion, def.legacyAliases)) {
              (byCategory as unknown as Record<string, Set<string>>)[def.id]?.add(id);
            }
          }
```

`isVersionStale` already accepts the 4th param (enrichments.ts:199) — no signature
change there. This repairs media staleness on un-migrated vaults (their on-disk
`pipeline_v_media` now satisfies the gate via the alias) **and** fixes the
`mediaFiles` enrichment's staleness for free (same gate, same alias mechanism).

### Step C3: Tests

**(a) Update the media write characterization assertion (required, in this step).**
In `pipeline/__tests__/pipeline-runners.harness.test.ts:564`, change:
```ts
expect(fm).toHaveProperty("pipeline_v_media");
```
to:
```ts
expect(fm).toHaveProperty("enrichment_v_mediaExtraction");
```
(The media pipeline now stamps the canonical field. This pins the fix.)

**(b) Alias-gate unit test (required, cheap).** In
`lib/__tests__/enrichments.test.ts`, add to the existing
`describe("isVersionStale with legacyAliases", …)` block a case proving a media
note with **only** the legacy field, below schemaVersion, is flagged stale via the
alias — using the **live** `mediaExtraction` def's alias (not a hand-passed
array), so it exercises the real wiring:

```ts
it("flags a media note that has only pipeline_v_media < schemaVersion (via the live alias)", () => {
  const def = getEnrichmentById("mediaExtraction")!;
  // schemaVersion is 2; an un-migrated note has only the legacy field at v1.
  expect(isVersionStale(def.id, { pipeline_v_media: 1 }, def.schemaVersion, def.legacyAliases)).toBe(true);
  // A current legacy stamp is NOT stale.
  expect(isVersionStale(def.id, { pipeline_v_media: def.schemaVersion }, def.schemaVersion, def.legacyAliases)).toBe(false);
});
```

**(c) End-to-end gate test (preferred if cheap; skip-with-note if heavy).** In
`sync/__tests__/vault-index.test.ts`, add a `scanIncompleteIds` test that proves
`VaultIndex` actually *passes* `def.legacyAliases` to the gate (not just that
`isVersionStale` can). `scanIncompleteIds` reads
`this.metadataCache?.getFileCache(file)?.frontmatter`, so construct `VaultIndex`
with a tiny fake `metadataCache`:

```ts
it("scanIncompleteIds flags a media note with only legacy pipeline_v_media < schemaVersion", async () => {
  const { vault, seedNote } = makeFakeVault();
  seedNote(
    "Bookmarks/TikTok/m1.md",
    "---\nroost_id: tiktok:m1\nplatform: tiktok\nroost_subcategory: Films\npipeline_v_media: 1\n---\n\nbody\n",
  );
  const fakeMetadataCache = {
    getFileCache: (file: { path: string }) =>
      file.path === "Bookmarks/TikTok/m1.md"
        ? { frontmatter: { roost_id: "tiktok:m1", roost_subcategory: "Films", pipeline_v_media: 1 } }
        : null,
  };
  const index = new VaultIndex({
    vault: vault as any,
    syncFolder: "Bookmarks",
    metadataCache: fakeMetadataCache as any,
    log: () => {},
  });
  const result = await index.scanIncompleteIds();
  expect(result.byCategory.mediaExtraction.has("tiktok:m1")).toBe(true);
});
```

If `scanIncompleteIds` needs more wiring than this (e.g. it throws on the fake
metadataCache shape, or `byCategory.mediaExtraction` isn't a `Set`), the (a)+(b)
tests already prove the fix end-to-end at the gate-logic level — **add (c) only if
it lands in a few minutes; otherwise note it as deferred** (do not block Part C on
it). Confirm the `byCategory` key name and Set type by reading `vault-index.ts`'s
`IncompleteIdsResult` before writing the assertion.

### Verify — Part C

```bash
cd /tmp/roost-merge
npm run typecheck                                       # exit 0
npm test -- pipeline-runners.harness enrichments vault-index   # all pass
grep -n "MEDIA_VERSION_FIELD" packages/core/src/pipeline/media-pipeline.ts   # expect: NOTHING (const removed)
grep -n 'version: enrichmentVersionField' packages/core/src/pipeline/media-pipeline.ts   # expect: present
grep -n "def.legacyAliases" packages/core/src/sync/vault-writer/vault-index.ts           # expect: present in the gate call
```

- [ ] `npm run typecheck` exits 0.
- [ ] `MEDIA_VERSION_FIELD` is gone; `MEDIA_FIELDS.version` =
      `enrichmentVersionField("mediaExtraction")`.
- [ ] The vault-index gate call passes `def.legacyAliases`.
- [ ] The harness test asserts `enrichment_v_mediaExtraction` (not
      `pipeline_v_media`); the alias-gate unit test passes; (c) passes or is noted
      deferred.
- [ ] `reconstructMediaCache` and `legacyAliases: ["pipeline_v_media"]` are
      **unchanged** (`git diff` shows only the const drop + the `.version` repoint
      + the import widen in media-pipeline.ts).

---

## Done criteria (whole plan)

Machine-checkable. Each part is independent — a STOP in one does not block the
others' criteria.

**Global:**
- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0, **≥ 1172 passed** (baseline) + the new tests.
- [ ] No files outside the in-scope lists are modified (`git status`).
- [ ] `plans/README.md` status row updated.

**Part A:**
- [ ] `grep -rn 'import { VaultWriter } from "@/sync/vault-writer"' packages/core/src/sync/*-backfill.ts`
      → **no hits** (all four converted to `await import`).
- [ ] `grep -rln 'await import("@/sync/vault-writer")' packages/core/src/sync/*-backfill.ts`
      → lists all four drivers.
- [ ] `article-backfill.ts` keeps an `import type { VaultWriter }` (the `Pick<…>`
      type use at :323 still compiles).
- [ ] The `enrichments.test.ts` no-holes test passes.

**Part B:**
- [ ] `grep -rn "getCompactChips" packages/core/src` → **no hits**.
- [ ] `grep -rn "roost-compact-chips" packages/core/src` → **no hits**.
- [ ] The declarative chip loop in `gallery-cards.ts` is byte-unchanged except the
      159-163 deletion + the import edit.

**Part C:**
- [ ] `grep -n "MEDIA_VERSION_FIELD" packages/core/src/pipeline/media-pipeline.ts`
      → **no hits**.
- [ ] `grep -n "def.legacyAliases" packages/core/src/sync/vault-writer/vault-index.ts`
      → present in the `scanIncompleteIds` gate.
- [ ] The harness test asserts `enrichment_v_mediaExtraction`.

## STOP conditions

Stop and report (do not improvise) if:

- **(any part)** The cited excerpts don't match the live code (drift) — re-read
  and report which part drifted; the other parts may still proceed.
- **(A)** After the four edits, the `import { VaultWriter }` grep still finds a
  hit, or `npm test -- enrichments` fails the no-holes test — the cycle isn't
  fully broken; do not declare A done.
- **(A)** A driver's `new VaultWriter` turns out to be in a **non-async** function
  (the recon says all four are `async` — verified) — if one isn't, hoist a
  per-module `async function getVaultWriter()` rather than changing the public
  function's signature, and note it.
- **(B)** Deleting `getCompactChips` orphans an import that typecheck flags as
  unused-and-now-erroring — re-check Current state (it shouldn't; `capitalize` /
  `PipelineHit` / the extraction types are all still used). Only then remove the
  specific orphaned import.
- **(C)** You are tempted to ship **only** the write-field flip (C1) without the
  gate fix (C2), or vice versa — **don't.** C1 alone leaves un-migrated vaults
  with on-disk `pipeline_v_media` matching neither the new write field nor the
  gate (strictly worse). Both or neither.
- **(C)** Any test beyond the cited harness assertion breaks on the field flip
  (e.g. a hidden write-path snapshot) — that's a second pinned consumer; report it
  before broadening the change. (Recon verified only `harness:564` pins the write.)
- **(any)** A verification fails twice after a reasonable fix.

## Maintenance notes

- **Part A is the minimal cut.** A heavier alternative (a barrel that re-exports
  `VaultWriter` lazily, or moving `ENRICHMENTS` out of `lib/`) was rejected for
  blast radius. The dynamic import keeps the four drivers' behavior identical
  (they already `await` heavily) and removes the only value edge into the cycle.
  The no-holes test is the tripwire if anyone reintroduces a static import.
- **Part C also repairs `mediaFiles` staleness** for free: the same alias-aware
  gate now honors any enrichment's `legacyAliases` (e.g. `mediaFiles`'
  `enrichment_v_media`). No extra work — just noted so a reviewer expects it.
- **`namespace-migrate.ts` could later auto-run, flag-gated.** It renames
  `pipeline_v_media → enrichment_v_mediaExtraction` on disk. After Part C the gate
  no longer *needs* it (the alias handles reads, the write is canonical), so it
  stays a manual palette command. A future plan could auto-run it once on load
  behind a `namespaceMigrated` settings flag (mirroring 037's
  `tweetBodyBackfillDone`) to retire the `pipeline_v_media` field from disk
  entirely — but that is **out of scope here** and optional.
- **Optional follow-up — derive `FILED_RECIPE_CATEGORIES` from
  `RECIPE_ENRICHMENT.categoryMatches`.** The recipe pipeline keeps a hand-written
  category list that duplicates the registry's `categoryMatches`; deriving it from
  the def removes a second source of truth (same spirit as this plan's chip
  consolidation). Track as its own plan — it touches the recipe gather path and is
  not part of 038.
- **Reviewer focus:** (A) all four drivers converted + the `import type` retained
  in article-backfill; (B) the expanded detail surface untouched and the
  declarative gate untouched; (C) both halves present, `reconstructMediaCache` and
  the `legacyAliases` array untouched, the harness assertion flipped to the
  canonical field.
