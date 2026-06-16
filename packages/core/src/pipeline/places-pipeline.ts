/**
 * Places extraction pipeline — finds travel/location bookmarks, triages them,
 * extracts structured place data, and writes actionable travel notes organized
 * by country and city.
 *
 * Data sources per item (in priority order):
 * 1. raw.json `poi` — TikTok's structured point-of-interest (name, city, address, type)
 * 2. raw.json `videoSuggestWordsList` — TikTok's entity-extracted search suggestions
 * 3. raw.json `contents` — structured line-by-line description
 * 4. frontmatter `title` — flattened caption
 * 5. frontmatter `subtitle` — speech-to-text transcript
 * 6. embedding cache `vision` — LLM description of video frames
 * 7. raw.json `author.signature` — creator bio, may contain location info
 */
import { App, TFile, Vault } from "obsidian";
import * as fs from "fs";
import { buildFileIndex, stripWikilink, vaultBasePath } from "@/lib/vault-utils";
import { cachePath, cacheDir } from "@/lib/roost-paths";
import { updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import {
  loadEmbeddingCache,
  ollamaGenerate,
  readRawJson,
  extractDescription,
  loadPipelineCache,
  savePipelineCache,
} from "@/pipeline/shared";
import {
  runCategoryPipeline,
  type CategoryPipelineConfig,
} from "@/pipeline/run-category-pipeline";
import { resolveGeoNames } from "@/lib/geonames";
import { nominatimSearch } from "@/lib/nominatim";

// ── Types ──

type PlaceType =
  | "restaurant" | "hotel" | "landmark" | "park" | "neighborhood"
  | "viewpoint" | "beach" | "museum" | "shop" | "cafe" | "bar" | "other";

interface PlaceExtraction {
  name: string;
  city: string;
  country: string;
  placeType: string;  // widened to string so the exported public API matches roost.d.ts
  description: string;
  vibes: string[];
  bestFor: string;
  tips: string[];
  address: string | null;
  cityCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** True when coords came from a Nominatim POI-level match (venue, landmark,
   *  or street address). Mirrors the canonical PlaceExtraction in roost.d.ts. */
  isExact?: boolean;
}

type PlaceTriage = "place" | "skip";

interface PlaceCacheEntry {
  triage: PlaceTriage;
  extraction: PlaceExtraction | null;
}

interface PoiData {
  name: string;
  city: string;
  address: string;
  countryCode: string;
  cityCode: string;
  ttTypeNameTiny: string;
  ttTypeNameSuper: string;
}

interface PlaceCandidate {
  roostId: string;
  file: TFile;
  title: string;
  subtitle: string;
  description: string;
  vision: string;
  tags: string[];
  author: string;
  authorHandle: string;
  authorSignature: string;
  url: string;
  poi: PoiData | null;
  suggestWords: string[];
}

interface PlacesPipelineResult {
  candidates: number;
  places: number;
  skipped: number;
  errors: number;
  countries: number;
}

// ── Constants ──

const PLACE_CATEGORY_SUBSTRINGS = [
  "travel", "architecture", "restaurant", "landscape", "nature",
];

const PLACE_TAG_KEYWORDS = [
  "travel", "destination", "hotel", "restaurant", "vacation",
  "landmark", "explore", "trip", "nature", "landscape",
  "architecture", "sightseeing", "wanderlust",
];

const VALID_PLACE_TYPES = new Set<PlaceType>([
  "restaurant", "hotel", "landmark", "park", "neighborhood",
  "viewpoint", "beach", "museum", "shop", "cafe", "bar", "other",
]);

const CACHE_FILE = "places-cache.json";
const CACHE_VERSION_FILE = "places-cache.version";
// Bump when we add fields that can be backfilled from raw.json without an LLM.
// v2: adds cityCode/lat/lng from GeoNames lookup.
// v3: upgrades lat/lng to Nominatim-resolved POI-level coords when available,
//     adds isExact flag. City-level fallback unchanged.
const CACHE_VERSION = 3;
const CONCURRENCY = 3;

const PLACE_PIPELINE_VERSION = 1;

export const PLACE_FIELDS = {
  name: "place_name",
  city: "place_city",
  country: "place_country",
  type: "place_type",
  address: "place_address",
  bestFor: "place_best_for",
  lat: "place_lat",
  lng: "place_lng",
  description: "place_description",
  vibes: "place_vibes",
  tips: "place_tips",
  version: "enrichment_v_place",
} as const;

// Geography-only POI types that don't denote a specific visitable place
const GEO_ONLY_TYPES = new Set([
  "Province", "District", "City", "Country", "Region", "Area",
  "Continent", "State", "County",
]);

// GeoNames numeric country codes observed in vault data
const GEONAMES_COUNTRY: Record<string, string> = {
  "6252001": "United States",
  "2635167": "United Kingdom",
  "6251999": "Canada",
  "3175395": "Italy",
  "1861060": "Japan",
  "2921044": "Germany",
  "3017382": "France",
  "3996063": "Mexico",
  "1605651": "Thailand",
  "3144096": "Norway",
  "2658434": "Switzerland",
  "2077456": "Australia",
  "2510769": "Spain",
  "1562822": "Vietnam",
  "1643084": "Indonesia",
  "2802361": "Belgium",
  "1880251": "Singapore",
  "2750405": "Netherlands",
  "1694008": "Philippines",
  "798544":  "Poland",
  "2264397": "Portugal",
  "1835841": "South Korea",
  "2661886": "Sweden",
  "3469034": "Brazil",
  "3865483": "Argentina",
  "3595528": "Guatemala",
  "2782113": "Austria",
  "4566966": "Puerto Rico",
  "298795":  "Turkey",
  "690791":  "Ukraine",
  "1668284": "Taiwan",
  "1269750": "India",
  "2623032": "Denmark",
  "2963597": "Ireland",
  "390903":  "Greece",
  "2186224": "New Zealand",
  "1327865": "Myanmar",
  "1733045": "Malaysia",
  "1814991": "China",
  "1220409": "Tajikistan",
  "2205218": "Fiji",
  "1168579": "Pakistan",
  "192950":  "Kenya",
  "2139685": "New Caledonia",
  "1149361": "Afghanistan",
  "3582678": "Martinique",
  "2542007": "Morocco",
};

function resolveCountry(countryCode: string): string | null {
  return GEONAMES_COUNTRY[countryCode] ?? null;
}

// ── Helpers ──

function extractPoi(raw: any): PoiData | null {
  const poi = raw?.poi;
  if (!poi || !poi.name) return null;
  return {
    name: poi.name,
    city: poi.city || "",
    address: poi.address || "",
    countryCode: String(poi.countryCode || ""),
    cityCode: String(poi.cityCode || ""),
    ttTypeNameTiny: poi.ttTypeNameTiny || "",
    ttTypeNameSuper: poi.ttTypeNameSuper || "",
  };
}

/**
 * Resolve a POI to coordinates via the full chain:
 *   1. Nominatim(name + city + country) — exact venue or landmark
 *   2. Nominatim(address) — street-address geocode
 *   3. GeoNames cities[cityCode] or cities[name+iso] — offline city-level fallback
 *
 * Nominatim hits set isExact=true so the map can skip per-pin jitter for them.
 * City-level fallbacks set isExact=false. Returns null if nothing resolves.
 */
async function resolvePoiCoords(
  vault: Vault,
  poi: PoiData,
): Promise<{ coords: [number, number]; isExact: boolean } | null> {
  const country = resolveCountry(poi.countryCode) || "";

  const query1 = [poi.name, poi.city, country].filter(Boolean).join(", ");
  if (query1) {
    const hit = await nominatimSearch(vault, query1);
    if (hit) return { coords: hit.coords, isExact: true };
  }

  // Only hit Nominatim a second time if address adds info beyond name+city
  // (TikTok sometimes puts "Italy" or "Como" in address — redundant).
  if (poi.address && poi.address.length > 3 && poi.address !== country) {
    const hit = await nominatimSearch(vault, poi.address);
    if (hit) return { coords: hit.coords, isExact: true };
  }

  const coords = resolveGeoNames(poi.cityCode, poi.city, poi.name, poi.countryCode);
  if (coords) return { coords, isExact: false };

  return null;
}

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

/** Auto-triage from POI type. Returns "place" for specific venues, null if uncertain. */
function triageFromPoi(poi: PoiData): PlaceTriage | null {
  if (GEO_ONLY_TYPES.has(poi.ttTypeNameTiny)) return null;
  if (poi.name) return "place";
  return null;
}

function normalizePlaceType(raw: string): PlaceType {
  const lower = (raw || "").toLowerCase().trim();
  if (VALID_PLACE_TYPES.has(lower as PlaceType)) return lower as PlaceType;
  return "other";
}

// ── Candidate gathering ──

function gatherCandidates(app: App, syncFolder: string): PlaceCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const candidates: PlaceCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const embedded = embeddingCache[roostId];
    const category = (embedded?.category || "").toLowerCase().replace(/[^a-z]/g, "");
    const rawTags: string[] = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).map(t => String(t).toLowerCase())
      : [];

    const categoryMatch = PLACE_CATEGORY_SUBSTRINGS.some(sub => category.includes(sub));
    const tagMatch = rawTags.some(t => PLACE_TAG_KEYWORDS.some(kw => t.includes(kw)));
    if (!categoryMatch && !tagMatch) continue;

    const raw = readRawJson(app.vault, syncFolder, roostId);
    const description = extractDescription(raw);
    const poi = extractPoi(raw);
    const suggestWords = extractSuggestWords(raw);
    // raw is typed as Record<string, unknown> | null; cast inline at the
    // boundaries to TikTok's raw.json shape (challenges + author).
    const challenges = (raw?.challenges as Array<{title?: string}> | undefined) ?? [];
    const hashtags: string[] = challenges
      .map(c => c.title)
      .filter((t): t is string => Boolean(t));
    const rawAuthor = raw?.author as { uniqueId?: string; signature?: string } | undefined;

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
      authorSignature: rawAuthor?.signature || "",
      url: fm.url || "",
      poi,
      suggestWords,
    });
  }

  return candidates;
}

