# Plan 033: Backfill video transcripts via local ASR (Whisper) so silent recipe demos can be extracted

> **Type: design + phased implementation.** This plan introduces a new local-ASR
> capability and has two open decisions (ASR engine, scope) called out under
> "Decisions to confirm". Confirm those with the maintainer before Phase 2; Phase
> 1 (sidecar `/transcribe` endpoint) is safe to build immediately.

## Base / status

- **Planned at**: integrated head `94f9c78` (origin/main + session work), 2026-06-12.
- **Depends on**: **plan 032** (gather-by-subcategory). Without 032 these notes
  never enter the recipe pipeline, so a backfilled transcript would be ignored.
- **Priority**: P2 · **Effort**: L · **Risk**: MED (new dependency + model download).

## Why this matters

The recipe gap analysis found that the **single largest recoverable bucket — 29
of 98 (30%)** — is genuine recipe demos where the cook is on-screen but there is
**no transcript** (`subtitle.vtt` absent) and the caption is just a dish name
(`@laurent.dagenais` grilled halibut, `@thatfoodiejess` claypot rice,
`@omuraisupuro` omurice). The recipe extractor's strongest signal (data source
#3, the `subtitle` transcript) is missing, so it has nothing to extract.

TikTok's `subtitle.vtt` only exists when TikTok auto-captioned the video and the
sync downloaded it (3760/7627 notes have one). The pipeline can **consume** a
transcript but never **generates** one. This plan adds local speech-to-text so we
produce a transcript from the video we already have, then re-extract.

**Feasibility (verified):** of the 52 no-transcript Recipes notes, **29 already
have `video.mp4` on disk** — ASR can run on them immediately. The other 23 lack
the video and would need a webview re-fetch (deferred — see Phase 3 / out of
scope). The project already ships **ffmpeg detection** (`integrations/registry.ts`)
and an optional **Python embedding sidecar** (`scripts/embed-sidecar.py`), so the
ASR engine has a natural home.

## Current state (the pieces this builds on)

- `scripts/embed-sidecar.py` — a stdlib HTTP server (port 11435) that loads a
  sentence-transformer and serves `/api/embed` + `/api/tags`. Python venv already
  installs `torch` (`scripts/requirements.txt`). Adding a `/transcribe` route +
  a Whisper model fits the existing shape.
- `integrations/registry.ts` — `ffmpeg` integration (detects `ffmpeg`+`ffprobe`)
  and the `sidecar` integration (HTTP-probes `:11435/api/tags`). Pattern to mirror
  for an ASR-availability flag.
- TikTok attach folders: `Bookmarks/TikTok/tiktok-<id>/` hold `video.mp4`,
  `cover.jpg`, `raw.json`, and (when present) `subtitle.vtt`.
- The recipe pipeline reads the transcript from frontmatter `subtitle`
  (recipe-pipeline.ts:149, `fm.subtitle`), which the sync sets from `subtitle.vtt`
  via `parseWebVTT` (see `resync-runner.ts` TikTok branch). So writing a
  `subtitle.vtt` + setting `subtitle` frontmatter is enough for extraction to use it.
- Enrichment-registry + backfill pattern: `sync/media-backfill.ts` (no-network
  walk → per-item work → stamp version) and `sync/tweet-body-backfill.ts` (plan
  031) are the templates for a new backfill driver.

## Recommended design

A new **`transcript` enrichment** (registry entry + backfill command), decoupled
from recipes so it's reusable, but initially **scoped to recipe candidates** to
bound cost. Flow per eligible note:

```
video.mp4 (on disk)
  → ffmpeg: extract 16kHz mono WAV  (ffmpeg -i video.mp4 -ar 16000 -ac 1 -f wav -)
  → POST audio to sidecar /transcribe  → { text, vtt }
  → write Bookmarks/TikTok/tiktok-<id>/subtitle.vtt + set frontmatter `subtitle`
  → stamp enrichment_v_transcript
Then: re-run the Recipe pipeline (plan 032) → the 29 now have a transcript to extract from.
```

**ASR engine — recommendation: `faster-whisper`** (CTranslate2 backend) added to
the sidecar. It's fast on CPU/MPS, small models (`base` ≈140MB, `small` ≈460MB),
and the venv already has the Python toolchain. Alternative: a `whisper.cpp`
binary via `child_process` (no Python dep, but a binary to vendor/build). See
Decisions.

## Phases

### Phase 1 — `/transcribe` endpoint in the sidecar (safe to build now)

