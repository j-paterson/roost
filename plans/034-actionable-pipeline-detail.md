# Plan 034: Make every pipeline's saved intent actionable — source link + deep links + media chip fix

> **Executor instructions**: Follow step by step; run every verification and
> confirm the expected result before moving on. Honor STOP conditions. Update the
> `plans/README.md` row when done.

## Base setup (already done for you)

You are in **/tmp/roost-merge** on branch **`advisor/034-actionable-pipelines`**
(off the integrated `deploy-all`, base `d31df4f`). `node_modules` is installed.
Start every shell command with `cd /tmp/roost-merge`. Do NOT run git
branch/checkout/commit/push.

## Why this matters

A pipeline audit (against the product thesis "a bookmark is a saved intent;
surface what makes it actionable") found the system's biggest miss: **every
enrichment correctly extracts what the user needs, then drops them at a read-only
summary instead of a button.** Concretely:

- There is **no "watch/open the source" link** in any detail panel except recipe
  (and even recipe's link is a bio URL, not the saved post). A workout, place,
  product, etc. card gives no way back to the clip the user saved.
- There is **zero maps deep-link anywhere in the codebase** — Places resolves
  exact coordinates (`place_lat`/`place_lng`) and then never lets you navigate.
- Media/product "where" fields (`Netflix`, `Amazon`) are inert text, not links.
- A **media-only chip bug**: the gallery card's chip gate checks
  `enrichment_v_mediaExtraction`, but the media pipeline stamps `pipeline_v_media`
  — so a freshly-run media item's declared chips (rating/genre/where) silently
  never render.

This plan adds a **shared action affordance to every detail renderer** — a
"Watch source" link plus an intent-specific deep link (Open in Maps for places,
Play/Open for media, search-to-buy for products) — and fixes the media chip
gate. It uses **search-fallback URLs** so it needs no new resolved data;
upgrading media to *canonical* Letterboxd/Spotify links is the follow-on
**plan 035**.

## Current state (verbatim at base)

**The renderer gets only `{type, extraction}` — no source URL** (`views/pipeline-details.ts:102-121`):

```ts
export function renderPipelineDetail(infoEl: HTMLElement, hit: PipelineHit): void {
  const meta = PIPELINE_META[hit.type];
  const section = infoEl.createDiv({ cls: "roost-pipeline-section" });
  ...
  const content = section.createDiv({ cls: "roost-pipeline-section-content" });
  switch (hit.type) {
    case "recipe":   renderRecipe(content, hit.extraction as RecipeExtraction); break;
    case "place":    renderPlace(content, hit.extraction as PlaceExtraction); break;
    case "media":    renderMedia(content, hit.extraction as MediaExtraction); break;
    case "product":  renderProduct(content, hit.extraction as ProductExtraction); break;
    case "workout":  renderWorkout(content, hit.extraction as WorkoutExtraction); break;
    case "tutorial": renderTutorial(content, hit.extraction as TutorialExtraction); break;
    case "home":     renderHome(content, hit.extraction as HomeExtraction); break;
  }
}
```

`PipelineHit` is `{ type, extraction }` (`pipeline-details.ts:28-31`); none of the
extraction types carry the note's `url`. The **only** caller with the note's
frontmatter is `views/gallery-expanded-extras.ts:108-115`:

```ts
  if (expandedId) {
    const pipelineHit = getPipelineData(expandedId);
    if (pipelineHit) {
      const pipelineEl = domHost.createDiv();
      renderPipelineDetail(pipelineEl, pipelineHit);
      extraEls.push(pipelineEl as HTMLElement);
    }
  }
```

That function has `entry: BasesEntry` and already imports `safeGetValue` from
`@/lib/bases-entry` (line 8). `safeGetValue(entry, "note.url")` is the source URL
(same read used in `media-list.ts:128`).

**The one existing anchor pattern to generalize** (`renderRecipe`, `pipeline-details.ts:276-286`):

```ts
  if (data.recipeLink) {
    const linkRow = el.createDiv({ cls: "roost-pipeline-kv" });
    linkRow.createEl("span", { cls: "roost-pipeline-kv-label", text: "Recipe site" });
    const linkEl = linkRow.createEl("a", {
      cls: "roost-pipeline-recipe-link",
      text: data.recipeLink.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      href: data.recipeLink,
    });
    linkEl.setAttr("target", "_blank");
    linkEl.setAttr("rel", "noopener");
  }
```

Each `render*` ends cleanly (an action row slots at the END): `renderRecipe`
(244-287), `renderPlace` (289-314, has `data.lat`/`data.lng`/`data.address`/
`data.name`), `renderMedia` (316-328), `renderProduct` (330-342, has
`data.brand`/`data.name`), `renderWorkout` (344-368), `renderTutorial` (370-392),
`renderHome` (394-418). Helpers at 211-240: `kvRow` (skips empty/"Unknown"/
"Other"), `pillList`, `numberedList`, `capitalize`.

**`PlaceExtraction` already carries coords** (`types/roost.d.ts:79-93`): `lat?:
number|null`, `lng?: number|null`, `address: string|null`, `name`, `city`,
`country` — so the Places maps link needs no type change.

**The media chip gate** (`views/gallery-cards.ts:213-229`):

```ts
    for (const enrichment of ENRICHMENTS) {
      if (!enrichment.chips?.length) continue;
      const versionField = `enrichment_v_${enrichment.id}`;
      const versionValue = safeGetValue(entry, `note.${versionField}`);
      const hasVersion = versionValue != null && versionValue !== "";
      if (!hasVersion) continue;
      for (const chip of enrichment.chips) { ... renderChip(...) }
    }
```

The media enrichment's id is `mediaExtraction` but it stamps
`pipeline_v_media` (`media-pipeline.ts:47,414`) and declares
`legacyAliases: ["pipeline_v_media"]` (line 811). `EnrichmentDef.legacyAliases`
exists on every enrichment. The gate above ignores aliases → media chips never
satisfy `hasVersion` on a fresh run.

**Reusable URL builder** (`views/pipeline-views/watchable-url.ts:33`, exported):
`watchableUrl(row: { subcategory, title, year?, tmdbId?, tmdbType?, anilistId? }) →
{ url, kind: "canonical"|"search" } | null` — returns a **search** URL when no
ids (works from title + the **plural** subcategory: `films`/`series`/`anime`/
`documentaries`). `detectPlatformFromUrl(url)` (`lib/extract.ts:401`) → `"tiktok"
|"twitter"|"other"`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Baseline | `cd /tmp/roost-merge && npm test 2>&1 \| tail -3` | record passing count first |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | ≥ baseline, all pass |
| Filter | `npm test -- pipeline-details` | passes |

`strictNullChecks`+`noImplicitAny`; `@/`→`packages/core/src/`. No `test:e2e`.

## Scope

**In scope:**
- `packages/core/src/views/pipeline-details.ts` — the 3rd `source` param, the
  `renderActionLinks` + `buildMapsUrl` helpers, the per-renderer calls.
- `packages/core/src/views/gallery-expanded-extras.ts` — thread `note.url` (+
  `author`, `roost_subcategory`) into `renderPipelineDetail`.
- `packages/core/src/views/gallery-cards.ts` — make the chip gate alias-aware.
- `packages/core/src/styles/bases-view.css` — a `.roost-pipeline-actions` rule.
- Tests: `packages/core/src/views/__tests__/pipeline-details.test.ts` (extend).
- `plans/README.md` — status row.

**Out of scope:** widening `MediaExtraction` / carrying resolved
spotify/tmdb/anilist ids (that is **plan 035** — here media uses *search*
URLs only); `places-map.ts`; the pipeline `*-pipeline.ts` files (no extraction
changes); the compact `getCompactChips` text line (leave as-is).

## Steps

### Step 1: Thread the note's source through the renderer

In `pipeline-details.ts`, define a small type and extend the signatures:

```ts
export interface PipelineSource {
  url: string | null;
  author: string | null;
  subcategory: string | null; // note.roost_subcategory (plural, e.g. "films")
}
```

- Change `renderPipelineDetail(infoEl, hit, source?: PipelineSource)` and pass
  `source` as a 2nd arg into every `render*` call in the switch.
- Add `source?: PipelineSource` as the last param of each `render*` function.
- In `gallery-expanded-extras.ts:108-115`, build and pass it:
  ```ts
  const source = {
    url: safeGetValue(entry, "note.url")?.toString() ?? null,
    author: safeGetValue(entry, "note.author")?.toString() ?? null,
    subcategory: safeGetValue(entry, "note.roost_subcategory")?.toString() ?? null,
  };
  renderPipelineDetail(pipelineEl, pipelineHit, source);
  ```
  (`safeGetValue` is already imported there.)

**Verify:** `npm run typecheck` → exit 0 (renderers ignore `source` for now).

### Step 2: Add the shared `renderActionLinks` + `buildMapsUrl` helpers

Next to the other helpers (`pipeline-details.ts` ~211-240). Import
`detectPlatformFromUrl` from `@/lib/extract` and `watchableUrl` from
`@/views/pipeline-views/watchable-url`.

```ts
/** Build a Google Maps URL from coords (preferred) or a name/address query. */
function buildMapsUrl(o: { lat?: number | null; lng?: number | null; address?: string | null; name?: string | null; city?: string | null; country?: string | null }): string | null {
  if (typeof o.lat === "number" && typeof o.lng === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}`;
  }
  const q = [o.name, o.address, o.city, o.country].filter(Boolean).join(" ").trim();
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

/** Append a "roost-pipeline-actions" row with a Watch-source link + an optional
 *  intent-specific deep link. Both open in a new tab and stop the click from
 *  toggling the expanded card. */
function renderActionLinks(
  el: HTMLElement,
  source?: PipelineSource,
  deepLink?: { label: string; url: string; icon?: string } | null,
): void {
  const links: { label: string; url: string; icon?: string }[] = [];
  if (deepLink) links.push(deepLink);
  if (source?.url) {
    const platform = detectPlatformFromUrl(source.url);
    const label = platform === "tiktok" ? "Watch on TikTok" : platform === "twitter" ? "View on X" : "Open source";
    links.push({ label, url: source.url, icon: "↗" });
  }
  if (links.length === 0) return;
  const row = el.createDiv({ cls: "roost-pipeline-actions" });
  for (const l of links) {
    const a = row.createEl("a", { cls: "roost-pipeline-action", href: l.url, text: (l.icon ? l.icon + " " : "") + l.label });
    a.setAttr("target", "_blank");
    a.setAttr("rel", "noopener noreferrer");
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.open(l.url, "_blank", "noopener"); });
  }
}
```

(The click handler mirrors `media-where-cell.ts` so the action doesn't bubble to
the card's expand/collapse handler.)

**Verify:** `npm run typecheck` → exit 0.

### Step 3: Call `renderActionLinks` at the end of every renderer

Each `render*` now ends with a `renderActionLinks(el, source, deepLink)` call:

- **renderPlace** (end, after line 313):
  ```ts
  const mapsUrl = buildMapsUrl({ lat: data.lat, lng: data.lng, address: data.address, name: data.name, city: data.city, country: data.country });
  renderActionLinks(el, source, mapsUrl ? { label: "Open in Maps", url: mapsUrl, icon: "📍" } : null);
  ```
- **renderMedia** (end, after line 327): pick a search deep link by subcategory.
  ```ts
  let mediaLink: { label: string; url: string; icon?: string } | null = null;
  const sub = (source?.subcategory ?? data.mediaType ?? "").toLowerCase();
  if (sub === "music") {
    const q = encodeURIComponent([data.title, data.creator].filter(Boolean).join(" "));
    if (q) mediaLink = { label: "Search on Spotify", url: `https://open.spotify.com/search/${q}`, icon: "🎧" };
  } else {
    const w = watchableUrl({ subcategory: sub, title: data.title } as any);
    if (w) mediaLink = { label: w.kind === "canonical" ? "Open" : "Find it", url: w.url, icon: "▶" };
  }
  renderActionLinks(el, source, mediaLink);
  ```
  (Use `source.subcategory` — it's the **plural** form `watchableUrl` matches;
  `data.mediaType` may be singular. `watchableUrl` returns a search URL with no
  ids, which is all we have until plan 035.)
- **renderProduct** (end, after line 341):
  ```ts
  const q = encodeURIComponent([data.brand, data.name].filter(Boolean).join(" ") + " buy");
  renderActionLinks(el, source, q ? { label: "Find where to buy", url: `https://www.google.com/search?q=${q}`, icon: "🛒" } : null);
  ```
- **renderRecipe** (end, after line 286), **renderWorkout**, **renderTutorial**,
  **renderHome**: `renderActionLinks(el, source);` (source link only — these have
  no natural intent-specific deep link; recipe keeps its existing `recipeLink`
  block above).

**Verify:** `npm run typecheck` → exit 0; `npm test -- pipeline-details` passes
(after Step 6's test update).

### Step 4: Make the chip gate alias-aware (media chip fix)

In `gallery-cards.ts:218-221`, after computing `hasVersion` from
`enrichment_v_${enrichment.id}`, fall back to the enrichment's `legacyAliases`:

```ts
      const versionField = `enrichment_v_${enrichment.id}`;
      let versionValue = safeGetValue(entry, `note.${versionField}`);
      let hasVersion = versionValue != null && versionValue !== "";
      if (!hasVersion && enrichment.legacyAliases) {
        for (const alias of enrichment.legacyAliases) {
          const v = safeGetValue(entry, `note.${alias}`);
          if (v != null && v !== "") { hasVersion = true; break; }
        }
      }
      if (!hasVersion) continue;