// ── Triage ──

function buildTriagePrompt(c: PlaceCandidate): string {
  const text = (c.description || c.title).slice(0, 1000);
  const transcript = c.subtitle ? c.subtitle.slice(0, 500) : "No transcript.";
  const visual = c.vision ? c.vision.slice(0, 200) : "No description.";
  const tags = c.tags.slice(0, 10).join(", ");

  return `You are classifying a social media bookmark as a travel/place recommendation or not.

Caption: ${text}
Transcript: ${transcript}
Visual: ${visual}
Hashtags: ${tags}

Is this about a specific real-world place, destination, restaurant, hotel, landmark, or travel location — OR is it design/tutorial/product content NOT about visiting a specific place?

Respond with ONLY one word: place or skip`;
}

async function triageItem(c: PlaceCandidate): Promise<PlaceTriage> {
  const raw = await ollamaGenerate(buildTriagePrompt(c), { numPredict: 5, numCtx: 2048 });
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.includes("skip")) return "skip";
  return "place";
}

// ── Extraction ──

function buildExtractPromptWithPoi(c: PlaceCandidate): string {
  const poi = c.poi!;
  const country = resolveCountry(poi.countryCode) || "";
  const location = [poi.name, poi.city, country].filter(Boolean).join(", ");
  const poiType = poi.ttTypeNameTiny ? `${poi.ttTypeNameTiny} (${poi.ttTypeNameSuper})` : "";
  const suggest = c.suggestWords.length > 0
    ? `\nRelated searches: ${c.suggestWords.slice(0, 5).join(", ")}`
    : "";

  const text = (c.description || c.title).slice(0, 1200);
  const transcript = c.subtitle ? c.subtitle.slice(0, 600) : "";
  const tags = c.tags.slice(0, 15).join(", ");
  const visual = c.vision ? c.vision.slice(0, 300) : "";

  return `You are extracting travel notes from a social media video about a specific place.

Location: ${location}
${poiType ? `Place type (from TikTok): ${poiType}` : ""}${suggest}

Caption: ${text}
${transcript ? `Transcript: ${transcript}` : ""}
Hashtags: ${tags}
${visual ? `Visual: ${visual}` : ""}

Extract ONLY travel notes about this place. Do NOT re-extract the name/city/country (already provided above).

Respond with ONLY valid JSON — no markdown fences:
{"placeType":"restaurant|hotel|landmark|park|neighborhood|viewpoint|beach|museum|shop|cafe|bar|other","description":"1-2 sentences about what makes this place notable","vibes":["vibe1","vibe2"],"bestFor":"one phrase: what this place is best for","tips":["tip1","tip2"]}`;
}

