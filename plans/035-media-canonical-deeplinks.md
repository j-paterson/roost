# Plan 035: Carry resolved media ids to the card so renderMedia builds *canonical* deep links (not just search)

> **Executor instructions**: Follow step by step; run every verification and
> confirm the expected result before moving on. Honor STOP conditions. Update the
> `plans/README.md` row when done.

## Base setup

This plan **executes AFTER plan 034 lands.** 034 adds, at the end of
`renderMedia`, a `renderActionLinks(el, source, mediaLink)` call where
`mediaLink` is built from a **search** URL (`watchableUrl({ subcategory, title })`
with no ids, or a Spotify *search* URL for music). 035 upgrades that same call
site to a **canonical** Letterboxd/AniList/Spotify link when resolved ids are
present, by carrying those ids through to `renderMedia`.

- Branch off the post-034 base: either `advisor/034-actionable-pipelines` once
  034 is verified locally, or the integrated `deploy-all` once 034 has merged.
  The base will be **post-034** (034's `pipeline-details.ts` edits — the
  `PipelineSource` type, `renderActionLinks`, and the `renderMedia` action-link
  block — must already be present). Confirm with the drift-check in Step 0.
- You are in **/tmp/roost-merge**. `node_modules` is installed. Start every shell
  command with `cd /tmp/roost-merge`. Do NOT run git branch/checkout/commit/push.

> **Drift warning (read this).** The recon line numbers below were captured at
> base `d31df4f`. An executor was concurrently editing `pipeline-details.ts` for
> plan 034, so its line numbers WILL have shifted by the time you run. **Locate
> code by symbol/grep, not by line number**, and run the Step 0 drift-check
> before editing. `media-pipeline.ts`, `types/roost.d.ts`,
> `views/pipeline-views/watchable-url.ts`, `media-where-cell.ts`, and
> `media-list.ts` were NOT being edited — their cited excerpts are reliable.

## Why this matters

The media pipeline already does the hard part: it resolves canonical deep-link
handles — Spotify track id (free, from TikTok's `tt2dsp` mapping), TMDB id +
type (drives Letterboxd), AniList id (Anime) — and **writes them to
frontmatter** (`media_spotify_id`, `media_tmdb_id`, `media_tmdb_type`,
`media_anilist_id`, `media_year`). The Media *list* view already turns those ids
into canonical chips (`media-where-cell.ts` → `watchableUrl`).

But the **gallery expanded card** can't: its `MediaExtraction` type omits all
five ids, so 034's `renderMedia` can only call `watchableUrl({ subcategory,
title })` — which always returns a **search** URL — and a Spotify **search** URL
for music. So a film Roost resolved to an exact Letterboxd page still sends the
user to a search box from the card, while the list view links straight to the
film. 035 closes that gap: it threads the five ids onto `MediaExtraction`,
carries them through **both** cache load paths, and lets `renderMedia` emit the
canonical `https://letterboxd.com/tmdb/{id}/` / `https://anilist.co/anime/{id}` /
`https://open.spotify.com/track/{id}` link when the id exists, falling back to
034's search URL when it doesn't.

## Current state (verbatim at base `d31df4f`; symbol-locate, don't trust line #s)

### 1. The canonical `MediaExtraction` is missing the five ids

`types/roost.d.ts:95-98` — imported by `pipeline-details.ts`:

```ts
export interface MediaExtraction {
  mediaType: string; title: string; creator: string;
  genre: string; description: string; rating: string | null; where: string | null;
}
```

MISSING: `spotifyId`, `tmdbId`, `tmdbType`, `anilistId`, `year`.

### 2. There is a SECOND, narrower `MediaExtraction` local to media-pipeline.ts

`media-pipeline.ts:53-62` — a separate local interface (NOT the roost.d.ts one);
`mediaType` is a strict union `MediaType`, and it also lacks the five ids:

```ts
// (local interface in media-pipeline.ts, ~line 53)
  mediaType: MediaType;
  title: string;
  creator: string;
  genre: string;
  description: string;
  rating: string | null;
  where: string | null;
}
```

