/**
 * Media extraction pipeline — finds book/film/anime/music/podcast bookmarks,
 * triages them, extracts structured media data, and writes notes organized
 * by media type.
 *
 * Data sources per item (in priority order):
 * 1. raw.json `videoSuggestWordsList` — TikTok entity extraction (often has exact titles)
 * 2. raw.json `contents` — structured line-by-line description
 * 3. frontmatter `title` — flattened caption
 * 4. frontmatter `subtitle` — speech-to-text transcript
 * 5. embedding cache `vision` — LLM description of video frames
 * 6. raw.json `challenges` — hashtags (booktok, filmtok, etc.)
 */
import { App, TFile } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, MUSIC_SUBCATEGORIES } from "@/config";
import { buildFileIndex, stripWikilink } from "@/lib/vault-utils";
import { extractSpotifyTrackIdFromTikTok } from "@/lib/extract";
import { updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import {
  loadEmbeddingCache,
  ollamaGenerate,
  readRawJson,
  extractDescription,
  loadPipelineCache,
  savePipelineCache,
  forEachBatch,
} from "@/pipeline/shared";
import {
  runCategoryPipeline,
  type CategoryPipelineConfig,
} from "@/pipeline/run-category-pipeline";
import { resolveTmdb } from "./resolvers/tmdb-resolver";
import { resolveAnilist } from "./resolvers/anilist-resolver";
import { canonicalizeTitle } from "./resolvers/resolver-utils";

/** Pipelines write enrichment data into the source bookmark's frontmatter
 *  rather than spawning a separate note. The pipeline_v_<id> field tracks
 *  the schema version so a future bump auto-flags items for re-extraction.
 *  Distinct namespace from enrichment_v_<id> so it doesn't collide with the
 *  pre-existing media file-backfill enrichment (different concept, same id).
 *  Phase D of the pipelines refactor unifies the two namespaces. */
/** v2 adds media_spotify_id resolution for music items and TMDB/AniList
 *  deep-link resolution for watchable items (Films/Series/Anime/Documentaries).
 *  Items extracted at v1 keep their extraction cache; the new steps pick up
 *  where they left off when the user re-runs the pipeline. */
const MEDIA_PIPELINE_VERSION = 2;
/** The registry id for this pipeline's enrichment. Kept as a local literal so
 *  the canonical version field (MEDIA_FIELDS.version, derived below) can be
 *  built WITHOUT a value import of enrichmentVersionField from @/lib/enrichments
 *  — that import would close the enrichments↔media-pipeline module cycle and
 *  crash module init (same failure class as plan 038A). The value matches
 *  enrichmentVersionField("mediaExtraction") === `enrichment_v_mediaExtraction`,
 *  asserted in the pipeline-runners harness characterization test. */
const MEDIA_ENRICHMENT_ID = "mediaExtraction" as const;

/** How many bookmark writes to run in parallel during the playback
 *  step. Resolution itself is sync; the bottleneck is vault.modify. */
const PLAYBACK_CONCURRENCY = 3;

// ── Types ──

type MediaType =
  | "book" | "film" | "series" | "anime" | "manga"
  | "music" | "podcast" | "documentary" | "game" | "other";

interface MediaExtraction {
  mediaType: MediaType;
  title: string;
  creator: string;
  genre: string;
  description: string;
  rating: string | null;
  where: string | null;
  // Resolved canonical deep-link ids (mirrors the wider roost.d.ts
  // MediaExtraction so reconstructMediaCache can carry them from frontmatter
  // to the gallery card without a cast). Optional so producers that don't
  // resolve ids still satisfy the type.
  spotifyId?: string | null;
  tmdbId?: string | null;
  tmdbType?: "movie" | "tv" | null;
  anilistId?: string | null;
  year?: number | null;
}

/** Cached playback-URL resolution for a music item. Spotify track ID
 *  comes from TikTok's tt2dsp mapping (free, no API call). `null`
 *  means we tried and there was no DSP data on this item.
 *  `undefined` on CacheEntry.playback means we haven't tried yet. */
interface PlaybackResolution {
  spotifyId: string | null;
  resolvedAt: string;
}

/** Cached watchable deep-link resolution for a Films/Series/Anime/
 *  Documentaries item. `tmdbId` is the TMDB id (drives Letterboxd URL);
 *  `anilistId` is for Anime. `null` inside means "tried, no match." A
 *  `lastError` set with `attempts < 3` triggers retry on the next run;
 *  `attempts >= 3` locks as permanent miss. */
export interface DeepLinkResolution {
  tmdbId: string | null;
  tmdbType: "movie" | "tv" | null;
  anilistId: string | null;
  resolvedAt: string;
  attempts: number;
  lastError?: string;
}

interface CacheEntry {
  triage: "media" | "skip";
  extraction: MediaExtraction | null;
  playback?: PlaybackResolution;
  deepLink?: DeepLinkResolution;
}


interface MediaCandidate {
  roostId: string;
  file: TFile;
  title: string;
  subtitle: string;
  description: string;
  vision: string;
  tags: string[];
  author: string;
  authorHandle: string;
  url: string;
  suggestWords: string[];
  /** Spotify track ID extracted directly from TikTok's raw.json — when
   *  a creator picks a Spotify song as their sound, TikTok stores the
   *  mapping under `music.tt2dsp.tt_to_dsp_song_infos[]` with
   *  `platform: 3`. No network or OAuth required. */
  spotifyTrackId: string | null;
  subcategory: string;
}

// ── Constants ──

/** Single source of truth for the roost_category / roost_subcategory values the
 *  media pipeline owns. Feeds FILED_MEDIA_CATEGORIES (the gather gate, lowercased)
 *  and MEDIA_EXTRACTION_ENRICHMENT.categoryMatches so the two can't desync. */
const MEDIA_FILED_CATEGORIES = ["Media", "Media List", "Books", "Book", "Film", "TV"] as const;

/** roost_category / roost_subcategory values the media pipeline owns. Exported
 *  for the single-source-of-truth test. */
export const FILED_MEDIA_CATEGORIES = new Set(MEDIA_FILED_CATEGORIES.map(c => c.toLowerCase()));

/** Tags that auto-triage as media without needing LLM. */
const FAST_PATH_TAGS = new Set([
  "booktok", "filmtok", "animetok", "movietok", "bookish",
  "readingtok", "mangatok", "musictok", "tbr",
]);

const VALID_MEDIA_TYPES = new Set<MediaType>([
  "book", "film", "series", "anime", "manga",
  "music", "podcast", "documentary", "game", "other",
]);

/** Display labels for the tabular BasesView. Pipeline storage uses the
 *  lowercase media_type values (book/film/etc.) directly; this map only
 *  exists for UI rendering. */
export const MEDIA_TYPE_DISPLAY: Record<MediaType, string> = {
  book: "Books",
  film: "Films",
  series: "Series",
  anime: "Anime",
  manga: "Manga",
  music: "Music",
  podcast: "Podcasts",
  documentary: "Documentaries",
  game: "Games",
  other: "Other",
};

/** Subcategories that get TMDB → Letterboxd or AniList deep-link resolution. */
const WATCHABLE_SUBCATEGORIES = new Set([
  "films",
  "series",
  "anime",
  "documentaries",
]);

const MAX_RESOLUTION_ATTEMPTS = 3;
const RESOLVER_CONCURRENCY = 3;

const CACHE_FILE = "media-cache.json";
const CONCURRENCY = 3;

// ── Helpers ──

function extractSuggestWords(raw: any): string[] {
  const structs = raw?.videoSuggestWordsList?.video_suggest_words_struct;
  if (!Array.isArray(structs)) return [];
  const words: string[] = [];
  for (const s of structs) {
    for (const w of (s.words || [])) {
      if (w.word) words.push(w.word);
    }
  }
  return words;
}

function normalizeMediaType(raw: string): MediaType {
  const lower = (raw || "").toLowerCase().trim();
  if (VALID_MEDIA_TYPES.has(lower as MediaType)) return lower as MediaType;
  // Common aliases
  if (lower === "movie") return "film";
  if (lower === "tv" || lower === "tv show" || lower === "television" || lower === "kdrama") return "series";
  if (lower === "album" || lower === "song" || lower === "soundtrack") return "music";
  if (lower === "comic") return "manga";
  if (lower === "video game") return "game";
  return "other";
}

/** Check if any tag matches the fast-path set. */
function hasMediaFastPath(tags: string[]): boolean {
  return tags.some(t => {
    const cleaned = t.toLowerCase().replace(/^#/, "");
    return FAST_PATH_TAGS.has(cleaned);
  });
}

// ── Candidate gathering ──

/** Returns the ids of bookmarks filed under a media category (`FILED_MEDIA_CATEGORIES`,
 *  matched on roost_category or roost_subcategory) or a music subcategory
 *  (`MUSIC_SUBCATEGORIES`). No readRawJson call, so this is cheap enough to use in
 *  the pending-pipeline scan. */
export function gatherMediaCandidateIds(app: App, syncFolder: string): Set<string> {
  const fileIndex = buildFileIndex(app, syncFolder);
  const ids = new Set<string>();
  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
    const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
    const filedMatch =
      FILED_MEDIA_CATEGORIES.has(filedCat) ||
      FILED_MEDIA_CATEGORIES.has(filedSub) ||
      MUSIC_SUBCATEGORIES.has(filedSub);
    if (filedMatch) ids.add(roostId);
  }
  return ids;
}

function gatherCandidates(
  app: App,
  syncFolder: string,
  filter?: { category: string; subcategory?: string },
): MediaCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const candidates: MediaCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    // Filter-scoped run (rule 1): when an active filter is passed, only
    // process bookmarks whose roost_category / roost_subcategory match.
    // Bypasses the embedding-category + tag-keyword discovery so the user
    // can iterate on a specific bucket without re-classifying everything.
    if (filter) {
      const fmCategory = typeof fm[CATEGORY_FIELD] === "string"
        ? (fm[CATEGORY_FIELD] as string).toLowerCase()
        : "";
      if (fmCategory !== filter.category.toLowerCase()) continue;
      if (filter.subcategory) {
        const fmSubcategory = typeof fm[SUBCATEGORY_FIELD] === "string"
          ? (fm[SUBCATEGORY_FIELD] as string).toLowerCase()
          : "";
        if (fmSubcategory !== filter.subcategory.toLowerCase()) continue;
      }
    } else {
      const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
      const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
      const filedMatch =
        FILED_MEDIA_CATEGORIES.has(filedCat) ||
        FILED_MEDIA_CATEGORIES.has(filedSub) ||
        MUSIC_SUBCATEGORIES.has(filedSub);
      if (!filedMatch) continue;
    }

    const embedded = embeddingCache[roostId];
    const rawTags: string[] = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).map(t => String(t).toLowerCase())
      : [];

    const raw = readRawJson(app.vault, syncFolder, roostId);
    const description = extractDescription(raw);
    const suggestWords = extractSuggestWords(raw);
    // raw is typed as Record<string, unknown> | null; cast inline at the
    // boundaries to TikTok's raw.json shape.
    const challenges = (raw?.challenges as Array<{title?: string}> | undefined) ?? [];
    const hashtags: string[] = challenges
      .map(c => c.title)
      .filter((t): t is string => Boolean(t));
    const rawAuthor = raw?.author as { uniqueId?: string } | undefined;
    const spotifyTrackId = extractSpotifyTrackIdFromTikTok(raw);

    candidates.push({
      roostId,
      file,
      title: fm.title || "",
      subtitle: fm.subtitle || "",
      description,
      vision: embedded?.vision || "",
      tags: [...new Set([...hashtags, ...rawTags])],
      author: fm.author ? stripWikilink(fm.author) : "",
      authorHandle: rawAuthor?.uniqueId || "",
      url: fm.url || "",
      suggestWords,
      spotifyTrackId,
      subcategory: typeof fm[SUBCATEGORY_FIELD] === "string" ? fm[SUBCATEGORY_FIELD] : "",
    });
  }

  return candidates;
}