function buildExtractPromptNoPoi(c: PlaceCandidate): string {
  const suggest = c.suggestWords.length > 0
    ? `TikTok search suggestions (strong location signal): ${c.suggestWords.slice(0, 8).join(", ")}\n\n`
    : "";

  const text = (c.description || c.title).slice(0, 1500);
  const transcript = c.subtitle ? c.subtitle.slice(0, 800) : "";
  const tags = c.tags.slice(0, 15).join(", ");
  const visual = c.vision ? c.vision.slice(0, 300) : "";
  const bio = c.authorSignature ? c.authorSignature.slice(0, 100) : "";

  return `You are extracting travel notes from a social media video bookmark.

${suggest}Caption: ${text}
${transcript ? `Transcript: ${transcript}` : ""}
Hashtags: ${tags}
${visual ? `Visual: ${visual}` : ""}
${bio ? `Creator bio: ${bio}` : ""}

Extract place/location information from this video.
If no specific real-world place is identifiable, use "Unknown" for name and leave city/country empty.

Respond with ONLY valid JSON — no markdown fences:
{"name":"place or venue name","city":"city name or empty","country":"country name or empty","placeType":"restaurant|hotel|landmark|park|neighborhood|viewpoint|beach|museum|shop|cafe|bar|other","description":"1-2 sentences about what makes this place notable","vibes":["vibe1","vibe2"],"bestFor":"one phrase","tips":["tip1","tip2"],"address":"street address if mentioned or null"}`;
}

