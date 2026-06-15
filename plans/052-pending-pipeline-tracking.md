# Plan 052: Track + surface (and auto-enqueue) pending category-pipeline work after sync / Smart Assign

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5957fe7..HEAD -- packages/core/src/pipeline packages/core/src/lib/enrichments.ts packages/core/src/main.ts packages/core/src/types/plugin.ts packages/core/src/ui/hub packages/core/src/ui/hooks/use-smart-assign.ts packages/core/src/ui/hooks/use-roost-platform-sync.ts packages/core/src/ui/hooks/use-roost-pipeline-rows.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. This plan was **refreshed at `5957fe7`**
> against the live hub state after commit `d63718c` ("embedding backend
> visibility") reshaped `state.ts` / `use-hub-state.ts` — the line refs below
> reflect that post-`d63718c` shape.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (composes with 040 serial job queue, already merged). 053 and 054 are independent and may land before or after.
- **Category**: direction (feature)
- **Planned at**: commit `ae7335a`, refreshed against `5957fe7`, 2026-06-15

## Why this matters

Roost has seven LLM category pipelines (recipe, place, mediaExtraction, product, workout, tutorial, home) that enrich notes. After a sync adds bookmarks, or after Smart Assign embeds + categorizes items, some of those items become pipeline candidates that have never been processed — but nothing tracks or surfaces "these pipelines have pending work," and nothing runs them automatically. The user must remember to open each pipeline and run it manually. This plan adds a **derived pending count per pipeline**, surfaces it as **hub badges + a top-line summary**, and **auto-enqueues** the gate-active pipelines that have pending work after Smart Assign / sync (through the existing serial job queue, so they never thrash the vault). The count is derived from each pipeline's own cache file, so it is automatically correct whether a run finished, was cancelled, or never started — there is no persisted "dirty" flag to get stuck.

## Background the executor must understand (read before touching code)

**All 7 pipelines share one runner.** Every `*-pipeline.ts` builds a
`CategoryPipelineConfig` and delegates to `runCategoryPipeline(app, syncFolder, config, onLog)` in
`packages/core/src/pipeline/run-category-pipeline.ts`. The runner (lines 122-136) loads the
pipeline's cache and computes exactly the quantity this feature needs:

```ts
// run-category-pipeline.ts:122-136
const cache = loadPipelineCache<TEntry>(vault, config.cacheFile);
const candidates = config.gatherCandidates(app, syncFolder);
const uncached = candidates.filter(c => !cache[c.roostId]);
const needExtract = candidates.filter(
  c => cache[c.roostId]?.triage === config.extractVerdict && !cache[c.roostId]?.extraction,
).length;
// complete = candidates.length - uncached.length - needExtract
```

So for a pipeline, **pending work = `uncached` (never triaged) + `needExtract` (triaged to the
extract verdict but not yet extracted)**. Everything else is terminal: a `skip`/`restaurant`
verdict entry, or an entry whose `extraction` is set. This is the anti-nag property — an item the
pipeline already triaged as "skip" has a cache entry and never re-counts. (Two pipelines have
retry policies — `onTriageFailure:"leave"` and `onExtractFailure:"retry"` — under which a
*permanently*-failing item stays pending. That is faithful: a run *would* retry it. We do not
special-case it here; see Maintenance notes.)

**Candidate cache shape** (`run-category-pipeline.ts:30-36`):
```ts
export type PipelineCacheEntry<TVerdict extends string, TExtract> = { triage: TVerdict; extraction: TExtract | null };
export type PipelineCache<TVerdict, TExtract> = Record<string, PipelineCacheEntry<TVerdict, TExtract>>;
```

**Pipelines gather candidates by `embedded.category`** (the LLM's one-word guess in the embedding
cache) OR a tag-keyword match. `embedded.category` is written by the Smart Assign embed step, so
recomputing the count *after Smart Assign* is the primary effective trigger. (Recipe additionally
gathers by the user-filed `roost_category`; the other 6 do not — that gap is Plan 053's scope, NOT
this plan's. This plan counts exactly what a run *would* process today.)

**The 7 pipeline enrichments + their cache files** (`id` → `cacheFile`):
`recipe`→`recipe-cache.json`, `place`→`places-cache.json`, `mediaExtraction`→`media-cache.json`,
`product`→`products-cache.json`, `workout`→`workouts-cache.json`, `tutorial`→`tutorials-cache.json`,
`home`→`home-cache.json`.

## Current state

Files and the exact code this plan extends:

- `packages/core/src/lib/enrichments.ts` — the enrichment registry. `EnrichmentDef`
  (lines 41-73) has no cache/gather metadata. `PIPELINE_ENRICHMENTS` (110-113) is the 7
  pipeline defs. `PipelineId` (117), `isPipelineEnrichmentId` (119), `isVersionStale`
  (197-213), `enrichmentVersionField` (181-183) all exist and are reused.
- `packages/core/src/pipeline/run-category-pipeline.ts` — generic runner;
  `CategoryPipelineConfig` (46-106) carries `cacheFile`, `extractVerdict`, `gatherCandidates`.
- `packages/core/src/pipeline/recipe-pipeline.ts` (and places/products/workouts/tutorials/home/
  media `*-pipeline.ts`) — each has a private `gatherCandidates(app, syncFolder)` that reads
  `loadEmbeddingCache(app.vault)` + `buildFileIndex(app, syncFolder)`, then for each file checks
  `embedded.category` membership / tag keywords (and, for recipe only, filed category). Example
  (recipe-pipeline.ts:132-154):
  ```ts
  export function gatherCandidates(app: App, syncFolder: string): RecipeCandidate[] {
    const embeddingCache = loadEmbeddingCache(app.vault);
    const fileIndex = buildFileIndex(app, syncFolder);
    const candidates: RecipeCandidate[] = [];
    for (const [roostId, file] of fileIndex) {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const embedded = embeddingCache[roostId];
      const category = (embedded?.category || "").toLowerCase();
      const rawTags = Array.isArray(fm.tags) ? fm.tags : [];
      const tags = rawTags.map(t => String(t).toLowerCase());
      const categoryMatch = RECIPE_CATEGORIES.has(category);
      const tagMatch = tags.some(t => RECIPE_TAG_KEYWORDS.some(kw => t.includes(kw)));
      const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
      const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
      const filedMatch = FILED_RECIPE_CATEGORIES.has(filedCat) || FILED_RECIPE_CATEGORIES.has(filedSub);
      if (!categoryMatch && !tagMatch && !filedMatch) continue;
      const raw = readRawJson(app.vault, syncFolder, roostId);   // <- the expensive part
      // ... builds the full candidate object ...
    }
  }
  ```
  The part above the `readRawJson` line is the **id-matching predicate**; the `readRawJson` +
  object build is the expensive part we must NOT do during a scan.
- `packages/core/src/pipeline/shared.ts` — `loadEmbeddingCache(vault)` (199, memoized),
  `loadPipelineCache<T>(vault, filename)` (363). `packages/core/src/lib/vault-utils.ts:102` —
  `buildFileIndex(app, syncFolder): Map<string, TFile>`.
- `packages/core/src/main.ts` — `IRoostPlugin` impl. `lastIncompleteScan` (78) is the existing
  precedent for a transient derived field on the plugin. `runJob` (132-137) enqueues onto the
  serial `jobQueue`. `triggerHubStateChange()` (307) fires `roost:hub-state-changed`. `onload`
  (159-206) ends with two deferred `window.setTimeout` blocks; the 500ms one (188) is gated on
  `!hasAnyPlatform` (first-launch only) and the 4000ms one (203) runs the tweet-body catch-up
  unconditionally.
- `packages/core/src/types/plugin.ts` — `IRoostPlugin` interface; `lastIncompleteScan`
  (line 47) is the field to mirror.
- `packages/core/src/ui/hub/state.ts` — pure hub derivation. **Post-`d63718c` shape:**
  `HubInputs` (6-29) now also carries an optional `embedding?` field (27-28);
  `deriveBacklogs(byCategory)` (82-90) → `Backlogs`; `HubState` (51-60) now has FOUR top-level
  keys — `prereqs`, `platforms`, `global` (54-58, unchanged: `lastFullUpdate`,
  `anythingToUpdate`, `anythingNeedsAttention`), and a sibling `embedding: { label; warn } | null`
  (59); `deriveHubState` (130-170) returns `{ prereqs, platforms, global, embedding }` (line 169),
  building the `global` object literal at line 169 and the `embedding` value at 162-167.
  `incompleteByCategory` flows in at line 24/132. **Add `pendingPipelines` to `HubInputs` next to
  `incompleteByCategory`, and `pipelinesPending` INSIDE the `global` object** (not as a new sibling
  — keep `embedding` separate).
- `packages/core/src/ui/hub/use-hub-state.ts` — **Post-`d63718c`:** `gatherInputs(app, plugin,
  embeddingInput?)` (18-48) now takes a third arg and returns `embedding: embeddingInput` (46);
  it reads `plugin.lastIncompleteScan` at line 38 (`incompleteByCategory: plugin.lastIncompleteScan`).
  Add `pendingPipelines: plugin.lastPendingPipelines` right after that line — do NOT change the
  signature. Re-renders on `roost:hub-state-changed` (86). This is the existing event channel —
  reuse it, add no new event.
- `packages/core/src/ui/hub/pipeline-rows.ts` — `PipelineRow` (`{id,label,blurb,enabled,status}`)
  and `buildPipelineRows(flags, llm)`.
- `packages/core/src/ui/hub/pipelines-panel.tsx` — renders each row; middle column shows
  `row.enabled && llm ? row.blurb : st.text`.
- `packages/core/src/ui/hub/global-action-bar.tsx:81-84` — `subParts` builds the summary subline
  (`"${backlogs} backfills"`). Mirror this for pending pipelines.
- `packages/core/src/ui/hub/hub-body.tsx` — `runAllPipelines` (251-267) is the existing manual
  "Run pipelines" button: it filters `PIPELINE_ENRICHMENTS` by
  `isCategoryPipelineActive(d.categoryMatches[0], plugin)` and runs each via
  `plugin.runJob(d.commandName, () => d.runBackfill(plugin, { onLog: m => plugin.fireLog(...) }))`.
  **This is the exact auto-enqueue mechanism — factor and reuse it.** `buildPipelineRows` is called
  at line 402.
- `packages/core/src/ui/hooks/use-smart-assign.ts:171-175` — `runUnderGuard` already calls
  `await scanLibrary()` then `await waitForMetadataQuiet(app.metadataCache)` after a confirm. This
  is the Smart Assign trigger point.
- `packages/core/src/ui/hooks/use-roost-platform-sync.ts` — sets `plugin.lastIncompleteScan`
  (94) and logs "Sync complete" (~171). Sync trigger point.
- `packages/core/src/ui/hooks/use-roost-pipeline-rows.ts:~43` — `handleRunPipeline` calls
  `plugin.fireDataRefresh()` after a single-pipeline run. Per-pipeline-run trigger point.

**Conventions to match:** TypeScript with `strictNullChecks` + `noImplicitAny` (not full strict).
Imports use the `@/` alias. New per-pipeline exports stay colocated in each `*-pipeline.ts`
(see how `RECIPE_ENRICHMENT` lives next to `gatherCandidates`). Unit tests are colocated in
`__tests__/` and run with Vitest + the `obsidian` stub. Frontmatter is read via
`app.metadataCache.getFileCache(file)?.frontmatter`.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, no output |
| Unit tests | `npm test` | all pass (~1250 baseline at `5957fe7` + new) |
| Build | `npm run build` | `dist/main.js` + `dist/styles.css` |

## Scope

**In scope** (modify):
- `packages/core/src/pipeline/scan-pending-pipelines.ts` (create)
- `packages/core/src/lib/enrichments.ts` (add optional `cacheFile` + `gatherCandidateIds` +
  `pendingExtractVerdict` to `EnrichmentDef`; populate them on the 7 pipeline defs' source files)
- `packages/core/src/pipeline/recipe-pipeline.ts`, `places-pipeline.ts`, `products-pipeline.ts`,
  `workouts-pipeline.ts`, `tutorials-pipeline.ts`, `home-pipeline.ts`, `media-pipeline.ts`
  (export an id-only `gather*CandidateIds`; refactor existing `gatherCandidates` to consume it so
  the two can't drift; wire the new `EnrichmentDef` fields)
- `packages/core/src/types/plugin.ts` (add `lastPendingPipelines` + `refreshPendingPipelines()`)
- `packages/core/src/main.ts` (field + method + deferred-load scan + reuse for auto-enqueue)
- `packages/core/src/ui/hub/state.ts` (add `pendingPipelines` input + `derivePipelinesPending`)
- `packages/core/src/ui/hub/use-hub-state.ts` (feed `plugin.lastPendingPipelines`)
- `packages/core/src/ui/hub/pipeline-rows.ts` (thread `pending`/`stale` onto rows)
- `packages/core/src/ui/hub/pipelines-panel.tsx` (render the badge)
- `packages/core/src/ui/hub/global-action-bar.tsx` (subline clause)
- `packages/core/src/ui/hub/hub-body.tsx` (pass pending map to `buildPipelineRows`; factor the
  auto-enqueue helper out of `runAllPipelines`)
- `packages/core/src/ui/hooks/use-smart-assign.ts` (trigger recompute + auto-enqueue)
- `packages/core/src/ui/hooks/use-roost-platform-sync.ts` (trigger recompute)
- `packages/core/src/ui/hooks/use-roost-pipeline-rows.ts` (trigger recompute after single run)
- `__tests__/` files as listed in the Test plan

**Out of scope** (do NOT touch):
- The pipelines' triage/extract logic, cache write semantics, or `run-category-pipeline.ts`
  control flow. We only READ caches and call existing gather predicates.
- Making the 5 embedded-only pipelines gather by `roost_category` — that is **Plan 053**. This
  plan's count must reflect what a run does *today*.
- Cancellation / `AbortSignal` — that is **Plan 054**.
- Any persisted state in `data.json` / settings. The count is derived and transient.
- `digest-pipeline.ts` (not a `PIPELINE_ENRICHMENTS` member; it has no `categoryMatches`).

## Git workflow

- Branch: `advisor/052-pending-pipeline-tracking`
- Conventional commits, e.g. `feat(hub): track + auto-enqueue pending pipeline work`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Expose an id-only candidate matcher on each pipeline, consumed by its own `gatherCandidates`

For each of the 7 pipelines, add an exported `gather<Name>CandidateIds(app, syncFolder): Set<string>`
that contains **exactly** the id-matching predicate from the current `gatherCandidates` (the part
*above* the `readRawJson` call) and returns the set of matching `roostId`s — with **no
`readRawJson` and no candidate-object construction**. Then refactor the existing `gatherCandidates`
to iterate that set (so the predicate lives in one place and cannot drift).

Recipe example — target shape:
```ts
// recipe-pipeline.ts
export function gatherRecipeCandidateIds(app: App, syncFolder: string): Set<string> {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const ids = new Set<string>();
  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const category = (embeddingCache[roostId]?.category || "").toLowerCase();
    const tags = (Array.isArray(fm.tags) ? fm.tags : []).map(t => String(t).toLowerCase());
    const categoryMatch = RECIPE_CATEGORIES.has(category);
    const tagMatch = tags.some(t => RECIPE_TAG_KEYWORDS.some(kw => t.includes(kw)));
    const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
    const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
    const filedMatch = FILED_RECIPE_CATEGORIES.has(filedCat) || FILED_RECIPE_CATEGORIES.has(filedSub);
    if (categoryMatch || tagMatch || filedMatch) ids.add(roostId);
  }
  return ids;
}

export function gatherCandidates(app: App, syncFolder: string): RecipeCandidate[] {
  const ids = gatherRecipeCandidateIds(app, syncFolder);
  const fileIndex = buildFileIndex(app, syncFolder);
  const embeddingCache = loadEmbeddingCache(app.vault);
  const candidates: RecipeCandidate[] = [];
  for (const roostId of ids) {
    const file = fileIndex.get(roostId);
    if (!file) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const embedded = embeddingCache[roostId];
    const raw = readRawJson(app.vault, syncFolder, roostId);
    // ... unchanged candidate construction (description/vision/author/etc.) ...
  }
  return candidates;
}
```

Do the same for places (substring predicate `PLACE_CATEGORY_SUBSTRINGS.some(sub => category.includes(sub))`
after `.replace(/[^a-z]/g, "")`), products/workouts/tutorials/home (`*_CATEGORIES.has(category)` +
`*_TAG_KEYWORDS`), and media (its **discovery** branch only — `MEDIA_CATEGORIES` membership + tag
keywords; do NOT include the `roost_category` filter-mode branch). Preserve each pipeline's EXACT
matching semantics (places is substring; the rest are Set membership). `buildFileIndex` and
`loadEmbeddingCache` are both cheap/memoized so calling them twice is fine, but prefer the shape
above where `gatherCandidates` reuses the id set.

**Verify**: `npm run typecheck` → exit 0. `npm test` → existing pipeline tests still pass
(the refactor is behavior-preserving).

### Step 2: Add cache/gather metadata to `EnrichmentDef` and populate it on the 7 pipeline defs

In `enrichments.ts`, extend `EnrichmentDef` with three optional fields:
```ts
/** (pipelines only) The pipeline's cache file under .roost/cache/, e.g. "recipe-cache.json". */
cacheFile?: string;
/** (pipelines only) Same id-matching predicate the pipeline's gatherCandidates uses. */
gatherCandidateIds?: (app: import("obsidian").App, syncFolder: string) => Set<string>;
/** (pipelines only) The triage verdict that means "extract me" — an entry with this verdict
 *  and a null extraction is still pending. */
pendingExtractVerdict?: string;
```
Populate all three on each pipeline's `EnrichmentDef` in its source file (e.g. in
`RECIPE_ENRICHMENT`: `cacheFile: "recipe-cache.json"`, `gatherCandidateIds: gatherRecipeCandidateIds`,
`pendingExtractVerdict: "recipe"`). The verdicts are: recipe→`"recipe"`, place→`"place"`,
mediaExtraction→ its `extractVerdict` (read it from the media config — likely `"media"`),
product→`"product"`, workout→`"workout"`, tutorial→`"tutorial"`, home→`"home"`. **Read each
pipeline's `CategoryPipelineConfig.extractVerdict` and use that exact string** — do not guess.

**Verify**: add a registry test (Step 7) asserting every `PIPELINE_ENRICHMENTS` member has all
three fields resolvable. `npm run typecheck` → exit 0.

### Step 3: Create `scan-pending-pipelines.ts`

```ts
// packages/core/src/pipeline/scan-pending-pipelines.ts
import type { IRoostPlugin } from "@/types/plugin";
import { PIPELINE_ENRICHMENTS, type PipelineId, isVersionStale } from "@/lib/enrichments";
import { isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";
import { loadPipelineCache } from "@/pipeline/shared";

export interface PendingPipelineEntry { pending: number; stale: number; blocked: boolean; }
export interface PendingPipelinesResult {
  byPipeline: Record<string, PendingPipelineEntry>;   // keyed by PipelineId
  pendingItemIds: Record<string, string[]>;           // ids per pipeline (for auto-enqueue gating + dedup)
  scannedAt: number;
}

export function scanPendingPipelines(plugin: IRoostPlugin, now: number): PendingPipelinesResult { ... }
```
For each `def` in `PIPELINE_ENRICHMENTS`:
- If `!isCategoryPipelineActive(def.categoryMatches[0], plugin)` → `{ pending: 0, stale: 0, blocked: true }`,
  empty id list. (Gate covers toggled-off + LLM-down.)
- Else load `cache = loadPipelineCache(plugin.app.vault, def.cacheFile!)`; get
  `ids = def.gatherCandidateIds!(plugin.app, plugin.settings.syncFolder)`.
- `pending` = count of `id` where `!cache[id]` (never triaged) OR
  `cache[id].triage === def.pendingExtractVerdict && !cache[id].extraction` (triaged-to-extract,
  not yet extracted). Record those ids in `pendingItemIds[def.id]`.
- `stale` = count of `id` where `cache[id]` exists, is NOT pending, AND
  `isVersionStale(def.id, fmOf(id), def.schemaVersion, def.legacyAliases)` where `fmOf(id)` is the
  note frontmatter. (Stale and pending are mutually exclusive — stale requires a non-pending cache
  entry with a recorded-but-outdated version field.)

**Performance**: build the file index and load the embedding cache once per scan if possible; the
gather predicates already memoize the embedding cache (`shared.ts:199`) and `buildFileIndex` is
cheap. Do not add a debounce here — callers debounce at the trigger (`refreshPendingPipelines`).

`now` is passed in (the runtime forbids `Date.now()` in some contexts; the plugin can pass
`Date.now()` from the method in Step 4).

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Add `lastPendingPipelines` + `refreshPendingPipelines()` to the plugin

- `types/plugin.ts`: add `lastPendingPipelines: PendingPipelinesResult | null;` (next to
  `lastIncompleteScan`) and `refreshPendingPipelines(): void;`.
- `main.ts`: add the instance field `lastPendingPipelines: PendingPipelinesResult | null = null;`
  and implement:
  ```ts
  refreshPendingPipelines(): void {
    this.lastPendingPipelines = scanPendingPipelines(this, Date.now());
    this.triggerHubStateChange();
  }
  ```
  (Synchronous — `scanPendingPipelines` is sync. If you later make it async, keep the call sites
  `void`-safe.)
- In `onload`, add a dedicated deferred scan as its OWN statement (do NOT piggyback the
  `!hasAnyPlatform` 500ms block — that skips existing users):
  ```ts
  window.setTimeout(() => this.refreshPendingPipelines(), 4000);
  ```
  (Same 4s defer as the tweet-body catch-up, so first paint is never blocked.)

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Surface in the hub (badges + subline)

- `state.ts`: add `pendingPipelines: PendingPipelinesResult | null;` to `HubInputs` (next to
  `incompleteByCategory`, line 24). Add to `HubState.global` (the object at lines 54-58) a
  `pipelinesPending: { total: number; byPipeline: { id: PipelineId; pending: number; stale: number; blocked: boolean }[] }`.
  Add `derivePipelinesPending(input)`: re-apply the live gate via `input` (a pipeline `blocked` in
  the scan stays blocked; a pipeline with `pending+stale>0` and not blocked contributes). **Dedup
  the global `total` across pipelines** using `pendingItemIds` (an item matching two pipelines
  counts once in the headline total, but each pipeline's own badge keeps its full count). Wire it
  into the `global` object literal returned by `deriveHubState` (line 169) — note that function
  already returns a 4-key object `{ prereqs, platforms, global, embedding }`; add `pipelinesPending`
  inside `global`, leave the `embedding` sibling alone.
- `use-hub-state.ts`: in `gatherInputs` (now 3-arg, post-`d63718c`), add
  `pendingPipelines: plugin.lastPendingPipelines` right after the `incompleteByCategory` line (38).
  Do not touch the `embedding`/`embeddingInput` plumbing.
- `pipeline-rows.ts`: extend `PipelineRow` with `pending: number; stale: number;` and have
  `buildPipelineRows(flags, llm, pending?: PendingPipelinesResult | null)` set them per row
  (0 when absent/blocked).
- `pipelines-panel.tsx`: when `row.status === "active" && (row.pending + row.stale) > 0`, render a
  small badge like `"{pending} to enrich"` (+ a muted `"· {stale} stale"` when `stale > 0`). Rows
  that are `off` / `needs-llm` keep their existing status text and show NO number (never advertise
  work that can't run).
- `global-action-bar.tsx`: in `subParts` push `` `${total} to enrich` `` when
  `state.global.pipelinesPending.total > 0`, mirroring the `backfills` clause.
- `hub-body.tsx`: pass the pending map into `buildPipelineRows` at line 402
  (`buildPipelineRows(plugin.settings.pipelines, pipelineGate.llm, plugin.lastPendingPipelines)`).

**Verify**: `npm run typecheck` → exit 0. `npm test` → hub state tests pass.

### Step 6: Triggers + auto-enqueue

First, factor the auto-enqueue helper out of `hub-body.tsx`'s `runAllPipelines` so both the manual
button and the auto-triggers share it. Add an exported function (e.g. in a new
`packages/core/src/ui/hub/run-pending-pipelines.ts`, or as a plugin method — prefer a plugin method
so hooks can call it without importing hub UI):
```ts
// main.ts (IRoostPlugin)
async autoEnqueuePendingPipelines(): Promise<void> {
  const pending = this.lastPendingPipelines;
  if (!pending) return;
  for (const def of PIPELINE_ENRICHMENTS) {
    const entry = pending.byPipeline[def.id];
    if (!entry || entry.blocked || entry.pending <= 0) continue;
    if (!isCategoryPipelineActive(def.categoryMatches[0], this)) continue;
    void this.runJob(def.commandName, () =>
      def.runBackfill(this, { onLog: (m) => this.fireLog(`[${def.id}] ${m}`) }),
    );
  }
}
```
(`runJob` enqueues onto the serial queue, so the runs are FIFO and never concurrent. `runBackfill`
is idempotent via cache-presence — it only processes the new candidates.) Refactor
`runAllPipelines` in `hub-body.tsx` to call the same per-pipeline `runJob(...runBackfill...)` shape
(it already does; just ensure the manual path and `autoEnqueuePendingPipelines` don't double-run —
the manual button runs ALL active pipelines, the auto path runs only those with `pending>0`).

Then wire the triggers (each: recompute the count, THEN auto-enqueue):
- `use-smart-assign.ts` `runUnderGuard` (after `waitForMetadataQuiet`, ~line 174):
  `plugin.refreshPendingPipelines(); void plugin.autoEnqueuePendingPipelines();`
- `use-roost-platform-sync.ts` after the sync-complete log / `lastIncompleteScan` set:
  `plugin.refreshPendingPipelines(); void plugin.autoEnqueuePendingPipelines();`
  (Freshly synced items have no `embedded.category` yet, so most pipelines gain no candidates until
  Smart Assign embeds them — that's expected; this keeps the badge non-stale and catches
  tag-keyword/recipe-filed matches.)
- `use-roost-pipeline-rows.ts` `handleRunPipeline` after `plugin.fireDataRefresh()` (~line 43):
  `plugin.refreshPendingPipelines();` (recompute only — do NOT auto-enqueue here, the user just ran
  one deliberately).

Debounce `refreshPendingPipelines` against rapid successive triggers if you observe stacking
(trailing 250ms is acceptable); otherwise leave it synchronous.

**Verify**: `npm run typecheck` → exit 0. `npm test` → all pass.

### Step 7: Tests (see Test plan) and build

**Verify**: `npm test` → all pass incl. new tests. `npm run build` → succeeds.

## Test plan

- **`packages/core/src/pipeline/__tests__/scan-pending-pipelines.test.ts`** (new) — model after
  any existing pipeline `__tests__` that builds a fake `App` + frontmatter + the `obsidian` stub
  (e.g. `recipe-pipeline`'s tests, or `reconstruct-cache.test.ts` if present). Cases:
  (a) in-scope candidate with NO cache entry → counted pending;
  (b) cache entry `{triage:"skip", extraction:null}` → NOT pending (core anti-nag assertion);
  (c) `{triage:"recipe", extraction:<set>}` + `enrichment_v_recipe === schemaVersion` → not pending, not stale;
  (d) `{triage:"recipe", extraction:null}` (triaged-to-extract) → counted pending;
  (e) cache entry present + `enrichment_v_<id> < schemaVersion` → stale, not pending (mutually exclusive);
  (f) gate off (toggled or LLM down) → `blocked:true`, count 0;
  (g) item whose `embedded.category` does not match → not a candidate → not counted.
- **`packages/core/src/pipeline/__tests__/gather-candidate-ids.test.ts`** (new) — parametrized over
  all 7 pipelines: assert `gather*CandidateIds` returns EXACTLY the roostIds that the pipeline's
  `gatherCandidates` would gather (the "count must not lie" invariant). Drive off a fixture
  embedding cache (use `__resetEmbeddingCache()` from `shared.ts`). Include a places case proving
  the substring semantics and a recipe case proving the filed-category branch.
- **`packages/core/src/ui/hub/__tests__/state.test.ts`** (extend) — `derivePipelinesPending`: null
  input → total 0; mixed pending + blocked → total sums only active; an item matching two pipelines
  → counted once in `total` but in both per-pipeline counts (dedup assertion).
- **`packages/core/src/ui/hub/__tests__/pipeline-rows.test.ts`** (extend if present, else add) —
  `buildPipelineRows` threads `pending`/`stale`; off/needs-llm rows carry status, the panel
  suppresses the number.
- **`packages/core/src/lib/__tests__/enrichments.test.ts`** (extend) — every
  `PIPELINE_ENRICHMENTS` member has a resolvable `cacheFile`, `gatherCandidateIds`, and
  `pendingExtractVerdict`.
- Verification: `npm test` → all pass including the new tests; `npm run typecheck` → exit 0.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; the new `scan-pending-pipelines` + `gather-candidate-ids` tests exist and pass
- [ ] `npm run build` produces `dist/main.js` + `dist/styles.css`
- [ ] A pipeline with a `skip`-verdict cache entry contributes 0 pending (anti-nag test green)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- Any pipeline's `CategoryPipelineConfig.extractVerdict` is not a simple string literal, or a
  pipeline does not delegate to `runCategoryPipeline` (the cache/terminal model would not apply).
- `gatherCandidates` cannot be cleanly refactored to consume an id-only matcher without changing
  behavior (e.g. it interleaves side effects you can't separate) — report which pipeline.
- The `media-pipeline` extract verdict or discovery predicate is ambiguous (it has two gather
  modes) — report what you found rather than guessing.
- Auto-enqueue would run a pipeline that is gated off or LLM-down (it must not) — the gate check
  is wrong; stop.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Forever-retry items**: pipelines with `onTriageFailure:"leave"` (recipe) or
  `onExtractFailure:"retry"` keep a permanently-failing item in the pending set (a run *would*
  retry it). This is faithful but can show a small non-zero badge that never clears. If users
  report "badge says N but a run does nothing useful," add a per-item attempt cap to the cache
  (mirror media-backfill's `MAX_BACKFILL_ATTEMPTS` / `isDeadSkip`) so a thrice-failed item gets a
  terminal cache entry. Deferred intentionally.
- **Cache-file loss**: the per-pipeline reconstruct fns only restore successful extractions, so a
  deleted cache file makes previously-skipped items re-count until a full re-run re-skips them. The
  badge over-counts in that degraded mode (nudge, not silence). Acceptable for v1; if it bites,
  surface a one-time "rebuild caches" affordance instead of a phantom backlog.
- **Plan 053** makes the 5 embedded-only pipelines gather by the user-filed `roost_category`. When
  it lands, those pipelines' `gather*CandidateIds` gain a filed branch and this plan's count
  automatically reflects user-filed items — no change needed here.
- **Plan 054** adds cancellation; the badge already handles a cancelled run correctly (residual
  pending shows on the next `refreshPendingPipelines`).
- Reviewer should scrutinize: the `gather*CandidateIds`-vs-`gatherCandidates` parity test (the
  count is only honest if they match), and the global-total dedup.