// ── Triage ──

function buildTriagePrompt(c: MediaCandidate): string {
  const text = (c.description || c.title).slice(0, 1500);
  const transcript = c.subtitle ? c.subtitle.slice(0, 800) : "No transcript.";
  const visual = c.vision ? c.vision.slice(0, 300) : "No description.";
  const tags = c.tags.slice(0, 15).join(", ");
  const suggest = c.suggestWords.length > 0
    ? `\nSearch suggestions: ${c.suggestWords.slice(0, 5).join(", ")}`
    : "";

  return `You are classifying a social media bookmark.

Caption: ${text}
Transcript: ${transcript}
Visual: ${visual}
Hashtags: ${tags}${suggest}

Is this a RECOMMENDATION of a specific piece of media (book, film, TV show, anime, manga, music, podcast, documentary, or game) — naming or clearly showing a specific title?

Or is it general entertainment/lifestyle content NOT recommending a specific title?

Respond with ONLY one word: media or skip`;
}

async function triageItem(c: MediaCandidate): Promise<"media" | "skip"> {
  const raw = await ollamaGenerate(buildTriagePrompt(c), { numPredict: 5, numCtx: 2048 });
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.includes("skip")) return "skip";
  return "media";
}

// ── Extraction ──

function buildExtractPrompt(c: MediaCandidate): string {
  const sections: string[] = [];

  if (c.suggestWords.length > 0) {
    sections.push(`TikTok search suggestions (often contain exact titles): ${c.suggestWords.slice(0, 8).join(", ")}`);
  }

  if (c.description) {
    sections.push(`Description:\n${c.description.slice(0, 1500)}`);
  } else if (c.title) {
    sections.push(`Caption: ${c.title.slice(0, 1500)}`);
  }

  if (c.subtitle) {
    sections.push(`Video transcript: ${c.subtitle.slice(0, 800)}`);
  }

  if (c.vision) {
    sections.push(`Visual description: ${c.vision.slice(0, 400)}`);
  }

  if (c.tags.length > 0) {
    sections.push(`Tags: ${c.tags.slice(0, 15).join(", ")}`);
  }

  return `Extract the media recommendation from this social media video.
Identify the specific title being recommended or discussed.

${sections.join("\n\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "mediaType": "book|film|series|anime|manga|music|podcast|documentary|game|other",
  "title": "exact title of the media",
  "creator": "author, director, artist, or creator name",
  "genre": "genre (e.g. fantasy, thriller, romance, sci-fi, horror, drama, comedy, hip-hop, indie, etc.)",
  "description": "1-2 sentence summary of what it's about or why it was recommended",
  "rating": "any rating or opinion mentioned (e.g. '10/10', 'must read', 'underrated') or null",
  "where": "where to watch/read/listen (e.g. Netflix, Kindle, Spotify, Crunchyroll) or null"
}`;
}