async function extractPlace(vault: Vault, c: PlaceCandidate): Promise<PlaceExtraction | null> {
  const hasPoi = !!c.poi;
  const prompt = hasPoi ? buildExtractPromptWithPoi(c) : buildExtractPromptNoPoi(c);
  const raw = await ollamaGenerate(prompt, { numPredict: 1024, numCtx: 3072 });

  // Strip markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);

    if (hasPoi) {
      // Merge POI structured data with LLM qualitative extraction
      const poi = c.poi!;
      const country = resolveCountry(poi.countryCode) || parsed.country || "";
      const resolved = await resolvePoiCoords(vault, poi);
      return {
        name: poi.name,
        city: poi.city || parsed.city || "",
        country,
        placeType: normalizePlaceType(parsed.placeType),
        description: parsed.description || "",
        vibes: Array.isArray(parsed.vibes) ? parsed.vibes.slice(0, 6).filter(Boolean) : [],
        bestFor: parsed.bestFor || "",
        tips: Array.isArray(parsed.tips) ? parsed.tips.slice(0, 5).filter(Boolean) : [],
        address: poi.address || parsed.address || null,
        cityCode: poi.cityCode || null,
        lat: resolved?.coords[0] ?? null,
        lng: resolved?.coords[1] ?? null,
        isExact: resolved?.isExact ?? false,
      };
    } else {
      // Full LLM extraction — no POI context, so we only have city/country
      // strings to work with. resolveGeoNames handles the name+iso fallback.
      const name = parsed.name || "Unknown";
      if (name === "Unknown") return null;
      return {
        name,
        city: parsed.city || "",
        country: parsed.country || "",
        placeType: normalizePlaceType(parsed.placeType),
        description: parsed.description || "",
        vibes: Array.isArray(parsed.vibes) ? parsed.vibes.slice(0, 6).filter(Boolean) : [],
        bestFor: parsed.bestFor || "",
        tips: Array.isArray(parsed.tips) ? parsed.tips.slice(0, 5).filter(Boolean) : [],
        address: parsed.address || null,
        cityCode: null,
        lat: null,
        lng: null,
      };
    }
  } catch {
    console.warn(`[roost] places: failed to parse extraction for ${c.roostId}:`, cleaned.slice(0, 200));
    return null;
  }
}


// ── Frontmatter write helpers ──

export function computePlaceBackfillFields(
  extraction: PlaceExtraction,
  existingFm: Record<string, unknown>,
): Record<string, FrontmatterValue> {
  const updates: Record<string, FrontmatterValue> = {};
  updates[PLACE_FIELDS.name] = extraction.name;
  updates[PLACE_FIELDS.city] = extraction.city;
  updates[PLACE_FIELDS.country] = extraction.country;
  updates[PLACE_FIELDS.type] = extraction.placeType;
  updates[PLACE_FIELDS.address] = extraction.address;
  updates[PLACE_FIELDS.bestFor] = extraction.bestFor;
  updates[PLACE_FIELDS.lat] = extraction.lat ?? null;
  updates[PLACE_FIELDS.lng] = extraction.lng ?? null;
  updates[PLACE_FIELDS.description] = extraction.description || null;
  updates[PLACE_FIELDS.vibes] = extraction.vibes;
  updates[PLACE_FIELDS.tips] = extraction.tips;
  updates[PLACE_FIELDS.version] = PLACE_PIPELINE_VERSION;

  // Subcategory backfill rule
  const existingCategory = typeof existingFm[CATEGORY_FIELD] === "string"
    ? existingFm[CATEGORY_FIELD] as string : null;
  const existingSubcategory = typeof existingFm[SUBCATEGORY_FIELD] === "string"
    ? existingFm[SUBCATEGORY_FIELD] as string : null;
  if (!existingSubcategory) {
    const matchesPipeline = existingCategory
      && ["Places", "Travel"].some(c => c.toLowerCase() === existingCategory.toLowerCase());
    if (!existingCategory) {
      updates[CATEGORY_FIELD] = "Places";
      updates[SUBCATEGORY_FIELD] = extraction.placeType;
    } else if (matchesPipeline) {
      updates[SUBCATEGORY_FIELD] = extraction.placeType;
    }
  }
  return updates;
}

