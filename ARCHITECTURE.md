# Roost — Obsidian Bookmark Organizer

Sync, categorize, and visualize social media bookmarks from TikTok and X/Twitter inside Obsidian.

## Overview

Roost is an Obsidian plugin that downloads your bookmarks, stores them as markdown notes with embedded media, uses a local LLM + fine-tuned embeddings to categorize them, and surfaces the categorization through a custom visual gallery.

```
┌─────────────────┬──────────────────────────────┐
│  Left Sidebar    │     Main Content Area        │
│  (Roost)         │                              │
│                  │  Bases card gallery           │
│  Library tree    │  (bookmarks, video scrub,    │
│  ├ TikTok  ↗ ↻  │   inline expansion)           │
│  │ Unsorted      │                              │
│  │ Cooking       │  — or during staging —        │
│  │ Fitness       │  Folder cards with stacked    │
│  └ X        ↗ ↻  │  thumbnails per category      │
│    Unsorted      │                              │
│                  │  — or during login —           │
│  Smart Assign    │  TikTok / X webview           │
│  Import Eagle    │                              │
│  ─── Logs ───    │                              │
└─────────────────┴──────────────────────────────┘
```

## Architecture

### Three Layers

1. **Sync Layer** — Fetch bookmarks via webview injection (TikTok probe, Twitter auto-scroll)
2. **Storage Layer** — Markdown notes with YAML frontmatter, downloaded media, author backlinks
3. **Intelligence Layer** — Phase F v2 fine-tuned embeddings:
   - **Smart Assign** — score-first ensemble classifier that assigns `roost_category` to unsorted items

### Plugin Structure

```
packages/core/src/
├── main.ts                          # Plugin entry, view registration, calls registerRoostCommands
├── config.ts                        # Constants (sync, Ollama, digest buckets, card sizing)
├── settings.ts                      # Plugin settings (pipelines, integrations, llmBackend, …)
├── plugin/
│   └── register-roost-commands.ts   # Cmd+P loop over ENRICHMENTS + pipeline guards
├── views/
│   ├── roost-view.ts                # ItemView shell for the left sidebar
│   ├── roost-hub-view.ts            # Roost Hub dashboard (React)
│   ├── roost-webview-view.ts        # Login webview
│   ├── bookmarks-bases-view.ts      # Bases gallery orchestrator (delegates to gallery-*.ts)
│   ├── gallery-pipeline-host.ts     # Dispatch substitute/above pipeline gallery views
│   ├── roost-card-block.ts         # ```roost-card``` processor for digest embeds
│   ├── pipeline-details.ts          # Pipeline overlay/chip helpers for expanded cards
│   ├── places-map.ts                # Leaflet map (used by pipeline-views/places-map.ts)
│   ├── feed/                        # Feed pane (toggle inside gallery, not a separate Bases view)
│   │   ├── feed-panel.ts            # Snap-scroll feed scroller + windowed mount
│   │   ├── feed-sync.ts             # Active roost_id shared by grid + feed
│   │   ├── feed-renderers.ts        # Platform feed item DOM
│   │   └── card-helpers.ts          # Cover/video/image resolution (shared with gallery)
│   └── pipeline-views/              # Per-category gallery views (registry pattern)
│       ├── registry.ts              # substitute | above modes
│       ├── media-list.ts            # Media table (substitute)
│       ├── places-map.ts            # Map above grid (above)
│       └── shared/chip.ts           # Pipeline chip component
├── ui/
│   ├── components/                  # RoostView.tsx sidebar React, staging, modals, library-tree
│   ├── hub/                         # Hub dashboard (hub-body, integrations + pipelines panels)
│   ├── hooks/                       # use-smart-assign, use-roost-pipeline-rows, …
│   └── lib/group-store.ts           # Smart Assign proposal tree state
├── sync/
│   ├── tiktok-sync.ts, twitter-sync.ts, run-platform-sync.ts
│   ├── vault-writer.ts              # Notes + media + scanIncompleteIds buckets
│   ├── article-backfill.ts, thread-backfill.ts, media-backfill.ts
│   └── …                            # webview-manager, eagle-import, bases-setup, card-renderer
├── pipeline/
│   ├── evaluate.ts, describe-items.ts, taxonomy.ts   # Smart Assign core
│   ├── digest-pipeline.ts           # Weekly digest SYNTHESIS pipeline (not on the runner — see its banner)
│   ├── memory/                      # Agent memory writer (digest → Memory/ tree)
│   ├── run-category-pipeline.ts     # Parametric runner: the one category-enrichment skeleton
│   ├── *-pipeline.ts                # Per-category CategoryPipelineConfig wirings (recipe, place, media, …)
│   └── shared.ts                    # Embeddings, centroids, pipeline caches, forEachBatch, withLLMRetry
├── lib/
│   ├── enrichments.ts               # EnrichmentDef registry + PIPELINE_ENRICHMENTS ids
│   ├── pipeline-gate.ts             # llmAvailable, isPipelineActive (pure)
│   ├── pipeline-gate-plugin.ts      # gateCtxFromPlugin, isCategoryPipelineActive, guard
│   ├── extract.ts, vault-helpers.ts, vault-utils.ts, roost-paths.ts
│   └── …
├── types/                           # roost.d.ts, sync.ts, plugin.ts
├── probes/                          # tiktok-probe.js, twitter-probe.js
└── styles/                          # globals.css, bases-view.css
```

`RoostPlugin` (`packages/core/src/main.ts`) selects its embedder via `selectEmbedder` (sidecar or Ollama).

Process management (`AgentManager`) has been removed. The plugin no longer
spawns or installs Ollama, the Python sidecar, or any other external process.
Availability is determined solely through the integration registry (HTTP probes
and binary resolution).

### Integration Registry (the "lego" catalog)

Roost is **a local bookmarks core + optional composable "legos."** The core (sync · store · gallery · organize) runs with zero add-ons; everything beyond it is an optional lego — a capability gated on an integration, installed via the opt-in `setup-integrations.sh`, detected at runtime, and degrading gracefully when absent. The integration registry **is** that lego catalog. Today's legos: Smart Categorization (Ollama LLM), Fine-tuned Embeddings (sidecar + a user-trained model — the lone non-borrowable lego), Video Vision (ffmpeg), and Semantic Search (vendored vault-search). A Roost MCP Server lego is planned. (Design: `docs/superpowers/specs/2026-06-15-lego-model-design.md`.)

`packages/core/src/integrations/` tracks the four optional tools the plugin can use:

| Integration | Kind | Flag |
|-------------|------|------|
| `ollama` | HTTP server (`http://localhost:11434`) | `settings.integrations.ollama` |
| `sidecar` | HTTP server (`http://localhost:11435`) | `settings.integrations.sidecar` |
| `ffmpeg` | CLI binary | `settings.integrations.ffmpeg` |
| `vault-search` | CLI binary (vendored) | `settings.integrations.vaultSearch` |

The **Semantic Search lego** (`vault-search`) is now **vendored into the repo** at `tools/vault-search/` (deliberately outside the `packages/*` workspace so its native deps aren't built on every `npm install`). It's opt-in: `setup-integrations.sh --with-search` builds the CLI, symlinks it into a `COMMON_BIN_DIRS` location so `findBinary` resolves it, and writes a default `.env` (Ollama + vault paths). `deploy-to-vault.mjs` bundles the source into the plugin scripts dir. Phase 1 ships search + install; managed-index lifecycle is Phase 2; the bundled MCP server is not enabled (that's the future Roost MCP lego).

Each entry in `INTEGRATIONS` (`registry.ts`) carries a `detect(ctx)` method that receives injected `httpProbe` and `resolveBinary` functions — no hardcoded paths, no real I/O in unit tests. Detection results are cached for 5 seconds (`detectIntegration`); the cache can be cleared with `clearDetectCache` after settings changes.

The plugin **never installs or spawns** these tools. It detects availability and, when a tool is unavailable, surfaces setup instructions to the user. A tool is used only when its flag is enabled in `settings.integrations` **and** `detect()` succeeds.

The **embedding sidecar** now serves `POST /transcribe` (faster-whisper, lazily loaded so embedding-only installs are unaffected; Silero VAD reports `no_speech` on music/silence) alongside its `/api/embed` endpoint; `/api/tags` reports `asr_available`. The plugin still doesn't spawn it — but it can be installed as a **durable auto-start service** (per-user macOS LaunchAgent / Linux systemd `--user` unit, running on a standalone uv-managed Python venv) via `scripts/install-sidecar-service.sh`, which `setup-integrations.sh` runs.

**Backend transparency.** Because the sidecar is a separate process and `embeddingBackend: "auto"` *silently* falls back to raw Ollama when it's down, the active backend used to be invisible — and production silently ran raw embeddings for ~3 weeks. The transparency layer fixes this: `describeActiveEmbedding` (`lib/embedder.ts`) reports the *resolved* backend (not just the configured setting); `lib/embedding-provenance.ts` stamps which backend produced the cache (`.roost/cache/embedding-provenance.json`) and `classifyMismatch` detects `sidecar-down` / `vault-moved` / `upgrade-available`; the Smart Assign embed step warns at run-start and the Hub status strip shows the live backend; a "Re-embed all" command is the one-click recovery. Crucially, the honest Ollama-only default is never flagged as degraded. (`lib/sidecar-probe.ts` is the single shared probe.)

Three capabilities are explicitly gated by these flags:

- **ffmpeg video-frame vision** (`describe-items.ts`): runs only when `settings.integrations.ffmpeg` is on and `findBinary` resolves both `ffmpeg` and `ffprobe` (PATH + common dirs; no hardcoded paths). When unavailable, the embed step falls through to cover-image vision unchanged.
- **Vault-search command**: runs only when `settings.integrations.vaultSearch` is on and the binary resolves. When off or missing, clicking the command shows a Notice with setup guidance instead of opening the search modal.
- **Smart Assign**: requires at least one embedding backend (Ollama or sidecar) flagged on and detected. The button is disabled with a tooltip when neither is available; clicking it while unavailable shows a guiding Notice. (This gates the embeddings step only; the LLM rerank vs score-only behavior inside the pipeline is unchanged.)
- **Category extraction pipelines** (recipe, place, media, …): require `llmAvailable()` in `lib/pipeline-gate.ts` — see [Category extraction pipelines](#category-extraction-pipelines). Local backend needs `settings.integrations.ollama` on **and** a successful Ollama probe; cloud backend needs `settings.llmBackend === "cloud"` and a non-empty `anthropicApiKey`. The embedding sidecar does not satisfy this gate.

### Shared Modules

Several cross-cutting concerns are centralized to avoid duplication:

| Module | Provides | Used by |
|--------|----------|---------|
| `config.ts` | All tuning constants (clustering thresholds, batch sizes, Ollama URLs/models, card dimensions) | cluster, describe-items, tiktok-sync, twitter-sync, group-store, card-renderer |
| `lib/vault-helpers.ts` | `buildFrontmatter()`, `ensureFolder()`, `ensureAuthorNote()` | vault-writer, eagle-import |
| `lib/roost-id.ts` | `roostIdFromUrl()`, re-exports `roostBookmarkId()` | eagle-import, shared.ts (cache rekeying) |
| `lib/vault-utils.ts` | `getSyncFiles()`, `parseRoostId()`, `matchesCategoryFilter()`, `matchesFilter()` | vault-writer, eagle-import, describe-items, RoostView, bookmarks-bases-view |
| `types/sync.ts` | `StopSignal`, `SyncProgress` | tiktok-sync, twitter-sync, describe-items, RoostView, use-smart-assign |
| `lib/extract.ts` | `getBookmarkPlatform()`, `detectPlatformFromUrl()`, media extractors | vault-writer, eagle-import |
| `lib/enrichments.ts` | `ENRICHMENTS`, `PIPELINE_ENRICHMENTS`, `getEnrichmentForCategory()` | register-roost-commands, hub, library tree |
| `lib/pipeline-gate.ts` | `llmAvailable()`, `isPipelineActive()` | pipeline-gate-plugin, hub prereqs |
| `lib/pipeline-gate-plugin.ts` | `gateCtxFromPlugin()`, `isCategoryPipelineActive()`, `guardPipelineActive()` | commands, gallery dispatch, library tree |
| `pipeline/shared.ts` | `loadPipelineCache()`/`savePipelineCache()`, `ollamaGenerate()`, embedding cache, `stripJsonFence()`, `forEachBatch()`, `withLLMRetry()` | run-category-pipeline, all `*-pipeline.ts`, digest-pipeline, Smart Assign |

## User Flows

### Sync Bookmarks

1. Click bird icon → Roost sidebar opens in left pane
2. Library tree shows platforms (TikTok, X) with ↗ login and ↻ sync buttons
3. Click **↗** → Login webview opens in main area, log in
4. Click **↻** → Sync starts, progress bar in sidebar header shows phase + counts
5. Notes created in `Bookmarks/{Platform}/` with media, frontmatter, author links
6. Library tree updates with item counts
7. Open `All Bookmarks.base` → Visual gallery with video scrubbing

### Smart Assign (AI Categorization)

Smart Assign targets whatever is selected in the sidebar library tree:
- No selection → all items
- Click "TikTok" → only TikTok items
- Click "Unsorted" → only uncategorized items

Flow:

1. Click **Smart Assign** → Topic editor with pre-detected collections
2. Two-column scrollable checkbox grid — toggle off unwanted topics, add custom ones
3. Click **Run** → Pipeline step indicator appears: `Embed → Score Known → Discover → Describe → Score New → Review`
4. **Embed step** — describe-items.ts. For items missing vectors: keyframe vision (gemma4 over ffmpeg frames) → one-sentence summary + category via llama3.2:3b → 768-d embedding via the v2 sidecar. Results cached in `.roost/cache/`: 768-dim Float32 vectors in `embedding-vectors.bin`, text fields (vision/summary/category) in `embedding-cache.json`, a dim stamp in `embedding-meta.json` (see [On-disk caches](#on-disk-caches-obsidianbookmarksroost)).
5. **Score Known** — evaluate.ts `scoreAgainstCategories`. For every item with a cached vector, compute cosine similarity to all category centroids (built from existing `roost_category` labels), take the top-K, and run the score-first ensemble (see pipeline section below). Items that pass the conditional disagree-reject are assigned; the rest flow to discovery.
6. **Discover** — evaluate.ts `discoverCategories`. Unmatched items are grouped by their cached Ollama category (resolved through the taxonomy); any group with ≥5 items and cohesion ≥ `MIN_DISCOVERY_COHESION` becomes a proposed new category.
7. **Describe** — evaluate.ts `generateClusterDescriptions`. One contrastive LLM call per proposed category produces both a short description and a NOT clause (what it isn't), grounded in nearest neighbors + counter-examples. Cached in `.roost/collection-descriptions-contrastive.json` and `.roost/collection-not-descriptions.json`.
8. **Score New** — re-runs `scoreAgainstCategories` against the expanded catalog (existing + proposed). Items that still can't find a home stay unassigned.
9. **Review step** — Bases grid shows **folder cards** with stacked thumbnails per category:
   - Each card: 3 stacked thumbnails (back +6°, mid -4°, front centered), name, count, cohesion %
   - Click folder card → drill into that category's items in the card grid
   - Sidebar tree shows the proposal with a Broad ↔ Specific slider (epsilon slider driving the taxonomy clustering from Step 7 / recluster)
   - Click tree node name → filter Bases grid to that cluster
   - Click chevron → expand/collapse tree
10. Click **Confirm Categories** → Sets `roost_category` field in frontmatter for unsorted items only (never overwrites existing labels).

**Cancel** (✕ next to step indicator) is non-destructive — clears all in-memory state, returns to sync mode. Embeddings, score cache, and description caches are kept (additive, useful for next run). Zero vault changes until Confirm.

**Score cache** at `.roost/score-cache.json`, keyed by `{itemId}|{catHash}`. `catHash` is an md5 of `EVAL_MODEL | PROMPT_VERSION || (name|description for every category)`, so any change to the collection set (add, rename, edit description) or to the prompt template automatically invalidates stale entries.

Categories use a dedicated `roost_category` frontmatter field:
- Non-destructive (original file location preserved, field can be cleared)
- Doesn't pollute Obsidian's tag namespace (no `category/*` tags)
- Queryable by Bases filters and Dataview via `roost_category` property
- Visible in the sidebar library tree under each platform
- Reset with `node scripts/reset-categories.mjs --run`

### Library Tree + Filtering

The sidebar shows a flat category list with a sync strip at the top:
```
TikTok ↗ ↻  |  X ↗ ↻        ← sync controls
─────────────────────────
Unsorted              3,215
Cooking                 252
Fitness                 163
```

Categories are cross-platform — counts aggregate items from all platforms. The gallery has a platform filter bar (All / TikTok / X pills) for narrowing by platform independently.

- Click any category → Bases grid filters to that category (all platforms)
- Click again → clears filter, shows all
- Gallery platform pills are local gallery state — they layer on top of the sidebar's category filter
- Filtering uses `matchesFilter()` from vault-utils — shared predicate across sidebar and Bases view
- Tree rescans vault after sync and Smart Assign confirm

### Eagle Import

1. Set Eagle library path in plugin settings
2. Click **Import Eagle** → Copies media from disk (no re-download)
3. Creates identical note format as sync imports

## Sync Optimization

Both platforms use a multi-layer skip strategy to make re-syncs fast.

### TikTok Sync

**Phase 1 — Collections**: Navigate to profile → scroll collections list until no new links for 3s → fetch each collection via API. Collection progress relayed to sidebar logs via `postMessage` queue.

**Phase 2 — Flat Favorites**: Cursor-based pagination via API (30 items/page).

Before processing each API page, the probe checks every item ID against `__ROOST_KNOWN_IDS__` (injected from vault):
- **All-known page**: skip entirely — no caching, no streaming, just advance cursor
- **Previous sync complete + 3 consecutive known pages**: stop fetching (everything beyond is synced)
- **Previous sync interrupted**: keep paginating through known pages (fast) until new items found

**Phase 3 — Batch Collection**: Items collected from probe in batches of `SYNC_BATCH_SIZE` (200).
- Before serializing: check IDs in webview — all-known batches skip entirely (no JSON transfer)
- Mixed batches: only serialize unknown items via `collectChunkFiltered`
- `writeBatch` skips already-written IDs (no media download), checks stop signal per-file

**Re-sync example** (5000 existing + 50 new): ~5 API calls instead of ~170. Only new items get media downloaded.

### Twitter/X Sync

**Phase 1 — Setup**: Inject probe → reload → navigate to bookmarks.

**Phase 2 — Auto-Scroll**: Probe scrolls the page, intercepting GraphQL responses. Plugin polls every 2s. **Inactivity timeout** (default 5 min) — resets every time new items arrive. Large collections scroll to completion.

**Early-out**: Previous sync complete + `EARLY_OUT_THRESHOLD` (3) consecutive all-known batches → stop scrolling.

### Skip Layers

| Layer | What it skips | How |
|-------|--------------|-----|
| Probe (TikTok) | Entire API pages | ID check before processing, cursor advance only |
| Batch collection | JSON serialization | ID check inside webview, skip known items |
| writeBatch | Media download + file write | ID check against vault scan |
| Early-out | Remaining feed | 3 consecutive all-known batches → stop |

### Sync State

Saved per-platform in plugin settings after each sync:
- `complete: true` — finished normally or early-out. Next sync can stop early.
- `complete: false` — user stopped or error. Next sync does full scan.
- `count` — cumulative items synced
- `timestamp` — when sync finished

### Stop Behavior

Stop signal (`StopSignal` from `types/sync.ts`) checked after every `await` in both sync loops:
- Probe stopped immediately (`__tiktokStopFetch` / `STOP_SCROLL`)
- `writeBatch` checks per-file — no more waiting for a 200-item batch to finish
- Remaining items not collected after stop
- Sync state saved as `complete: false`

## Note Format

```yaml
---
roost_id: "tiktok:7519332120247029022"
title: "Full video description text..."
cover: "[[Bookmarks/TikTok/tiktok-ABC123/thumb.png]]"
platform: tiktok
author: "[[People/@creator]]"
url: https://www.tiktok.com/@creator/video/123
collection: Recipes
sound: "Original Sound — @creator"
published: 2024-03-15
saved: 2024-03-27
roost_category: "Cooking & Food"
stats_plays: 1200000
stats_likes: 45000
tags:
  - tiktok
  - cooking
  - recipe
  - collection/Recipes
---
```

Note body is empty — all metadata in frontmatter. Title is the full post description (no truncation). `roost_category` is set by Smart Assign (dedicated field, doesn't pollute tag namespace).

Frontmatter is built by `buildFrontmatter()` in `lib/vault-helpers.ts` — single implementation used by both vault-writer and eagle-import. YAML quoting applied for strings containing `:`, `"`, `#`, `[`, or starting with `@`.

## Bases Gallery View

Custom Bases view type (`roost-bookmarks`) registered in the Bases dropdown:

- **Card grid** with configurable size (120–400px, default 180px), aspect ratio, fit
- **Incremental loading** — 60 cards per batch, sentinel IntersectionObserver triggers next batch
- **Skeleton loading** — shimmer placeholders crossfade to real cards (fade-in animation)
- **Video scrubbing** — hover to play, mousemove to seek, 300ms auto-resume, progress bar
- **Multi-photo gallery** — `📷+` badge on cards, prev/next navigation in expanded view
- **Inline expansion** — click card → FLIP animation (Motion spring) to full-width detail view
  - Video with native controls, stats, tags, collection, source URL, "Open note" link
- **Dense grid packing** — `grid-auto-flow: dense` backfills gaps from expanded cards
- **Folder cards** — stacked thumbnail view during Smart Assign staging
  - 3 thumbnails per category with CSS rotation + hover fan-out
  - Cohesion % color-coded (green >80%, yellow >70%, red <70%)
  - Click to drill into individual items
- **Cross-pane filtering** — sidebar sets filter via plugin event bus, grid rebuilds with matching subset
- **Data-level filtering** — uses `matchesFilter()` from vault-utils; filtered entries excluded from DOM entirely (no CSS hiding)
- **Pipeline chip rows** — bookmarks enriched by extraction pipelines display `<Chip>` pills on cards surfacing the most useful extracted fields (e.g. prep time, cuisine, where-to-watch, price)

## Per-Bookmark Enrichments

All per-bookmark backfills — data fetches AND pipeline extractions — are registered in `packages/core/src/lib/enrichments.ts` as `EnrichmentDef` entries. Each entry declares:

- `id` — canonical identifier used as the `enrichment_v_<id>` frontmatter key
- `schemaVersion` — integer bumped when the extraction schema changes; stale entries auto-flag for re-enrichment
- `commandId` / `commandName` — Cmd+P command registered by `plugin/register-roost-commands.ts` iterating over the registry
- `runBackfill` — driver function that walks the vault and enriches matching items
- `categoryMatches` — optional predicate routing pipeline enrichments to the correct roost_category items

The 13 registered enrichments:

| id | Type | What it writes |
|----|------|---------------|
| `articleBody` | data fetch | Full X Article body via TweetResultByRestId replay |
| `thread` | data fetch | Thread context pages via TweetDetail probe |
| `tweetBody` | data fetch | X tweet text rendered as a formatted markdown note body (links, quotes, thread structure) |
| `mediaFiles` | data fetch | Downloaded cover images + video files |
| `transcript` | data fetch | `subtitle.vtt` + `subtitle` frontmatter for caption-less TikTok videos — local faster-whisper transcription via the sidecar `/transcribe` (Silero VAD skips music/silence) |
| `playback` | data fetch | Video playback metadata |
| `recipe` | pipeline extraction | `recipe_*` frontmatter fields (ingredients, prep time, cuisine, difficulty) |
| `place` | pipeline extraction | `place_*` frontmatter fields (name, location, lat/lng, category) |
| `mediaExtraction` | pipeline extraction | `media_*` frontmatter fields (title, creator, genre, rating, where-to-watch) |
| `product` | pipeline extraction | `product_*` frontmatter fields (name, brand, price, where-to-buy) |
| `workout` | pipeline extraction | `workout_*` frontmatter fields (target area, duration, equipment, type) |
| `tutorial` | pipeline extraction | `tutorial_*` frontmatter fields (skill area, difficulty, time estimate, tools) |
| `home` | pipeline extraction | `home_*` frontmatter fields (room, style, budget tier) |

Schema versioning uses `enrichment_v_<id>: <schemaVersion>` written to the note's frontmatter when enrichment completes. A missing version field is not treated as stale (legacy items don't auto-flag).

`main.ts` calls `registerRoostCommands()` once at load — adding a new enrichment requires no `main.ts` edits.

The seven pipeline ids (`recipe`, `place`, `mediaExtraction`, `product`, `workout`, `tutorial`, `home`) are the enrichments with `categoryMatches`; they are collected as `PIPELINE_ENRICHMENTS` / `PIPELINE_ENRICHMENT_IDS` in `enrichments.ts` (single source of truth for settings keys and gates).

## Category extraction pipelines

End-to-end flow for LLM-backed category extractors:

| Layer | Module | Role |
|-------|--------|------|
| Registry | `lib/enrichments.ts` | Defines runners, `categoryMatches`, Cmd+P ids |
| Gate | `lib/pipeline-gate.ts` | `llmAvailable()` + per-flag `isPipelineActive()` |
| Plugin adapter | `lib/pipeline-gate-plugin.ts` | Builds context from settings + `integrationStatus`; `isCategoryPipelineActive(category)` |
| Gallery | `views/gallery-pipeline-host.ts`, `views/pipeline-views/registry.ts` | Substitute/above views only when pipeline active (`shouldRenderPipelineSubstitute()` on the Bases view) |
| Hub | `ui/hub/pipelines-panel.tsx`, `pipeline-rows.ts` | Per-pipeline On/Off toggles (`settings.pipelines`) |
| Sidebar | `ui/hooks/use-roost-pipeline-rows.ts`, `library-tree.tsx` | Run/cancel; Run hidden when inactive |

The pipeline layer is structured in three tiers:

1. **Invocation contract** — `EnrichmentDef` registry (`lib/enrichments.ts`):
   the uniform "runnable backfill job" interface the UI/commands/health-panel
   see. Spans more than the runner (article/thread/media-file backfills too).
2. **Shape template** — `runCategoryPipeline`
   (`packages/core/src/pipeline/run-category-pipeline.ts`): all seven
   category-enrichment pipelines (recipe, products, workouts, tutorials, home,
   places, media) delegate to this single parametric runner. Each supplies a
   `CategoryPipelineConfig` — gather/triage/extract/write callbacks, failure
   policies, and log strings — while the runner owns the skeleton: cache load,
   fast-path + LLM triage in concurrent batches, cached backfill, extraction,
   per-batch cache saves. Pipeline-specific stages stay config-driven: places
   runs a version-gated geo backfill before delegating; media uses
   `backfillCachedFirst` (stamps cached items before triage) and `afterCore`
   (Spotify playback + Letterboxd/AniList deep-link resolution).
3. **Shared mechanics** — `pipeline/shared.ts`: cache I/O
   (`loadPipelineCache`/`savePipelineCache`), `forEachBatch` (sequential
   chunked iteration), `withLLMRetry` (produce-and-parse retry with typed
   fallback), `ollamaGenerate`, embedding cache. Used by the runner AND by
   pipelines that don't fit the runner's shape.

`digest-pipeline.ts` is intentionally NOT on the runner: it is a synthesis
pipeline (time-windowed candidates, cluster-keyed LLM work, week-keyed cache,
a NEW aggregate note as output), not a per-item triage→extract→write-in-place
enrichment. It composes tier 3 only; its module banner states this. If a
second synthesis-shaped pipeline ever appears, that is the trigger for a
`runSynthesisPipeline` sibling template — one instance of a shape does not
justify a template.

**When is a pipeline active?** Toggle on in `settings.pipelines` **and** `llmAvailable()`:

- **`llmBackend: "local"`** — `settings.integrations.ollama` is true and the Ollama integration probe reports `available` (HTTP at `OLLAMA_URL`).
- **`llmBackend: "cloud"`** — `anthropicApiKey` is non-empty (uses configured `anthropicModel`).
- **`llmBackend: "skip"`** — never active, regardless of flags.

Hub prerequisite strip (`ui/hub/state.ts`) uses the same `llmAvailable()` predicate via `llmReadyForPipelines` so “Ollama/LLM” status matches pipeline gates.

**When inactive:**

- No substitute/above pipeline gallery (`PipelineGalleryHost` + `shouldRenderPipelineSubstitute()`).
- Cmd+P pipeline commands show a Notice via `guardPipelineActive()` instead of running.
- Library-tree **Run pipeline** button is hidden for that category.
- Plain card grid still shows chip/overlay UI for notes that already have extracted frontmatter; new extraction does not run.

### Pipeline gallery views

Per-category views are registered in `packages/core/src/views/pipeline-views/registry.ts`:

- **`substitute`** — replaces the card gallery (e.g. Media table)
- **`above`** — supplemental UI above the grid (e.g. Places map)

`isPipelineSubstituteView(filter)` in the registry is a pure “is this category registered as substitute mode?” check. The Bases view’s `shouldRenderPipelineSubstitute()` adds the active-pipeline gate.

Categories without a registered view use the standard gallery; chips come from enrichment declarations on `EnrichmentDef.chips` and `pipeline-details.ts`.

Shared primitives: `packages/core/src/views/pipeline-views/shared/`.

## Feed Mode

Optional right pane inside the gallery (toolbar toggle). Left side remains the card grid or pipeline substitute view; right side is a vertical snap-scrolling feed (`packages/core/src/views/feed/`). Grid clicks and feed scroll share one active `roost_id` via `feed-sync.ts`. Media category **forces** feed mode on — the Media table relies on `setFeedActive` for row-click detail.


## Roost Hub

Separate ItemView (`roost-hub`) — platform-centric dashboard for sync and enrichment backfills. React UI in `packages/core/src/ui/hub/`; reuses the same sync drivers and `ENRICHMENTS` registry.

### Hub layout (`hub-body.tsx`)

Top to bottom:

1. **Header** + global sync actions (`GlobalActionBar`)
2. **Prerequisites** — sync folder + LLM/Ollama strip (`PrereqStrip`; Ollama status uses `llmReadyForPipelines`)
3. **Integrations** — tool flags (`IntegrationsPanel`) plus **Pipelines** toggles (`PipelinesPanel` via `buildPipelineRows`)
4. **Platforms** — TikTok, X, Eagle cards (`PlatformCard`)

### Integrations panel

`IntegrationsPanel` is fed by `buildIntegrationRows(flags, status)` — one row per integration registry entry. Each row shows a label, status line (flag off → unlocks copy; on + detected → "Detected"; on + missing → setup instructions), and On/Off. Toggling calls `saveSettings()`, `clearDetectCache()`, and `refreshIntegrations()` so sidebar Smart Assign and Hub badges update without reload.

### Pipeline toggles (Hub)

The **Pipelines** subsection under Integrations lists all `PIPELINE_ENRICHMENT_IDS` with On/Off buttons (disabled when `llmAvailable()` is false). See [Category extraction pipelines](#category-extraction-pipelines) for active/inactive behavior. Implementation: `pipelines-panel.tsx`, `pipeline-rows.ts`, `gateCtxFromPlugin()`.

### Hub actions & the serial job queue

The hub exposes two one-click actions: **Backfill all** enqueues the data backfills (media, transcripts, tweet bodies, threads, article bodies, playback) and **Run pipelines** enqueues the enabled category pipelines (gated by `isCategoryPipelineActive`). Category-pipeline progress (`[recipe]`, `[place]`, …) is routed through `plugin.fireLog`, so it surfaces in the **hub log panel** alongside the data backfills.

All manually-triggered heavy jobs (sync, backfills, pipeline runs) route through `plugin.runJob` → a serial `RoostJobQueue` (`lib/job-queue.ts`), so they run **one at a time** in FIFO order rather than concurrently thrashing the vault. A throwing job is reported to its caller but never wedges the queue; the one-time tweet-body auto catch-up is deliberately **not** enqueued and instead yields to the queue via `onIdle()`.

## Weekly Digest & Agent Memory

- **Digest** — `pipeline/digest-pipeline.ts` aggregates weekly bookmarks into `Pipelines/Digest/Weekly/*.md`; cache at `.roost/cache/digest-cache.json`. A synthesis pipeline, deliberately not on `runCategoryPipeline` — see [Category extraction pipelines](#category-extraction-pipelines).
- **Memory** — optional post-digest write to `Memory/` via `pipeline/memory/writer.ts`; cache at `.roost/cache/roost-memory-cache.json`.
- **Digest cards** — `roost-card-block.ts` embeds gallery-style expanded cards in digest notes.


## Categorization Pipeline (Smart Assign)

Deployed in `packages/core/src/pipeline/evaluate.ts` and coordinated from `packages/core/src/ui/hooks/use-smart-assign.ts`. Score-first: each item is scored against its top-K nearest category centroids, the ensemble picks the best candidate, and a conditional rejection rule decides whether to assign or leave unmatched. Unmatched items pass through a discovery + contrastive-description pass that can propose brand-new categories before a second scoring sweep.

**Pipeline steps** (exactly what the progress header shows):

1. **Embed** — fill any missing vectors via vision + topic + sidecar embedder
2. **Score Known** — score every item against current collection centroids (uses `.roost/score-cache.json`)
3. **Discover** — bucket unmatched items by Ollama category, keep cohesive cohorts as proposals
4. **Describe** — one contrastive LLM call per proposal produces description + NOT clause
5. **Score New** — re-score against existing + proposed catalog
6. **Review** — user reviews the proposal tree + folder cards in the Bases view, then Confirm writes `roost_category`

### Item embedding (`describe-items.ts`)

Three stages per item, results cached in `.roost/cache/` (vectors in `embedding-vectors.bin`, text fields in `embedding-cache.json`, dim stamp in `embedding-meta.json`) and processed incrementally:

1. **Vision** via `VISION_MODEL` (`minicpm-v`) — describe cover image → one-sentence description
2. **Topic + category** via `TOPIC_MODEL` (`llama3.2:3b`) — vision + post text + tags → topic and category guess
3. **Embedding** via **Phase F v2 fine-tuned nomic** — 768d vector over a 5-field text (vision + summary + category + title + subtitle)

Embeddings go through a local sidecar at `EMBED_URL` (`http://localhost:11435`) that runs the fine-tuned `sentence-transformers` model with an Ollama-compatible `/api/embed` endpoint. Vision and topic analysis still go through stock Ollama at `OLLAMA_URL`. Category centroid embeddings in `taxonomy.ts` are routed through the same sidecar — critical, since item↔category cosines are garbage if the two live in different vector spaces.

### Score-first ensemble classifier (`evaluate.ts`)

For each item:
1. Compute cosine similarity to every category centroid, take the top-7 candidates.
2. **T1_letter K=5** — single-letter pick prompt ("respond with A..E") on the top 5, `num_predict=10`.
3. **T2_json K=7** — per-option 1–10 JSON score prompt on all 7, `num_predict ≈ 170`.
4. Both calls run in parallel via `Promise.all` on `EVAL_MODEL` (`gemma4:e4b`) with `think: false`, `temperature: 0`.
5. **Embedding-rank tiebreak**: parses agree → that pick; parses disagree → whichever candidate has the lower index in top-7 (higher centroid sim) wins. Parse-failure fallback: use whichever cell parsed.
6. **Conditional disagree-reject**: if T1 and T2 disagreed AND the final picked candidate's sim < `CONDITIONAL_REJECT_THRESHOLD` (0.87), the item goes unmatched instead of being assigned.

`PROMPT_VERSION` is mixed into the score-cache key hash, so any template/parser change automatically invalidates stale cache entries.

### Discovery + contrastive description (`evaluate.ts`)

Items that don't pass Score Known flow into **discovery**: they're bucketed by the cached Ollama category (after taxonomy normalization), and any bucket with ≥5 items + cohesion ≥ `MIN_DISCOVERY_COHESION` becomes a proposed new category.

Each proposed category gets a single contrastive LLM call that sees both the cluster's nearest neighbors and a handful of counter-examples from neighboring clusters. The call returns both a description (what this cluster is) and a NOT clause (what it isn't). Paired descriptions are cached in `.roost/collection-descriptions-contrastive.json` + `collection-not-descriptions.json`.

After describing, Score New re-runs `scoreAgainstCategories` with the expanded catalog. Items that still don't match any centroid stay unsorted and surface under "Unsorted" in the library tree, where the user can re-run or assign manually.

### Measured performance (119 positive + 50 negative test set)

| Stage | Top-1 | F1 |
|---|---|---|
| Raw nomic baseline | 72/119 (60.5%) | 0.685 |
| + v2 fine-tune (full-vault re-embed) | 77/119 | — |
| + T1_letter K=5 prompt | 84/119 | — |
| + T2_json K=7 ensemble w/ embedding-rank tiebreak | 85/119 | — |
| + 4 label fixes in test set | 88/119 (73.9%) | 0.685 |
| + conditional disagree-reject @ 0.87 | 86/119 | **0.714** (+0.029) |

**Realistic ceiling**: ~91.4% on clean data. A manual audit of the 34 failures classified 22 as ambiguous-but-valid (both picks are semantically correct, GT reflects user preference), 4 as mislabels, and 8 as real reasoning gaps. The 97.5% top-7 oracle is *technical* headroom, not *achievable* headroom.

### Learnings (non-obvious)

These shaped the final pipeline. Kept here so the next person touching this code doesn't re-learn them the hard way.

- **MNRL > Triplet for hard-neg fine-tuning on small datasets.** v1 used TripletLoss with mined hard negatives and regressed −35pp. MultipleNegativesRankingLoss with the same mining strategy gave +1.7pp top-1 and +4.5pp top-7.
- **Fine-tuning pushes gains into the tail.** v2's top-3 oracle actually *dropped* 1.7pp vs baseline — the gain was in top-7 (97.5% vs 93%). K=3 rerank on the v2 cache regressed (73 < 76). **Must widen K to cash in a recall-focused fine-tune.**
- **Position bias is real and K-dependent.** At K=5 gemma4 picks slot A 41.7% of the time (vs uniform 20%). At K=7 the bias shifts to B/A and end slots (E/F) get ~5% vs uniform 14%. Rotating the letter assignment over 5 permutations and majority-voting recovers +7/0 items at K=7 but is still 1 under deterministic K=5. **Prefer lower K with stronger candidates over wider K with mitigation.**
- **When embedding margins collapse, look for orthogonal signals.** Post-v2 fine-tune, top-1 centroid sims for correct and wrong picks overlap almost completely. Pure `picked_sim` thresholding and all sim-distance variants (`sim - 2nd_topk`, `sim - mean(rest)`, etc.) were flat for F1. What worked: **T1≠T2 agreement**, an independent signal because the two prompt shapes (single-letter choice vs per-option JSON scores) have uncorrelated failure modes. Negatives disagree 32% of the time vs 11% for correct positives.
- **Embedding quality is NOT the bottleneck.** A classifier-head diagnostic (LogReg/kNN/MLP over v2 embeddings) tops out at 61/119 vs the LLM ensemble's 88/119. Every linear/shallow head trails the ensemble by ≥27 items. The LLM rerank is doing genuine selection work that no linear decision boundary replicates.
- **Bigger LLM ≠ better reranker.** Qwen2.5:7b underperformed gemma4:e4b by −3 to −21 items on every K/template cell. Not a single qwen cell beat the deployed baseline. Prompts implicitly co-evolve with model idiosyncrasies; swapping families requires re-tuning.
- **`think: false` is mandatory for gemma4 reasoning models via Ollama.** Without it, gemma4 exhausts `num_predict` during internal thinking and returns empty content with `done_reason=length`. Cost a full sweep before diagnosis.
- **Oracle ceilings can lie.** 97.5% top-7 sounded like room to grow. The label-noise audit cut the achievable ceiling to 91.4%. **Always audit failure cases by hand before chasing oracle headroom.**
- **Label fixes beat modeling.** 4 mislabels in the test set (confirmed by audit) were worth +3 top-1 items after a one-line vault frontmatter patch. The 4th fix caused a 1-item distractor-sensitivity regression elsewhere — centroid shifts from relabeling ripple through the ensemble picks.
- **Phased deployment with sweep-verified gates > "just ship it."** Every phase (v2 cache, T1 prompt, T2 ensemble, label fixes, conditional reject) was measured against the same 119-item test set before the next one was built, which caught the Phase 4 distractor regression before it masked Phase 5's real gain.
- **Cache invariants matter.** Category centroid embeddings in `taxonomy.ts` MUST route through `EMBED_URL`, not `OLLAMA_URL`. If they land in the base-nomic space while items land in the v2 space, every cosine is corrupted and Smart Assign silently degrades. Any future embed-path change needs a bit-identical sim smoke check (see `scripts/reembed-full-vault.py` flow).

The narrative arc (v1 k-means → v2 HDBSCAN → score-first pivot → Phase F fine-tune → phased deployment) is summarized in the sections above; internal journey notes were removed from the public repo during release cleanup.


## Component Architecture

### RoostView + useSmartAssign

`ui/components/RoostView.tsx` is the sidebar coordinator (ItemView shell: `views/roost-view.ts`). Sync, library tree, platform sync, category tree, and pipeline rows are split into hooks under `packages/core/src/ui/hooks/`. Smart Assign state and handlers live in `useSmartAssign`:

```
RoostView.tsx
├── useRoostSidebarLog, useLibraryTree, useRoostPlatformSync, …
└── useSmartAssign() hook  (~340 lines)
    ├── Pipeline state (mode, pipelineStep, confirming)
    ├── Cluster state (proposal, sliderValue, forceToggle, userRenames)
    ├── GroupStore (via useGroupStore hook)
    ├── handleSmartAssign()  → topic editor
    ├── runClustering_()     → runSmartAssignClustering() in packages/core/src/ui/lib/smart-assign/
    │       └── clustering.ts orchestrates clustering-step-*.ts under ui/lib/smart-assign/
    ├── handleConfirm()      → confirm.ts → write roost_category to vault
    └── handleCancel()       → reset-state.ts
```

### GroupStore

Pure data store (no React) managing both proposed clusters and confirmed library folders:
- `loadFromClusterOutput()` — walks split tree, assigns UUIDs
- `getSliderSplits()` — priority-based tree expansion to N leaves
- `getVisibleLeaves()` — absorption logic, collection matching, folder card data
- `clearProposal()` — non-destructive cancel

## UI Design System

### Button Component

All buttons use a unified `Button` component with:
- Variants: `default`, `outline`, `ghost`, `destructive`, `secondary`, `link`, `suggested` (light green — used for the primary action in merge/confirm modals so the "safe default" is visually obvious)
- Sizes: `xs`, `sm` (sidebar default), `default`, `lg`, `icon-xs`, `icon-sm`, `icon`, `icon-lg`
- `loading` prop: shows spinner + auto-disables
- Used consistently across toolbar, tree actions, topic editor, staging controls, and modals

### Progress Feedback

- **Progress bar** in sidebar header — adapts labels per phase:
  - Sync: `fetch — 47 new · 2,453 skipped · 5,000 fetched`
  - Embedding: `embedding — 150 / 4,732 items`
  - Scoring: `scoring — 2,134 / 4,732 items scored`
  - Clustering: `clustering — processing...` (pulse animation)
- **Pipeline steps**: `Embed → Score Known → Discover → Describe → Score New → Review` with checkmarks for completed steps
- **Logs panel**: collapsible, auto-opens on activity, capped at 200 entries, copy button
- **All buttons** show spinner when their action is in progress

### Tree Styling

Both library tree and staging tree use Obsidian-native CSS:
- `.tree-item`, `.tree-item-self`, `.tree-item-children` for structure
- `.nav-folder-title`, `.nav-file-title` for row styling
- `.collapse-icon` with SVG chevron for expand/collapse
- Custom additions: status dots, item counts, cohesion badges, absorption flow indicators

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Webview at plugin level | Preserves login cookies across view open/close |
| Direct `<video>` overlay (not canvas) | Canvas drawImage unreliable in Obsidian's Electron |
| `preload="metadata"` (not "auto") | Avoid resource contention from hundreds of videos buffering |
| `grid-auto-flow: dense` | Backfills gaps when cards expand to full width |
| Motion `animate()` for FLIP | Same spring physics as Electron app, vanilla DOM compatible |
| `safeGetValue()` wrapper | Obsidian's `getValue()` throws on null frontmatter values |
| Incremental loading (60/batch) | 14K+ placeholders in CSS grid caused multi-second lag |
| Data-level filtering (not CSS) | `display: none` on grid items caused reflow flash |
| `roost_category` field (not tags or folders) | Non-destructive, doesn't pollute tag namespace, queryable by Bases |
| Inactivity timeout (not wall-clock) | Twitter sync: large collections scroll to completion |
| Metadata cache for reads | `metadataCache.getFileCache()` instead of `vault.cachedRead()` + regex |
| Single vault lookup for multi-photo badge | `hasMultipleImages` checks `2.jpg` exists, defers full resolution to expanded view |
| Centralized config.ts | All tuning constants in one file for easy adjustment |
| Shared vault-helpers.ts | Single `buildFrontmatter`/`ensureFolder`/`ensureAuthorNote` used by both sync paths |
| WeakMap for webview handlers | Avoids fragile property storage on DOM elements |
| Unified StopSignal type | One cancellation interface across sync, pipeline, and UI |

## Configuration

### Plugin Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Sync folder | `Bookmarks` | Where synced notes are saved |
| `integrations.*` | all off | Per-tool flags (Ollama, sidecar, ffmpeg, vault-search); must be on **and** detected to use |
| `llmBackend` | `local` | `local` → Ollama for LLM features; `cloud` → Anthropic; `skip` → disables pipeline LLM gates |
| `anthropicApiKey` | empty | Used when `llmBackend === "cloud"` |
| `pipelines` | all on | Per extraction pipeline (`PipelineId` keys from `PIPELINE_ENRICHMENT_IDS`) |
| Eagle library path | — | Path to Eagle.app library for direct import |
| Eagle API token | — | Optional: auto-detect Eagle library path |

### Tuning Constants (`config.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `ABSORPTION_THRESHOLD` | 0.3 | Collection match threshold used by GroupStore absorption (30%) |
| `TAXONOMY_MIN_CLUSTER_SIZE` | 2 | HDBSCAN minClusterSize for taxonomy over category-name embeddings |
| `TAXONOMY_EPSILON_DEFAULT` | 0.3 | Default broad/specific slider position |
| `TAXONOMY_EPSILON_MIN` / `MAX` | 0.0 / 0.35 | Slider bounds for post-HDBSCAN merging |
| `MIN_DISCOVERY_COHESION` | 0.20 | Minimum cohesion for a discovery group to become a proposed category |
| `SYNC_BATCH_SIZE` | 200 | Items per sync batch |
| `EARLY_OUT_THRESHOLD` | 3 | Consecutive known batches before stopping |
| `TIKTOK_VIDEO_DOWNLOAD_TIMEOUT_MS` | 60_000 | Per-video download timeout |
| `MEDIA_DOWNLOAD_MAX_RETRIES` | 2 | Retry budget for media downloads |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint (vision + topic + rerank) |
| `EMBED_URL` | `http://localhost:11435` | Sidecar endpoint for the Phase F v2 fine-tuned embedder |
| `VISION_MODEL` | `minicpm-v` | Fallback image description model |
| `TOPIC_MODEL` | `llama3.2:3b` | Topic analysis + one-word category tag |
| `EVAL_MODEL` | `gemma4:e4b` | Reranker for the Smart Assign score-first ensemble + multi-frame vision |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model name (served by the sidecar with v2 fine-tune weights) |
| `EMBED_CONCURRENCY` | 3 | Parallel embed requests |
| `CARD_WIDTH` | 600 | Tweet card render width |
| `CARD_PADDING` | 32 | Tweet card padding |
| `CARD_MAX_LINES` | 15 | Max text lines on tweet card |

Score-first rerank constants live in `pipeline/evaluate.ts` rather than `config.ts` because they're coupled to the `PROMPT_VERSION` string and the catHash invariant: `K_RERANK_SMALL=5`, `K_RERANK_LARGE=7`, `CONDITIONAL_REJECT_THRESHOLD=0.87`.

### On-disk caches (`~/ObsidianBookmarks/.roost/`)

| File | Written by | Invalidation |
|------|-----------|--------------|
| `embedding-vectors.bin` + `embedding-cache.json` + `embedding-meta.json` | `describe-items.ts` / `shared.ts` | Vectors (768-dim Float32) live in `.bin`, text fields (vision/summary/category) in `.json`, a dim/model stamp in `-meta.json`. Per-field, incrementally filled; old schemas auto-migrate. Writes are atomic (temp+rename) and the load path is partial-tolerant — a truncated/missing `.bin` salvages its complete-vector prefix and keeps the text cache, so a bad `.bin` only costs cheap re-embedding (never re-running vision/topic) |
| `score-cache.json` | `evaluate.ts` | `{itemId}|{catHash}` — catHash hashes EVAL_MODEL + PROMPT_VERSION + every category's name and description |
| `category-embeddings.json` | `taxonomy.ts` | md5 of the sorted category-string list; cheap to re-cluster across epsilon changes |
| `collection-descriptions-contrastive.json` | `evaluate.ts` `generateClusterDescriptions` | Keyed by category name; regenerated when description is missing or explicitly cleared |
| `collection-not-descriptions.json` | `evaluate.ts` `generateClusterDescriptions` | Same key as above; stores the paired "NOT" clause |
| `digest-cache.json` | `digest-pipeline.ts` | Per-week cluster summary reuse |
| `roost-memory-cache.json` | `pipeline/memory/cache.ts` | Concept + claim routing decisions |
| `*-cache.json` (per pipeline) | Individual `*-pipeline.ts` runners | Recipe, places, media, etc. — see enrichments doc |

Cache paths use `packages/core/src/lib/roost-paths.ts` — prefer `cachePath()` over hardcoded `.roost/` strings in new code.

### Per-Platform Sync State (automatic)

| Field | Description |
|-------|-------------|
| `complete` | Whether last sync finished fully |
| `count` | Cumulative items synced |
| `timestamp` | When sync finished |

## Dependencies

- **motion** (v12) — Spring FLIP animations for card expansion
- **React 19** + **Radix UI** — Sidebar UI components
- **Tailwind CSS v3** — Styling (v4 breaks in Obsidian due to @layer specificity)
- **Vite** — Build system with PostCSS for Tailwind
- **Ollama** (external) — Local LLM for vision, topic analysis, embeddings (models configurable in `config.ts`)

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Build + deploy to Obsidian vault |
| `npm run build` | Build only (does NOT deploy) |
| `node scripts/reset-categories.mjs` | Preview category removal (dry run) |
| `node scripts/reset-categories.mjs --run` | Strip all `roost_category` from frontmatter |