`reconstructMediaCache` (Step 5/4b below) returns this local shape. **Both** must
end up carrying the ids OR you cast — see Step 1's decision note. Project runs
`strictNullChecks` + `noImplicitAny` (`npm run typecheck`).

### 3. The ids live on the frontmatter under these names

`media-pipeline.ts` `MEDIA_FIELDS` (~398-411) + `writeMediaToBookmark` (~427-456)
write them:

```ts
export const MEDIA_FIELDS = {
  // ...
  spotifyId: "media_spotify_id",
  tmdbId: "media_tmdb_id",
  tmdbType: "media_tmdb_type",
  anilistId: "media_anilist_id",
  year: "media_year",
  // ...
} as const;
```

### 4. In the CACHE, the ids are NOT on `entry.extraction` — they're on sibling sub-objects

`media-pipeline.ts` `CacheEntry` (~87-92):

```ts
interface CacheEntry {
  triage: "media" | "skip";
  extraction: MediaExtraction | null;
  playback?: PlaybackResolution;   // .spotifyId
  deepLink?: DeepLinkResolution;   // .tmdbId, .tmdbType, .anilistId
}
```

`PlaybackResolution = { spotifyId: string|null; resolvedAt }`,
`DeepLinkResolution = { tmdbId: string|null; tmdbType: "movie"|"tv"|null;
anilistId: string|null; resolvedAt; attempts; lastError? }` (~64-85). The
`media_year` value isn't on either sub-object in cache — it's derived at write
time (`canonicalizeTitle(extraction.title).year`); from a populated cache you
won't have it unless you also derive it, so for the cache path **year is
best-effort** (leave `null` if not readily available — `watchableUrl` treats
`year` as optional, it only sharpens the *search* URL, never the canonical one).

### 5. TWO load paths feed the gallery's `pipelineLookup` — BOTH must carry the ids

**(a) `loadPipelineData`** in `pipeline-details.ts` (~51-62) reads the generic
`PipelineCacheEntry` and stores ONLY `entry.extraction`:

```ts
export function loadPipelineData(vault: Vault): void {
  pipelineLookup = new Map();
  for (const [type, file, triageMatch] of CACHE_FILES) {
    const cache = loadPipelineCache<PipelineCacheEntry>(vault, file);
    for (const [id, entry] of Object.entries(cache)) {
      if (entry.triage === triageMatch && entry.extraction) {
        pipelineLookup.set(id, { type, extraction: entry.extraction });
      }
    }
  }
}
```

`PipelineCacheEntry` (`types/roost.d.ts:136-139`) is `{ triage; extraction }` —
it has NO `playback`/`deepLink`. So for the media cache file the ids are present
on disk (on `playback`/`deepLink`) but **dropped** here unless this loop reads
them off the raw entry and merges them into the `MediaExtraction` it stores.

**(b) `reconstructMediaCache`** in `media-pipeline.ts` (~819-843) rebuilds the
extraction from frontmatter when the cache file is wiped — and **drops the five
ids**:

```ts
out[id] = {
  triage: "media",
  extraction: {
    title: String(fm.media_title ?? "Unknown"),
    creator: typeof fm.media_creator === "string" ? fm.media_creator : "",
    mediaType: typeof fm.roost_subcategory === "string" ? fm.roost_subcategory.toLowerCase() as MediaType : "other",
    genre: typeof fm.media_genre === "string" ? fm.media_genre : "",
    rating: typeof fm.media_rating === "string" ? fm.media_rating : null,
    where: typeof fm.media_where === "string" ? fm.media_where : null,
    description: typeof fm.media_description === "string" ? fm.media_description : "",
    // ← no spotifyId / tmdbId / tmdbType / anilistId / year
  },
};
```

### 6. Reference: how the list view reads ids + builds canonical URLs