async function writePlaceToBookmark(
  app: App,
  file: TFile,
  extraction: PlaceExtraction,
): Promise<void> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const updates = computePlaceBackfillFields(extraction, fm);
  const content = await app.vault.read(file);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated !== null) await app.vault.modify(file, updated);
}

// ── Cache versioning / backfill ──

function readCacheVersion(vault: Vault): number {
  const full = cachePath(vaultBasePath(vault), CACHE_VERSION_FILE);
  try {
    const n = parseInt(fs.readFileSync(full, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCacheVersion(vault: Vault, version: number): void {
  const dir = cacheDir(vaultBasePath(vault));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(vaultBasePath(vault), CACHE_VERSION_FILE), String(version));
  } catch (e: unknown) {
    console.warn(`[roost] places: failed to write cache version:`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Re-read raw.json for every cached place entry and patch geocoordinates into
 * the existing extraction via the same resolver used during fresh extraction.
 *
 * Entries already marked isExact are skipped — their Nominatim match is
 * authoritative. Entries with only city-level coords get re-resolved (the
 * Nominatim cache makes repeat runs cheap).
 *
 * No LLM calls. Preserves LLM-generated description/vibes/tips/bestFor fields.
 *
 * Persists the cache every 25 entries so a mid-run crash doesn't lose
 * geocoded progress — each Nominatim call is expensive (1.1s throttle).
 */
async function backfillGeoCoords(
  vault: Vault,
  syncFolder: string,
  cache: Record<string, PlaceCacheEntry>,
  log: (msg: string) => void,
): Promise<{ patched: number; exact: number; scanned: number }> {
  let patched = 0;
  let exact = 0;
  let scanned = 0;
  let processed = 0;
  const entries = Object.entries(cache).filter(
    ([, e]) => e.triage === "place" && e.extraction,
  );
  const total = entries.length;
  for (const [roostId, entry] of entries) {
    if (entry.extraction!.isExact) {
      // Already resolved to exact POI coords on a prior run.
      continue;
    }
    scanned++;
    const raw = readRawJson(vault, syncFolder, roostId);
    if (!raw) continue;
    const poi = extractPoi(raw);
    const resolved = poi ? await resolvePoiCoords(vault, poi) : null;
    entry.extraction = {
      ...entry.extraction!,
      cityCode: poi?.cityCode || null,
      lat: resolved?.coords[0] ?? null,
      lng: resolved?.coords[1] ?? null,
      isExact: resolved?.isExact ?? false,
    };
    patched++;
    if (resolved?.isExact) exact++;
    processed++;
    if (processed % 25 === 0) {
      savePipelineCache(vault, CACHE_FILE, cache);
      log(`  geocoding ${processed}/${total} (${exact} exact)...`);
    }
  }
  return { patched, exact, scanned };
}

// ── Main pipeline ──

/** Places wiring for {@link runCategoryPipeline}. Built per-call because
 *  extractPlace needs the vault. POI fast-path replaces the inline auto-triage;
 *  the once-per-CACHE_VERSION geo backfill stays in runPlacesPipeline. */
function buildPlacesConfig(app: App): CategoryPipelineConfig<
  PlaceCandidate,
  PlaceExtraction,
  PlaceTriage,
  PlacesPipelineResult
> {
  return {
    cacheFile: CACHE_FILE,
    concurrency: CONCURRENCY,
    extractVerdict: "place",
    skipVerdict: "skip",
    onExtractFailure: "demote",
    onTriageFailure: "skip",
    gatherCandidates,
    fastPathTriage: c => (c.poi ? triageFromPoi(c.poi) : null),
    triageItem,
    extractItem: c => extractPlace(app.vault, c),
    onExtractError: (roostId, err) =>
      console.warn(`[roost] places: extraction error for ${roostId}:`, err),
    writeToBookmark: (a, c, ex) => writePlaceToBookmark(a, c.file, ex),
    buildResult: (candidates, cache, errors) => {
      const done = candidates.filter(
        c => cache[c.roostId]?.triage === "place" && cache[c.roostId]?.extraction,
      );
      return {
        candidates: candidates.length,
        places: done.length,
        skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
        errors,
        countries: new Set(done.map(c => cache[c.roostId]!.extraction!.country || "Unknown")).size,
      };
    },
    log: {
      candidatesFound: n => `Found ${n} place candidates`,
      triageExtractCounts: (uncached, needExtract, complete) =>
        `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
      fastPath: n => `POI auto-triage: ${n} items`,
      triageProgress: (done, total) => `Triaged ${done}/${total}`,
      wroteCached: n => `Wrote ${n} cached place fields onto source bookmarks`,
      extracting: n => `Extracting ${n} places...`,
      extractProgress: (done, total) => `Extracted ${done}/${total}`,
      done: r => `Done: ${r.places} places in ${r.countries} countries, ${r.skipped} skipped, ${r.errors} errors`,
    },
  };
}

export async function runPlacesPipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
): Promise<PlacesPipelineResult> {
  const log = onLog || (() => {});
  const vault = app.vault;

  // Version-gated backfill stays OUTSIDE the generic runner: it patches the
  // cache once per CACHE_VERSION bump with no LLM calls, and must complete
  // before the runner loads the cache for the main passes.
  const cachedVersion = readCacheVersion(vault);
  if (cachedVersion < CACHE_VERSION) {
    const cache = loadPipelineCache<PlaceCacheEntry>(vault, CACHE_FILE);
    log(`Cache v${cachedVersion} → v${CACHE_VERSION}: backfilling geo coords...`);
    const { patched, exact, scanned } = await backfillGeoCoords(vault, syncFolder, cache, log);
    savePipelineCache(vault, CACHE_FILE, cache);
    writeCacheVersion(vault, CACHE_VERSION);
    log(`Backfilled ${patched}/${scanned} entries (${exact} exact POI-level, ${patched - exact} city-level)`);
  }

  return runCategoryPipeline(app, syncFolder, buildPlacesConfig(app), onLog);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the places pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_place set, reads the
 *  place_* fields, and returns a cache record keyed by roost_id. */
export function reconstructPlacesCache(
  app: App,
): Record<string, { triage: "place"; extraction: PlaceExtraction }> {
  const out: Record<string, { triage: "place"; extraction: PlaceExtraction }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_place !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = {
      triage: "place",
      extraction: {
        name: String(fm.place_name ?? "Unknown"),
        city: typeof fm.place_city === "string" ? fm.place_city : "",
        country: typeof fm.place_country === "string" ? fm.place_country : "",
        placeType: typeof fm.place_type === "string" ? fm.place_type : "",
        bestFor: typeof fm.place_best_for === "string" ? fm.place_best_for : "",
        address: typeof fm.place_address === "string" ? fm.place_address : null,
        lat: typeof fm.place_lat === "number" ? fm.place_lat : null,
        lng: typeof fm.place_lng === "number" ? fm.place_lng : null,
        description: typeof fm.place_description === "string" ? fm.place_description : "",
        vibes: Array.isArray(fm.place_vibes) ? fm.place_vibes : [],
        tips: Array.isArray(fm.place_tips) ? fm.place_tips : [],
      },
    };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const PLACE_ENRICHMENT: EnrichmentDef = {
  id: "place",
  displayName: "Places & Travel",
  schemaVersion: 1,
  commandId: "run-places-pipeline",
  commandName: "Run Places extraction pipeline",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<PlaceCacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructPlacesCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runPlacesPipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog);
  },
  panelDetail: "Extract places, cities, and coordinates from travel bookmarks. Writes place_* fields onto each source bookmark.",
  categoryMatches: ["Places", "Travel"],
  fieldsWritten: ["place_name", "place_city", "place_country", "place_type", "place_address", "place_best_for", "place_lat", "place_lng", "place_vibes", "place_tips"],
  chips: [
    { field: "place_city", kind: "location" },
  ],
};