async function extractMedia(c: MediaCandidate): Promise<MediaExtraction | null> {
  const raw = await ollamaGenerate(buildExtractPrompt(c), { numPredict: 1024, numCtx: 3072 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    const title = parsed.title || "";
    if (!title || title.toLowerCase() === "unknown") return null;

    return {
      mediaType: normalizeMediaType(parsed.mediaType),
      title,
      creator: parsed.creator || "Unknown",
      genre: parsed.genre || "Unknown",
      description: parsed.description || "",
      rating: parsed.rating && parsed.rating !== "null" ? parsed.rating : null,
      where: parsed.where && parsed.where !== "null" ? parsed.where : null,
    };
  } catch {
    console.warn(`[roost] media: failed to parse extraction for ${c.roostId}:`, cleaned.slice(0, 200));
    return null;
  }
}

// ── In-place enrichment write ──

/** Fields written by this pipeline onto the source bookmark's frontmatter.
 *  Exported so the migration command + the BasesView know the schema.
 *
 *  Notably absent: there's no media_type field. The extracted type drives
 *  the roost_subcategory backfill (rule 2) — keeping a separate media_type
 *  alongside roost_subcategory would let the two diverge under user
 *  curation. roost_subcategory is the single source of truth for "what
 *  kind of media is this"; the Media List groups by it. */
export const MEDIA_FIELDS = {
  title: "media_title",
  creator: "media_creator",
  genre: "media_genre",
  rating: "media_rating",
  where: "media_where",
  description: "media_description",
  spotifyId: "media_spotify_id",
  tmdbId: "media_tmdb_id",
  tmdbType: "media_tmdb_type",
  anilistId: "media_anilist_id",
  year: "media_year",
  version: `enrichment_v_${MEDIA_ENRICHMENT_ID}`,
} as const;

/** Write the extracted media fields onto the source bookmark's frontmatter.
 *  No-op when the frontmatter already matches (idempotent re-runs don't
 *  bump mtime).
 *
 *  Subcategory backfill (rule 2): when the bookmark's roost_subcategory
 *  is empty, map media_type to a display name and stamp it. Strict rules:
 *    - subcategory set to anything → never touch either field
 *    - subcategory empty AND category empty → set both ("Media", DisplayName)
 *    - subcategory empty AND category === "Media" → just set subcategory
 *    - subcategory empty AND category set to something else → user has
 *      explicit different intent; leave both alone
 *
 *  Result: the pipeline auto-organizes uncategorized items but never
 *  overrides the user's manual curation. */
async function writeMediaToBookmark(
  app: App,
  c: MediaCandidate,
  extraction: MediaExtraction | null,
  playback?: PlaybackResolution,
  deepLink?: DeepLinkResolution,
): Promise<void> {
  const updates: Record<string, FrontmatterValue> = {};
  if (extraction) {
    updates[MEDIA_FIELDS.title] = extraction.title;
    updates[MEDIA_FIELDS.creator] = extraction.creator;
    updates[MEDIA_FIELDS.genre] = extraction.genre;
    updates[MEDIA_FIELDS.rating] = extraction.rating;
    updates[MEDIA_FIELDS.where] = extraction.where;
    updates[MEDIA_FIELDS.description] = extraction.description || null;
    updates[MEDIA_FIELDS.year] = canonicalizeTitle(extraction.title).year;
    updates[MEDIA_FIELDS.version] = MEDIA_PIPELINE_VERSION;
  }
  // Only touch the playback field when we have a resolution to write —
  // omitting it preserves any prior value through an extraction-only
  // write pass.
  if (playback) {
    updates[MEDIA_FIELDS.spotifyId] = playback.spotifyId;
  }

  if (deepLink) {
    updates[MEDIA_FIELDS.tmdbId] = deepLink.tmdbId;
    updates[MEDIA_FIELDS.tmdbType] = deepLink.tmdbType;
    updates[MEDIA_FIELDS.anilistId] = deepLink.anilistId;
  }

  // Nothing to write — caller invoked with no extraction and no
  // playback or deepLink. (Shouldn't normally happen but avoids a
  // no-op disk read.)
  if (Object.keys(updates).length === 0) return;

  const fm = app.metadataCache.getFileCache(c.file)?.frontmatter ?? {};
  const existingSubcategory = typeof fm[SUBCATEGORY_FIELD] === "string" ? fm[SUBCATEGORY_FIELD] : null;
  // Subcategory backfill: only when the note is already filed under Media and
  // has no subcategory. Never assign a fresh roost_category.
  if (extraction && !existingSubcategory) {
    const existingCategory = typeof fm[CATEGORY_FIELD] === "string" ? fm[CATEGORY_FIELD] : null;
    if (existingCategory === "Media") {
      updates[SUBCATEGORY_FIELD] = MEDIA_TYPE_DISPLAY[extraction.mediaType];
    }
  }

  const content = await app.vault.read(c.file);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated && updated !== content) {
    await app.vault.modify(c.file, updated);
  }
}