- `watchableUrl(row)` (exported, `views/pipeline-views/watchable-url.ts:33`)
  returns `{ url, kind: "canonical"|"search" } | null`. Canonical when ids:
  Anime → `https://anilist.co/anime/{anilistId}`; Films/Documentaries with a
  `tmdbId` → `https://letterboxd.com/tmdb/{tmdbId}/`. **Series is films-only's
  exception — it ALWAYS returns a search URL even with a `tmdbId`** (Letterboxd's
  TMDB redirect is films-only; verified pre-merge, see the file's comment). It
  matches the **plural lowercase** subcategory (`films`/`series`/`anime`/
  `documentaries`); anything else returns `null`.
- Spotify canonical track URL: `https://open.spotify.com/track/{spotifyId}`
  (used as the embed `/embed/track/{id}` in `media-where-cell.ts:140`); the
  search form is `https://open.spotify.com/search/{query}`
  (`media-where-cell.ts:34`).
- `media-list.ts buildRows` (~114-137) + helpers `asNullableString` /
  `asTmdbType` / `asNullableNumber` / `parseNullableId` (~52-91) are the
  reference for reading the five fields from frontmatter — **mirror them** in
  `reconstructMediaCache`. Note `parseNullableId` returns `undefined` when the
  key is absent and `null` when present-but-empty; `reconstructMediaCache` can
  collapse both to `null`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Baseline | `cd /tmp/roost-merge && npm test 2>&1 \| tail -3` | record passing count first |
| Typecheck | `npm run typecheck` | exit 0, no output |
| Tests | `npm test` | ≥ baseline, all pass |
| Filter | `npm test -- pipeline-details media-pipeline` | passes |

`strictNullChecks` + `noImplicitAny`; `@/` → `packages/core/src/`. No `test:e2e`.

## Scope

**In scope:**
- `packages/core/src/types/roost.d.ts` — add the five optional id fields to
  `MediaExtraction`.
- `packages/core/src/pipeline/media-pipeline.ts`:
  - the local `MediaExtraction` interface (~53-62) — widen OR cast (Step 1).
  - `reconstructMediaCache` (~819-843) — read the five ids from frontmatter.
- `packages/core/src/views/pipeline-details.ts`:
  - `loadPipelineData` (~51-62) — merge `playback`/`deepLink` ids into the stored
    media extraction.
  - `renderMedia` — upgrade 034's `mediaLink` to canonical when an id is present.
- Tests: `packages/core/src/views/__tests__/pipeline-details.test.ts` and/or
  `media-pipeline.test.ts` (extend).
- `plans/README.md` — status row.

**Out of scope (already exists / not this plan):**
- The 034 affordance scaffolding — `PipelineSource`, `renderActionLinks`,
  `buildMapsUrl`, the source-threading in `gallery-expanded-extras.ts`, the chip
  gate fix, the CSS. **Do NOT re-add any of it.** 035 only swaps the *content* of
  the `mediaLink` 034 already builds.
- `media-where-cell.ts` / `media-list.ts` / `watchable-url.ts` — these already
  do the canonical thing; reuse, don't edit.
- Writing new frontmatter, changing what the pipeline resolves, the maps/
  product/recipe action links.

## Steps

### Step 0: Drift-check the post-034 base (do this first)

Confirm 034 is present and locate the symbols you'll edit:

```sh
cd /tmp/roost-merge
grep -n "renderActionLinks\|PipelineSource\|watchableUrl" packages/core/src/views/pipeline-details.ts
grep -n "function renderMedia" packages/core/src/views/pipeline-details.ts
grep -n "spotifyId\|tmdbId\|anilistId\|media_spotify_id\|media_tmdb_id" packages/core/src/views/pipeline-details.ts
```

- `renderActionLinks` + `PipelineSource` present → 034 landed, proceed.
- A `mediaLink` / `watchableUrl(...)` block inside `renderMedia` present → that's
  the call site 035 upgrades.
- If `renderActionLinks`/`PipelineSource` are **absent**, the base is pre-034 —
  **STOP** (this plan builds on 034).
- If `renderMedia` already references `data.tmdbId` / `data.spotifyId` — 035 is
  already (partly) applied; re-baseline and only fill gaps.

**Verify:** you can name the exact `renderMedia` block (the `mediaLink`
assignment) you will change, and `MediaExtraction` in `roost.d.ts` still lacks
the five ids (`grep -n "spotifyId" packages/core/src/types/roost.d.ts` → no hit).

### Step 1: Add the five ids to `MediaExtraction` (both definitions)

**1a — canonical type** (`types/roost.d.ts`, the `MediaExtraction` interface):
add five **optional** fields (optional so no other producer/consumer breaks, and
so old cache JSON without them still satisfies the type):

```ts
export interface MediaExtraction {
  mediaType: string; title: string; creator: string;
  genre: string; description: string; rating: string | null; where: string | null;
  // Resolved canonical deep-link ids (carried from the pipeline cache /
  // frontmatter so the gallery card can build canonical links, not just search).
  spotifyId?: string | null;
  tmdbId?: string | null;
  tmdbType?: "movie" | "tv" | null;
  anilistId?: string | null;
  year?: number | null;
}
```

**1b — local interface** (`media-pipeline.ts`, ~53-62): pick ONE, recommend
widening for symmetry:
- **Recommended — widen it too** with the same five optional fields (keep
  `mediaType: MediaType`). Then `reconstructMediaCache` can set the ids without a
  cast. Cheapest for `noImplicitAny`/`strictNullChecks`.
- **Alternative** — leave the local interface as-is and have
  `reconstructMediaCache` build the wider object then `as MediaExtraction`-cast on
  return. Avoid unless widening causes an unexpected break elsewhere.

Whichever you choose, the function's declared return type
(`Record<string, { triage: "media"; extraction: MediaExtraction }>`) must accept
the five new keys without `any`.

**Verify:** `npm run typecheck` → exit 0 (nothing reads the new fields yet, so
this is purely additive).

### Step 2: Carry the ids in `loadPipelineData` (cache path)

In `pipeline-details.ts` `loadPipelineData`, the media cache file's raw entries
carry `playback`/`deepLink`, but `PipelineCacheEntry` doesn't type them. Read
them off the raw entry and merge into the stored `MediaExtraction` — only for the
`"media"` type (the other six caches have no such sub-objects).

A minimal, type-safe approach (do NOT change the generic
`loadPipelineCache<PipelineCacheEntry>` call — just read extra keys behind a
narrow local type):

```ts
// near the top of pipeline-details.ts, a structural shape for the media cache's
// extra sub-objects (mirrors media-pipeline.ts PlaybackResolution/DeepLinkResolution):
interface MediaCacheExtras {
  playback?: { spotifyId: string | null };
  deepLink?: { tmdbId: string | null; tmdbType: "movie" | "tv" | null; anilistId: string | null };
}
```

Then inside the loop, when `type === "media"`, merge:

```ts
if (entry.triage === triageMatch && entry.extraction) {
  let extraction = entry.extraction;
  if (type === "media") {
    const ex = entry as PipelineCacheEntry & MediaCacheExtras;
    extraction = {
      ...(extraction as MediaExtraction),
      spotifyId: ex.playback?.spotifyId ?? (extraction as MediaExtraction).spotifyId ?? null,
      tmdbId: ex.deepLink?.tmdbId ?? (extraction as MediaExtraction).tmdbId ?? null,
      tmdbType: ex.deepLink?.tmdbType ?? (extraction as MediaExtraction).tmdbType ?? null,
      anilistId: ex.deepLink?.anilistId ?? (extraction as MediaExtraction).anilistId ?? null,
    } as MediaExtraction;
  }
  pipelineLookup.set(id, { type, extraction });
}
```

(`year` isn't in the cache sub-objects — leave it to whatever's already on the
extraction, else `null`. The `?? extraction.spotifyId` fallbacks preserve any id
that's somehow already on the extraction.)

**Verify:** `npm run typecheck` → exit 0. `grep -n "playback\|deepLink" packages/core/src/views/pipeline-details.ts`
→ present in `loadPipelineData`.

### Step 3: Carry the ids in `reconstructMediaCache` (cache-wiped path)

In `media-pipeline.ts` `reconstructMediaCache`, read the five frontmatter fields
into the rebuilt `extraction`, mirroring `media-list.ts`'s helpers. Use
`MEDIA_FIELDS` constants for the key names (don't hardcode strings):

```ts
out[id] = {
  triage: "media",
  extraction: {
    title: String(fm.media_title ?? "Unknown"),
    creator: typeof fm.media_creator === "string" ? fm.media_creator : "",
    mediaType: typeof fm.roost_subcategory === "string" ? fm.roost_subcategory.toLowerCase() as MediaType : "other",
    genre: typeof fm.media_genre === "string" ? fm.media_genre : "",
    rating: typeof fm.media_rating === "string" ? fm.media_rating : null,
    where: typeof fm.media_where === "string" ? fm.media_where : null,
    description: typeof fm.media_description === "string" ? fm.media_description : "",
    spotifyId: readNullableIdFm(fm, MEDIA_FIELDS.spotifyId),
    tmdbId: readNullableIdFm(fm, MEDIA_FIELDS.tmdbId),
    tmdbType: fm[MEDIA_FIELDS.tmdbType] === "movie" || fm[MEDIA_FIELDS.tmdbType] === "tv" ? fm[MEDIA_FIELDS.tmdbType] : null,
    anilistId: readNullableIdFm(fm, MEDIA_FIELDS.anilistId),
    year: typeof fm[MEDIA_FIELDS.year] === "number" ? fm[MEDIA_FIELDS.year] as number : null,
  },
};
```

where `readNullableIdFm` is a tiny local helper mirroring `media-list.ts`'s
`parseNullableId` (collapse absent/empty/"null" → `null`, trimmed string → the
string):

```ts
function readNullableIdFm(fm: Record<string, unknown>, key: string): string | null {
  const raw = fm[key];
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.toLowerCase() === "null") return null;
  return t;
}
```

(`fm` here is the `frontmatter` object from `getFileCache`; it's already in
scope. If `tmdbType`'s `fm[...]` cast trips `noImplicitAny`, narrow with an
explicit `as "movie"|"tv"`.)

**Verify:** `npm run typecheck` → exit 0.
`grep -n "media_spotify_id\|MEDIA_FIELDS.spotifyId\|media_tmdb_id\|MEDIA_FIELDS.tmdbId" packages/core/src/pipeline/media-pipeline.ts`
→ now present inside `reconstructMediaCache` (in addition to `MEDIA_FIELDS` /
`writeMediaToBookmark`).

### Step 4: Upgrade `renderMedia` to canonical links

In `pipeline-details.ts` `renderMedia`, find 034's `mediaLink` block (the one
that calls `watchableUrl({ subcategory, title })` and, for music, builds a
Spotify *search* URL). Upgrade it so:

- **Music** (subcategory `music` / whatever 034 keys on): if
  `data.spotifyId` is a non-empty string, use the **canonical track** URL and
  label "Open in Spotify"; else keep 034's Spotify *search* link.
  ```ts
  if (data.spotifyId) {
    mediaLink = { label: "Open in Spotify", url: `https://open.spotify.com/track/${data.spotifyId}`, icon: "🎧" };
  } else {
    // ...034's existing Spotify-search fallback, unchanged...
  }
  ```
- **Watchable** (films/series/anime/documentaries): pass the resolved ids into
  the SAME `watchableUrl` call 034 already makes, so it returns `kind:"canonical"`
  when possible. Use the **plural `source.subcategory`**, NOT `data.mediaType`
  (`watchableUrl` matches the plural form; `mediaType` may be singular):
  ```ts
  const w = watchableUrl({
    subcategory: (source?.subcategory ?? data.mediaType ?? "").toLowerCase(),
    title: data.title,
    year: data.year ?? null,
    tmdbId: data.tmdbId ?? null,
    tmdbType: data.tmdbType ?? null,
    anilistId: data.anilistId ?? null,
  });
  if (w) mediaLink = { label: w.kind === "canonical" ? "Open" : "Find it", url: w.url, icon: "▶" };
  ```
  This drops the `as any` 034 used on the `watchableUrl` arg, since the ids now
  exist on `data`. **Do NOT special-case series to use the tmdbId** —
  `watchableUrl` already (correctly) returns a search URL for series even with a
  `tmdbId` (Letterboxd is films-only). Don't "fix" that.

Leave the trailing `renderActionLinks(el, source, mediaLink)` call exactly as
034 wrote it — only the value of `mediaLink` changes.

**Verify:** `npm run typecheck` → exit 0. `grep -n "open.spotify.com/track\|data.tmdbId\|data.anilistId" packages/core/src/views/pipeline-details.ts`
→ present in `renderMedia`.

### Step 5: Tests

Extend the existing pipeline-details / media-pipeline tests (the `obsidian` stub
is auto-mocked per `vitest.config.ts`). Add cases that pin BOTH the canonical
upgrade and the two load paths:

1. **renderMedia canonical film** — `renderPipelineDetail(el, { type:"media",
   extraction: makeMedia({ mediaType:"film", title:"Dune", tmdbId:"438631",
   tmdbType:"movie" }) }, { url:"https://www.tiktok.com/@x/video/1", author:"x",
   subcategory:"films" })` → asserts a `.roost-pipeline-actions a` whose `href`
   is `https://letterboxd.com/tmdb/438631/` (NOT a `/search/` URL).
2. **renderMedia canonical anime** — `anilistId:"99423"`, `subcategory:"anime"` →
   href `https://anilist.co/anime/99423`.
3. **renderMedia canonical music** — `mediaType:"music"` (or subcategory music),
   `spotifyId:"abc123"` → href `https://open.spotify.com/track/abc123`, label
   "Open in Spotify".
4. **Series stays search even with tmdbId** — `subcategory:"series"`,
   `tmdbId:"1399"` → href contains `letterboxd.com/search/tv/` (NOT
   `/tmdb/1399/`). This locks the gotcha.
5. **No ids → search fallback (034 behavior preserved)** — film with no `tmdbId`
   → href contains `letterboxd.com/search/films/`.
6. **`reconstructMediaCache` carries the ids** — build a fake vault note with
   `pipeline_v_media` + `media_tmdb_id`/`media_tmdb_type`/`media_spotify_id`/
   `media_anilist_id`/`media_year` in frontmatter; call `reconstructMediaCache`
   and assert the returned `extraction` has those five fields populated. (Reuse
   the existing media-pipeline test's fake-app / metadataCache stub.)
7. **`loadPipelineData` merges `playback`/`deepLink`** — if there's an existing
   pipeline-details cache-load test, add a media cache fixture whose entry has
   `extraction` + `playback.spotifyId` + `deepLink.tmdbId` and assert
   `getPipelineData(id).extraction.tmdbId` / `.spotifyId` are populated. If no
   such harness exists, cover this path via the renderMedia tests (1–3) plus a
   focused unit assertion that the merge happens, and note in the test that the
   on-disk merge is exercised.

If you add a `makeMedia` factory, default the five ids to `null`/absent so
existing `renderMedia` tests from 034 still compile (the fields are optional).

**Verify:** `npm test -- pipeline-details media-pipeline` and `npm test` → all
pass, ≥ baseline.

## Done criteria

- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0, ≥ baseline; the new canonical-link + both-load-path
      tests pass.
- [ ] `grep -n "spotifyId\|tmdbId\|tmdbType\|anilistId\|year" packages/core/src/types/roost.d.ts`
      → the five fields present on `MediaExtraction`.
- [ ] `grep -n "MEDIA_FIELDS.spotifyId\|media_spotify_id" packages/core/src/pipeline/media-pipeline.ts`
      → now appears inside `reconstructMediaCache` (not just `MEDIA_FIELDS` /
      `writeMediaToBookmark`).
- [ ] `grep -n "playback\|deepLink" packages/core/src/views/pipeline-details.ts`
      → present in `loadPipelineData`.
- [ ] `grep -n "open.spotify.com/track\|data.tmdbId\|data.anilistId" packages/core/src/views/pipeline-details.ts`
      → present in `renderMedia`.
- [ ] `grep -n "letterboxd.com/tmdb\|anilist.co/anime/\${" packages/core/src/views/pipeline-details.ts`
      → ABSENT — canonical URLs come from `watchableUrl`, not hand-built in
      `renderMedia` (only the Spotify track URL is built inline, since
      `watchableUrl` doesn't cover music).
- [ ] No files outside the in-scope list modified. In particular
      `media-where-cell.ts` / `media-list.ts` / `watchable-url.ts` unchanged
      (`git status --porcelain` shows only the in-scope files).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- **Base is pre-034** (`renderActionLinks`/`PipelineSource` absent from
  `pipeline-details.ts`) — STOP; 035 builds on 034.
- The cited `MediaExtraction` / `CacheEntry` / `MEDIA_FIELDS` /
  `reconstructMediaCache` / `loadPipelineData` excerpts don't match after
  symbol-locating (structural drift, not just line shift) — STOP and report.
- Widening the canonical `MediaExtraction` breaks an unrelated consumer's
  typecheck in a way that can't be fixed by making the fields **optional** — STOP
  and report (optional fields should make this purely additive).
- You find you must edit `watchable-url.ts`, `media-where-cell.ts`, or
  `media-list.ts` to make the card canonical — STOP. The card should reuse
  `watchableUrl` as-is; if it can't, the seam is wrong — report rather than fork
  the URL logic.
- Only ONE of the two load paths can be made to carry the ids — STOP and report.
  Fixing one but not the other makes the card link **inconsistent**: canonical
  from a fresh cache but search after a cache wipe (or vice-versa). Both must
  land together.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **Both load paths or nothing.** `loadPipelineData` (populated cache) and
  `reconstructMediaCache` (cache wiped → rebuilt from frontmatter) feed the same
  `pipelineLookup`. If only one carries the ids, the card's deep link silently
  flips between canonical and search depending on whether the cache JSON exists —
  the exact inconsistency this plan exists to remove. The Step-5 tests pin both.
- **Series is intentionally search-only.** `watchableUrl` returns a search URL
  for `series` even when a `tmdbId` is present, because Letterboxd's `/tmdb/{id}/`
  redirect is films-only (TV ids 404 to "Film not found" — verified pre-merge,
  see `watchable-url.ts` comment). Do not add a series→tmdb canonical branch.
- **Plural subcategory, not singular mediaType.** `watchableUrl` matches
  `films`/`series`/`anime`/`documentaries`. `data.mediaType` is the singular
  pipeline value (`film`/`series`/…). Pass `source.subcategory` first; the
  `?? data.mediaType` is only a last-ditch fallback and will mostly miss the
  watchable gate — that's acceptable (degrades to no deep link, not a wrong one).
- **`year` is best-effort from the cache path.** It's derived at write time, not
  stored on `playback`/`deepLink`, so `loadPipelineData` leaves it `null`;
  `reconstructMediaCache` reads `media_year` from frontmatter when present. Year
  only sharpens the *search* URL (never the canonical one), so a missing year is
  cosmetic.
- This plan is the swap 034's Maintenance notes anticipated: 034's `renderMedia`
  `renderActionLinks` call site is exactly where the search→canonical upgrade
  lands; 035 changes only the `mediaLink` value, not the affordance scaffolding.
- Reviewer focus: (1) both load paths carry the ids; (2) `renderMedia` reuses
  `watchableUrl` rather than hand-building Letterboxd/AniList URLs; (3) series
  unchanged; (4) the canonical `MediaExtraction` fields are **optional** so 034's
  existing media tests and any other `MediaExtraction` producer still compile.