- `scripts/embed-sidecar.py`: add a `POST /transcribe` handler that accepts WAV
  audio bytes (or a `{path}` to a local file) and returns
  `{ "text": "...", "vtt": "WEBVTT\n..." }`. Lazy-load the Whisper model on first
  use (mirror the existing lazy `load_model`). Add a `--asr-model` arg (default
  `base`). Keep `/api/tags` reporting `asr_loaded` so detection can probe it.
- `scripts/requirements.txt`: add `faster-whisper` (and document the model cache
  location, like the embedding model).
- `scripts/setup-integrations.sh`: the sidecar venv install already covers it;
  note the first `/transcribe` downloads the ASR model.
- **Verify:** start the sidecar; `curl` a short WAV to `/transcribe` returns text.
  (Manual — there is no e2e for the sidecar.)

### Phase 2 — `transcript` enrichment + backfill driver

- `packages/core/src/integrations/` + `registry.ts`: add detection that the
  sidecar's `/transcribe` is available (probe `/api/tags` for `asr_loaded`/a
  capability flag), gated like the existing `sidecar` integration.
- New `packages/core/src/sync/transcript-backfill.ts` mirroring
  `media-backfill.ts`: walk `Bookmarks/TikTok` for notes that (a) are recipe
  candidates [scope decision], (b) lack `subtitle.vtt`, (c) have `video.mp4`.
  For each: run ffmpeg to extract audio (reuse the ffmpeg invocation helper used
  by the vision/frame path — find it via `integrations/` / `describe-items.ts`),
  POST to the sidecar, write `subtitle.vtt` + set the `subtitle` frontmatter via
  `updateNoteFrontmatter`, stamp `enrichment_v_transcript`. Resumable cache +
  `Notice` summary.
- Register `TRANSCRIPT_ENRICHMENT: EnrichmentDef` (id `"transcript"`, command
  "Backfill video transcripts") in `lib/enrichments.ts` (add `"transcript"` to
  the `EnrichmentId` union + the `IncompleteByCategory` bucket + a detection
  predicate in `vault-index.ts`, exactly as plan 031 did for `tweetBody`).
- **Verify:** typecheck 0; unit test the driver's candidate selection + the
  VTT-write path with a mocked sidecar client (mirror media-backfill tests).

### Phase 3 (optional, deferred) — re-fetch the 23 missing videos

The 23 no-transcript Recipes notes without `video.mp4` need the video re-fetched
through the TikTok webview (the `downloadTikTokVideo` path in `resync-runner.ts`)
before ASR can run. This is a separate, heavier change (needs a live webview) —
**out of scope** unless the maintainer wants it; note it and stop.

## Decisions to confirm (before Phase 2)

1. **ASR engine**: `faster-whisper` in the sidecar (recommended — reuses the
   venv) vs a `whisper.cpp` binary via `child_process` (no Python dep). 
2. **Scope**: recipe candidates only (≈29 notes now, bounded cost) vs all TikTok
   videos lacking a transcript (≈3800 — large one-time ASR run, but benefits every
   pipeline, not just recipes).
3. **Model size**: `base` (fast, good enough for clear cooking narration) vs
   `small` (more accurate, ~3× slower).

## Done criteria (Phase 1+2)

- [ ] Sidecar `POST /transcribe` returns `{text, vtt}` for a WAV (manual curl).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` ≥ baseline; new tests for the transcript driver pass.
- [ ] `grep -n '"transcript"' packages/core/src/lib/enrichments.ts` present
      (union + ENRICHMENTS).
- [ ] Running "Backfill video transcripts" on the vault writes `subtitle.vtt` for
      recipe-candidate videos that lacked one (manual spot-check on a few of the
      29 handles, e.g. `@laurent.dagenais`).
- [ ] After backfill, re-running the Recipe pipeline extracts recipes for a
      meaningful share of the 29 (manual: count new `recipe_ingredients`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The sidecar venv can't install `faster-whisper` on the target Python (report
  the error; consider the `whisper.cpp` alternative).
- No reusable ffmpeg audio-extraction helper exists and adding one would touch
  out-of-scope modules — STOP and report (a small new helper in the backfill file
  is fine; rewiring `describe-items.ts` is not).
- Phase 3 (video re-fetch) turns out to be required for the maintainer's chosen
  scope — STOP and confirm before building the webview path.

## Maintenance notes

- ASR is **best-effort**: noisy/music-only videos yield poor transcripts; the
  recipe extractor's empty→null+retry (plan 032) means a bad transcript just
  leaves the note unextracted rather than writing a garbage recipe.
- Keeping the `transcript` enrichment generic (not recipe-specific) means a later
  "Films/Education" pipeline can reuse the transcripts; the recipe scope is only a
  cost guard on the initial run.
- The sidecar now loads two models (embeddings + ASR); document the added memory
  footprint and keep ASR lazy-loaded so embedding-only users don't pay for it.