```

This makes media's `pipeline_v_media` satisfy the gate so its declared chips
(`media_rating`/`media_genre`/`media_where`) render — for both freshly-run and
legacy items — without changing what the pipeline writes.

**Verify:** `npm run typecheck` → exit 0.

### Step 5: CSS for the actions row

In `packages/core/src/styles/bases-view.css`, add near the other
`.roost-pipeline-*` rules:

```css
.roost-pipeline-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.roost-pipeline-action {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 999px; font-size: 12px;
  background: var(--background-modifier-hover); color: var(--text-accent);
  text-decoration: none; border: 1px solid var(--background-modifier-border);
}
.roost-pipeline-action:hover { background: var(--background-modifier-active-hover); text-decoration: none; }
```

**Verify:** `npm run build` → exit 0 (CSS compiles into `dist/styles.css`).

### Step 6: Tests

Extend `packages/core/src/views/__tests__/pipeline-details.test.ts` (the
`obsidian` stub is auto-mocked). Add:
- `renderPipelineDetail(el, { type:"place", extraction: makePlace({lat:45.8,lng:9.0}) }, { url:"https://www.tiktok.com/@x/video/1", author:"x", subcategory:"places" })` → asserts a `.roost-pipeline-actions a` with `href` containing `google.com/maps` AND one with the tiktok url; the "Watch on TikTok" label.
- A place with no coords but a name/city → maps link uses the `query=<encoded>` form.
- A media place... a `type:"product"` with brand+name → an action link whose href contains `google.com/search` and `buy`.
- A renderer with `source` undefined → no `.roost-pipeline-actions` row.
- `buildMapsUrl` unit cases (coords vs query vs null). Export `buildMapsUrl` (and `renderActionLinks` if you test it directly) for the unit test, or test via `renderPipelineDetail`.
- Update any existing call to `renderPipelineDetail(el, hit)` in this test file for the new optional 3rd param (it's optional, so existing calls still compile — confirm).

**Verify:** `npm test -- pipeline-details` and `npm test` → all pass.

## Done criteria

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0, ≥ baseline; new action-link + buildMapsUrl tests pass.
- [ ] `npm run build` exits 0; `grep -c "roost-pipeline-actions" dist/styles.css` ≥ 1.
- [ ] `grep -n "renderActionLinks\|buildMapsUrl" packages/core/src/views/pipeline-details.ts` → present and called in all 7 renderers.
- [ ] `grep -n "legacyAliases" packages/core/src/views/gallery-cards.ts` → present in the chip gate.
- [ ] `grep -n "renderPipelineDetail(pipelineEl, pipelineHit, " packages/core/src/views/gallery-expanded-extras.ts` → source threaded.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The cited excerpts don't match (drift) — STOP.
- Threading `source` would require touching `loadPipelineData`/the cache loader
  (it shouldn't — the seam is `gallery-expanded-extras.ts`, the only caller with
  the entry) — STOP and report.
- `watchableUrl`'s import pulls in a heavy/DOM module that breaks the test env —
  if so, inline a Letterboxd/AniList **search** URL instead of importing, and note it.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- Media currently gets **search** deep links (no resolved ids on the extraction).
  **Plan 035** widens `MediaExtraction` to carry the resolved
  spotify/tmdb/anilist ids through both load paths and upgrades `renderMedia` to
  *canonical* Letterboxd/Spotify links — this plan's `renderActionLinks` call
  site is where that swap lands.
- `buildMapsUrl` is also the seam for a future "View on map" jump into
  `places-map.ts`; keep it pure.
- Reviewer focus: the click handler must `stopPropagation` (so action clicks
  don't toggle the card); the media link must use the **plural** `subcategory`,
  not the singular `mediaType`; the chip-gate alias fallback must not change
  behavior for the 6 already-correct pipelines.