// ── Playback URL resolution ──

/** Resolve the Spotify track ID for a music item from TikTok's
 *  tt2dsp mapping. Items without DSP data return null; the view
 *  falls back to cached video playback or no affordance. */
function resolvePlaybackForItem(c: MediaCandidate): PlaybackResolution {
  return {
    spotifyId: c.spotifyTrackId ?? null,
    resolvedAt: new Date().toISOString(),
  };
}

// ── Watchable deep-link resolution helpers ──

/** True when the cache entry needs (re-)resolution: never tried, or
 *  transient failure with retry budget remaining. */
function needsWatchableResolution(prior?: DeepLinkResolution): boolean {
  if (!prior) return true;
  const hasAnyId = prior.tmdbId != null || prior.anilistId != null;
  if (hasAnyId) return false;
  if (prior.attempts >= MAX_RESOLUTION_ATTEMPTS) return false;
  return true;
}

/** Resolve a single watchable candidate. Errors are captured in `lastError`
 *  rather than thrown — the pipeline keeps going. */
async function resolveWatchableForItem(
  c: MediaCandidate,
  extraction: MediaExtraction | null,
  tmdbApiKey: string,
  prior?: DeepLinkResolution,
): Promise<DeepLinkResolution> {
  const subcategory = c.subcategory.toLowerCase();
  const now = new Date().toISOString();

  if (!extraction || !WATCHABLE_SUBCATEGORIES.has(subcategory)) {
    return {
      tmdbId: null, tmdbType: null, anilistId: null,
      resolvedAt: now, attempts: MAX_RESOLUTION_ATTEMPTS,
    };
  }

  const { title, year } = canonicalizeTitle(extraction.title);
  if (!title) {
    return {
      tmdbId: null, tmdbType: null, anilistId: null,
      resolvedAt: now, attempts: MAX_RESOLUTION_ATTEMPTS,
    };
  }

  const nextAttempts = (prior?.attempts ?? 0) + 1;

  try {
    if (subcategory === "anime") {
      const r = await resolveAnilist({ title });
      return {
        tmdbId: null, tmdbType: null,
        anilistId: r.anilistId,
        resolvedAt: now,
        attempts: r.anilistId ? 0 : nextAttempts,
        lastError: r.error,
      };
    }

    const r = await resolveTmdb({ title, year, subcategory }, tmdbApiKey);
    return {
      tmdbId: r.tmdbId,
      tmdbType: r.tmdbType,
      anilistId: null,
      resolvedAt: now,
      attempts: r.tmdbId ? 0 : nextAttempts,
      lastError: r.error,
    };
  } catch (err) {
    return {
      tmdbId: null, tmdbType: null, anilistId: null,
      resolvedAt: now,
      attempts: nextAttempts,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main pipeline ──

interface MediaPipelineResult {
  candidates: number;
  media: number;
  skipped: number;
  errors: number;
  types: number;
  /** Music items whose Spotify track ID we resolved this run (matched
   *  + cached). Diagnostic only — items without DSP data cache as
   *  `spotifyId: null`. */
  playbackResolved?: number;
  letterboxdResolved?: number;
  anilistResolved?: number;
}

export async function runMediaPipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
  filter?: { category: string; subcategory?: string },
  // tmdbApiKey: TMDB resolution only works when passed explicitly (e.g. from
  // the dedicated Cmd+P backfill command in Task 9, which has plugin reference
  // and can read plugin.settings.tmdbApiKey). The registry call site does NOT
  // pass it, so Films/Series/Documentaries get null results there — the
  // render-time search-URL fallback still works. AniList (anime) always works
  // because it needs no key.
  tmdbApiKey: string = "",
  signal?: AbortSignal,
): Promise<MediaPipelineResult> {
  // Post-stage counters: mutated by afterCore, read by buildResult (closures).
  let playbackResolved = 0;
  let letterboxdResolved = 0;
  let anilistResolved = 0;

  const config: CategoryPipelineConfig<
    MediaCandidate,
    MediaExtraction,
    "media" | "skip",
    MediaPipelineResult,
    CacheEntry
  > = {
    cacheFile: CACHE_FILE,
    concurrency: CONCURRENCY,
    extractVerdict: "media",
    skipVerdict: "skip",
    onExtractFailure: "demote",
    onTriageFailure: "skip",
    // Stamp cached items BEFORE the slow LLM passes so the Media list table
    // populates immediately, then grows as triage + extraction land more items.
    backfillCachedFirst: true,
    gatherCandidates: (a, sf) => gatherCandidates(a, sf, filter),
    fastPathTriage: c => (hasMediaFastPath(c.tags) ? "media" : null),
    triageItem,
    extractItem: extractMedia,
    onExtractError: (roostId, err) =>
      console.warn(`[roost] media: extraction error for ${roostId}:`, err),
    writeToBookmark: (a, c, ex) => writeMediaToBookmark(a, c, ex),
    // Cached stamps carry the entry's playback + deepLink through.
    writeCachedToBookmark: (a, c, entry) =>
      writeMediaToBookmark(a, c, entry.extraction!, entry.playback, entry.deepLink),
    afterCore: async ({ app: a, candidates, cache, log }) => {
      const vault = a.vault;

      // 5. Resolve playback URLs for music items. Three signals qualify a
      //    candidate as music (any one is enough): TikTok DSP data,
      //    user-curated Music subcategory, or LLM-extracted music type.
      //    The user-curated path matters because the LLM often classifies
      //    music videos as podcast/other.
      const isMusicCandidate = (c: MediaCandidate): boolean => {
        if (c.spotifyTrackId) return true;
        if (cache[c.roostId]?.extraction?.mediaType === "music") return true;
        const fm = a.metadataCache.getFileCache(c.file)?.frontmatter;
        const subcat = fm?.[SUBCATEGORY_FIELD];
        return typeof subcat === "string" && MUSIC_SUBCATEGORIES.has(subcat.toLowerCase());
      };
      const musicItems = candidates.filter(isMusicCandidate);
      const needPlayback = musicItems.filter(c => cache[c.roostId]?.playback === undefined);
      if (musicItems.length > 0) {
        log(`Playback step: ${musicItems.length} music items in scope (${needPlayback.length} need resolution)`);
      }
      if (needPlayback.length > 0) {
        log(`Resolving Spotify track IDs for ${needPlayback.length} items...`);
        // Resolution is sync (just reads c.spotifyTrackId); writes are
        // async (vault.modify). Parallelize the writes within each batch.
        await forEachBatch(needPlayback, PLAYBACK_CONCURRENCY, async (batch, startIndex) => {
          await Promise.all(batch.map(async (c) => {
            const playback = resolvePlaybackForItem(c);
            // Items reached via TikTok-DSP or user-curated subcategory
            // signals may not have a CacheEntry yet (no triage was ever
            // run on them). Create a minimal one so the playback persists.
            const existing = cache[c.roostId];
            if (existing) existing.playback = playback;
            else cache[c.roostId] = { triage: "skip", extraction: null, playback };
            await writeMediaToBookmark(a, c, cache[c.roostId].extraction, playback);
            if (playback.spotifyId) playbackResolved++;
          }));
          savePipelineCache(vault, CACHE_FILE, cache);
          const done = startIndex + batch.length;
          log(`Resolved ${done}/${needPlayback.length} (Spotify: ${playbackResolved})`);
        });
      }

      // 6. Resolve watchable deep links (Films/Series/Anime/Documentaries → Letterboxd or AniList)
      // Non-anime watchables need the TMDB key; if it's not configured, skip them
      // entirely rather than burning attempts. Items stay with `deepLink: undefined`
      // so a future run after the key gets set picks them up cleanly.
      const tmdbConfigured = Boolean(tmdbApiKey);
      let skippedNoTmdbKey = 0;
      const needDeepLink = candidates.filter((c) => {
        const sub = c.subcategory.toLowerCase();
        if (!WATCHABLE_SUBCATEGORIES.has(sub)) return false;
        const entry = cache[c.roostId];
        if (!entry?.extraction) return false;
        if (!needsWatchableResolution(entry.deepLink)) return false;
        if (sub !== "anime" && !tmdbConfigured) {
          skippedNoTmdbKey++;
          return false;
        }
        return true;
      });
      if (skippedNoTmdbKey > 0) {
        log(`Skipping ${skippedNoTmdbKey} Letterboxd item(s) — TMDB API key not configured in plugin settings.`);
      }

      if (needDeepLink.length > 0) {
        log(`Resolving watchable deep links for ${needDeepLink.length} items...`);
        let done = 0;
        await forEachBatch(needDeepLink, RESOLVER_CONCURRENCY, async batch => {
          const results = await Promise.all(
            batch.map((c) =>
              resolveWatchableForItem(
                c,
                cache[c.roostId]!.extraction,
                tmdbApiKey,
                cache[c.roostId]!.deepLink,
              ),
            ),
          );
          for (let j = 0; j < batch.length; j++) {
            const c = batch[j];
            const deepLink = results[j];
            cache[c.roostId] = { ...cache[c.roostId]!, deepLink };
            if (deepLink.tmdbId) letterboxdResolved++;
            if (deepLink.anilistId) anilistResolved++;
            await writeMediaToBookmark(a, c, cache[c.roostId]!.extraction!, undefined, deepLink);
            done++;
          }
          savePipelineCache(vault, CACHE_FILE, cache);
          log(`Resolved ${done}/${needDeepLink.length} (Letterboxd: ${letterboxdResolved}, AniList: ${anilistResolved})`);
        });
      }
    },
    buildResult: (candidates, cache, errors) => ({
      candidates: candidates.length,
      media: candidates.filter(
        c => cache[c.roostId]?.triage === "media" && cache[c.roostId]?.extraction,
      ).length,
      skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
      errors,
      // Distinct media types present across all extracted bookmarks.
      types: new Set(
        candidates
          .filter(c => cache[c.roostId]?.extraction)
          .map(c => cache[c.roostId].extraction!.mediaType),
      ).size,
      playbackResolved,
      letterboxdResolved,
      anilistResolved,
    }),
    log: {
      candidatesFound: n => `Found ${n} media candidates`,
      triageExtractCounts: (uncached, needExtract, complete) =>
        `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
      fastPath: n => `Tag fast-path: ${n} items auto-triaged as media`,
      triageProgress: (done, total) => `Triaged ${done}/${total}`,
      wroteCached: n => `Stamped ${n} cached extractions onto bookmarks`,
      extracting: n => `Extracting ${n} media items...`,
      extractProgress: (done, total) => `Extracted ${done}/${total}`,
      done: r => `Done: ${r.media} media items across ${r.types} types, ${r.skipped} skipped, ${r.errors} errors`,
    },
  };

  return runCategoryPipeline(app, syncFolder, config, onLog, signal);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the media pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with pipeline_v_media or enrichment_v_mediaExtraction set,
 *  reads the media_* fields, and returns a cache record keyed by roost_id. */
/** Read an id-style frontmatter value (mirrors media-list.ts parseNullableId):
 *  absent / empty / literal "null" → null; a trimmed non-empty string → that
 *  string. Collapses both "key absent" and "present-but-empty" to null since
 *  the rebuilt extraction only needs the resolved value or its absence. */
function readNullableIdFm(fm: Record<string, unknown>, key: string): string | null {
  const raw = fm[key];
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.toLowerCase() === "null") return null;
  return t;
}

export function reconstructMediaCache(
  app: App,
): Record<string, { triage: "media"; extraction: MediaExtraction }> {
  const out: Record<string, { triage: "media"; extraction: MediaExtraction }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || (typeof fm.pipeline_v_media !== "number" && typeof fm.enrichment_v_mediaExtraction !== "number")) continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    const tmdbTypeRaw = fm[MEDIA_FIELDS.tmdbType];
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
        // Carry the resolved canonical deep-link ids so the gallery card can
        // build canonical (not just search) links even when the cache file was
        // wiped and rebuilt from frontmatter.
        spotifyId: readNullableIdFm(fm, MEDIA_FIELDS.spotifyId),
        tmdbId: readNullableIdFm(fm, MEDIA_FIELDS.tmdbId),
        tmdbType: tmdbTypeRaw === "movie" || tmdbTypeRaw === "tv" ? tmdbTypeRaw : null,
        anilistId: readNullableIdFm(fm, MEDIA_FIELDS.anilistId),
        year: typeof fm[MEDIA_FIELDS.year] === "number" ? fm[MEDIA_FIELDS.year] as number : null,
      },
    };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const MEDIA_EXTRACTION_ENRICHMENT: EnrichmentDef = {
  id: MEDIA_ENRICHMENT_ID,
  displayName: "Media (books, films, shows, music, podcasts)",
  schemaVersion: MEDIA_PIPELINE_VERSION,
  commandId: "run-media-pipeline",
  commandName: "Run Media extraction pipeline",
  cacheFile: CACHE_FILE,
  gatherCandidateIds: gatherMediaCandidateIds,
  pendingExtractVerdict: "media",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructMediaCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runMediaPipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog, opts?.filter, "", opts?.signal);
  },
  panelDetail: "Extract titles, creators, ratings, and where-to-watch links. Writes media_* fields onto each source bookmark.",
  categoryMatches: [...MEDIA_FILED_CATEGORIES],
  fieldsWritten: ["media_title", "media_creator", "media_genre", "media_rating", "media_where", "media_year", "media_spotify_id", "media_tmdb_id", "media_tmdb_type", "media_anilist_id", "media_description"],
  legacyAliases: ["pipeline_v_media"],
  chips: [
    { field: "media_rating", kind: "rating" },
    { field: "media_genre", kind: "tag" },
    { field: "media_where", kind: "where" },
  ],
};

