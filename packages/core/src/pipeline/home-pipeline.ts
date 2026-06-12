/**
 * Home & Interiors extraction pipeline — finds home decor, interior design,
 * organization, and renovation bookmarks, triages them, extracts structured
 * data, and writes home_* fields onto the source bookmark's frontmatter.
 *
 * Data sources per item (in priority order):
 * 1. raw.json `videoSuggestWordsList` — TikTok entity extraction
 * 2. raw.json `contents` — structured line-by-line description
 * 3. frontmatter `title` — flattened caption
 * 4. frontmatter `subtitle` — speech-to-text transcript
 * 5. embedding cache `vision` — LLM description of video frames
 */
import { App, TFile } from "obsidian";
import { buildFileIndex, stripWikilink } from "@/lib/vault-utils";
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

// ── Types ──

type RoomType =
  | "kitchen" | "bedroom" | "bathroom" | "living-room" | "office"
  | "closet" | "garage" | "outdoor" | "nursery" | "laundry"
  | "dining" | "entryway" | "whole-home" | "other";

type IdeaType =
  | "decor" | "organization" | "renovation" | "furniture"
  | "diy-project" | "cleaning" | "smart-home" | "other";

interface HomeExtraction {
  room: string;       // widened to string so the exported public API matches roost.d.ts
  ideaType: string;   // widened to string so the exported public API matches roost.d.ts
  title: string;
  description: string;
  products: string[];
  style: string;
  budget: string | null;
  tips: string[];
}

interface CacheEntry {
  triage: "home" | "skip";
  extraction: HomeExtraction | null;
}

interface HomeCandidate {
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
}

// ── Constants ──

const HOME_CATEGORIES = new Set([
  "home", "interior", "decor", "decoration", "furniture",
  "organization", "renovation", "cleaning", "apartment",
  "house", "room", "kitchen", "bathroom", "bedroom",
]);

const HOME_TAG_KEYWORDS = [
  "homedecor", "interiordesign", "home", "apartment", "decor",
  "organization", "renovation", "roomtour", "roommakeover",
  "homedesign", "furniture", "cleaning", "cleaningtips",
  "homestyling", "roomdecor", "bathroomdesign", "kitchendesign",
  "closetorganization", "shelfie", "hometour", "smarthome",
  "diyhomedecor", "minimalist", "cozy", "aesthetic",
];

const FAST_PATH_TAGS = new Set([
  "homedecor", "interiordesign", "roomtour", "roommakeover",
  "hometour", "closetorganization", "diyhomedecor",
]);

const VALID_ROOM_TYPES = new Set<RoomType>([
  "kitchen", "bedroom", "bathroom", "living-room", "office",
  "closet", "garage", "outdoor", "nursery", "laundry",
  "dining", "entryway", "whole-home", "other",
]);

const VALID_IDEA_TYPES = new Set<IdeaType>([
  "decor", "organization", "renovation", "furniture",
  "diy-project", "cleaning", "smart-home", "other",
]);

const ROOM_TYPE_DISPLAY: Record<RoomType, string> = {
  kitchen: "Kitchen",
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  "living-room": "Living Room",
  office: "Office",
  closet: "Closet & Storage",
  garage: "Garage",
  outdoor: "Outdoor",
  nursery: "Nursery",
  laundry: "Laundry",
  dining: "Dining",
  entryway: "Entryway",
  "whole-home": "Whole Home",
  other: "Other",
};

const CACHE_FILE = "home-cache.json";
const CONCURRENCY = 3;

const HOME_PIPELINE_VERSION = 1;

export const HOME_FIELDS = {
  title: "home_title",
  room: "home_room",
  ideaType: "home_idea_type",
  style: "home_style",
  budget: "home_budget",
  description: "home_description",
  products: "home_products",
  tips: "home_tips",
  version: "enrichment_v_home",
} as const;

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

function normalizeRoomType(raw: string): RoomType {
  const lower = (raw || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (VALID_ROOM_TYPES.has(lower as RoomType)) return lower as RoomType;
  if (lower === "living" || lower === "lounge" || lower === "den" || lower === "family-room") return "living-room";
  if (lower === "closets" || lower === "storage" || lower === "pantry") return "closet";
  if (lower === "patio" || lower === "garden" || lower === "yard" || lower === "balcony") return "outdoor";
  if (lower === "baby" || lower === "kids" || lower === "kids-room") return "nursery";
  if (lower === "mudroom" || lower === "foyer" || lower === "hallway") return "entryway";
  if (lower === "whole" || lower === "general" || lower === "full-home") return "whole-home";
  return "other";
}

function normalizeIdeaType(raw: string): IdeaType {
  const lower = (raw || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (VALID_IDEA_TYPES.has(lower as IdeaType)) return lower as IdeaType;
  if (lower === "decorating" || lower === "styling" || lower === "aesthetic") return "decor";
  if (lower === "organizing" || lower === "storage" || lower === "declutter") return "organization";
  if (lower === "remodel" || lower === "makeover" || lower === "upgrade") return "renovation";
  if (lower === "diy" || lower === "craft" || lower === "build") return "diy-project";
  if (lower === "clean" || lower === "tidy" || lower === "wash") return "cleaning";
  if (lower === "tech" || lower === "automation" || lower === "smart") return "smart-home";
  return "other";
}

function hasHomeFastPath(tags: string[]): boolean {
  return tags.some(t => {
    const cleaned = t.toLowerCase().replace(/^#/, "");
    return FAST_PATH_TAGS.has(cleaned);
  });
}

// ── Candidate gathering ──

function gatherCandidates(app: App, syncFolder: string): HomeCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const candidates: HomeCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const embedded = embeddingCache[roostId];
    const category = (embedded?.category || "").toLowerCase();
    const rawTags: string[] = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).map(t => String(t).toLowerCase())
      : [];

    const categoryMatch = HOME_CATEGORIES.has(category);
    const tagMatch = rawTags.some(t =>
      HOME_TAG_KEYWORDS.some(kw => t.includes(kw)),
    );

    if (!categoryMatch && !tagMatch) continue;

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
    });
  }

  return candidates;
}

// ── Triage ──

function buildTriagePrompt(c: HomeCandidate): string {
  const text = (c.description || c.title).slice(0, 1500);
  const transcript = c.subtitle ? c.subtitle.slice(0, 800) : "No transcript.";
  const visual = c.vision ? c.vision.slice(0, 300) : "No description.";
  const tags = c.tags.slice(0, 15).join(", ");

  return `You are classifying a social media bookmark.

Caption: ${text}
Transcript: ${transcript}
Visual: ${visual}
Hashtags: ${tags}

Is this about HOME DESIGN, DECOR, ORGANIZATION, or RENOVATION — showing or describing a specific idea, product, or technique for improving a home or living space?

Or is it general lifestyle content NOT about home improvement or interior design?

Respond with ONLY one word: home or skip`;
}

async function triageItem(c: HomeCandidate): Promise<"home" | "skip"> {
  const raw = await ollamaGenerate(buildTriagePrompt(c), { numPredict: 5, numCtx: 2048 });
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.includes("skip")) return "skip";
  return "home";
}

// ── Extraction ──

function buildExtractPrompt(c: HomeCandidate): string {
  const sections: string[] = [];

  if (c.suggestWords.length > 0) {
    sections.push(`TikTok search suggestions: ${c.suggestWords.slice(0, 8).join(", ")}`);
  }

  if (c.description) {
    sections.push(`Description:\n${c.description.slice(0, 1500)}`);
  } else if (c.title) {
    sections.push(`Caption: ${c.title.slice(0, 1500)}`);
  }

  if (c.subtitle) {
    sections.push(`Video transcript: ${c.subtitle.slice(0, 1000)}`);
  }

  if (c.vision) {
    sections.push(`Visual description: ${c.vision.slice(0, 500)}`);
  }

  if (c.tags.length > 0) {
    sections.push(`Tags: ${c.tags.slice(0, 15).join(", ")}`);
  }

  return `Extract the home/interior design idea from this social media video.
Identify the room, type of idea, and any specific products or techniques shown.

${sections.join("\n\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "room": "kitchen|bedroom|bathroom|living-room|office|closet|garage|outdoor|nursery|laundry|dining|entryway|whole-home|other",
  "ideaType": "decor|organization|renovation|furniture|diy-project|cleaning|smart-home|other",
  "title": "descriptive title for this idea (e.g. 'Floating shelf gallery wall', 'Under-sink organization system')",
  "description": "1-2 sentence summary of the idea and why it works",
  "products": ["specific product names mentioned, if any"],
  "style": "design style (e.g. 'minimalist', 'farmhouse', 'modern', 'boho', 'scandinavian', 'industrial')",
  "budget": "cost or budget level if mentioned (e.g. '$50', 'budget-friendly', 'luxury') or null",
  "tips": ["implementation tip or detail"]
}`;
}

async function extractHome(c: HomeCandidate): Promise<HomeExtraction | null> {
  const raw = await ollamaGenerate(buildExtractPrompt(c), { numPredict: 1024, numCtx: 3072 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    const title = parsed.title || "";
    if (!title || title.toLowerCase() === "unknown") return null;

    return {
      room: normalizeRoomType(parsed.room),
      ideaType: normalizeIdeaType(parsed.ideaType),
      title,
      description: parsed.description || "",
      products: Array.isArray(parsed.products)
        ? (parsed.products as unknown[]).map(p => String(p)).filter(Boolean).slice(0, 10)
        : [],
      style: parsed.style || "Mixed",
      budget: parsed.budget && parsed.budget !== "null" ? parsed.budget : null,
      tips: Array.isArray(parsed.tips)
        ? (parsed.tips as unknown[]).map(t => String(t)).filter(Boolean).slice(0, 5)
        : [],
    };
  } catch {
    console.warn(`[roost] home: failed to parse extraction for ${c.roostId}:`, cleaned.slice(0, 200));
    return null;
  }
}

// ── Frontmatter write helpers ──

export function computeHomeBackfillFields(
  extraction: HomeExtraction,
  existingFm: Record<string, unknown>,
): Record<string, FrontmatterValue> {
  const updates: Record<string, FrontmatterValue> = {};
  updates[HOME_FIELDS.title] = extraction.title;
  updates[HOME_FIELDS.room] = extraction.room;
  updates[HOME_FIELDS.ideaType] = extraction.ideaType;
  updates[HOME_FIELDS.style] = extraction.style;
  updates[HOME_FIELDS.budget] = extraction.budget;
  updates[HOME_FIELDS.description] = extraction.description;
  updates[HOME_FIELDS.products] = extraction.products;
  updates[HOME_FIELDS.tips] = extraction.tips;
  updates[HOME_FIELDS.version] = HOME_PIPELINE_VERSION;

  // Subcategory backfill rule
  const existingCategory = typeof existingFm[CATEGORY_FIELD] === "string"
    ? existingFm[CATEGORY_FIELD] as string : null;
  const existingSubcategory = typeof existingFm[SUBCATEGORY_FIELD] === "string"
    ? existingFm[SUBCATEGORY_FIELD] as string : null;
  if (!existingSubcategory) {
    const matchesPipeline = existingCategory
      && ["Home", "Interiors", "Home & Interiors", "Decor"].some(
        c => c.toLowerCase() === existingCategory.toLowerCase()
      );
    if (!existingCategory) {
      updates[CATEGORY_FIELD] = "Home";
      updates[SUBCATEGORY_FIELD] = ROOM_TYPE_DISPLAY[extraction.room as RoomType] || extraction.room;
    } else if (matchesPipeline) {
      updates[SUBCATEGORY_FIELD] = ROOM_TYPE_DISPLAY[extraction.room as RoomType] || extraction.room;
    }
  }
  return updates;
}

export async function writeHomeToBookmark(
  app: App,
  file: TFile,
  extraction: HomeExtraction,
): Promise<void> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const updates = computeHomeBackfillFields(extraction, fm);
  const content = await app.vault.read(file);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated !== null) {
    await app.vault.modify(file, updated);
  }
}

// ── Main pipeline ──

interface HomePipelineResult {
  candidates: number;
  ideas: number;
  skipped: number;
  errors: number;
}

/**
 * Home wiring for the generic {@link runCategoryPipeline}. Reproduces the home
 * pipeline's prior inline behavior: the tag fast-path (via {@link hasHomeFastPath}),
 * the "home" extract verdict, the "skip" verdict, home's demote-on-extract-failure
 * and skip-on-triage-failure policies, and the extraction-error warn.
 */
const HOME_CONFIG: CategoryPipelineConfig<
  HomeCandidate,
  HomeExtraction,
  "home" | "skip",
  HomePipelineResult
> = {
  cacheFile: CACHE_FILE,
  concurrency: CONCURRENCY,
  label: "home ideas",
  extractVerdict: "home",
  skipVerdict: "skip",
  onExtractFailure: "demote",
  onTriageFailure: "skip",
  fastPathTriage: (c) => hasHomeFastPath(c.tags) ? "home" : null,
  gatherCandidates,
  triageItem,
  extractItem: async (c) => {
    try {
      return await extractHome(c);
    } catch (err) {
      console.warn(`[roost] home: extraction error for ${c.roostId}:`, err);
      return null;
    }
  },
  writeToBookmark: (app, c, ex) => writeHomeToBookmark(app, c.file, ex),
  buildResult: (candidates, cache, errors) => ({
    candidates: candidates.length,
    ideas: candidates.filter(
      c => cache[c.roostId]?.triage === "home" && cache[c.roostId]?.extraction,
    ).length,
    skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
    errors,
  }),
};

export async function runHomePipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
): Promise<HomePipelineResult> {
  return runCategoryPipeline(app, syncFolder, HOME_CONFIG, onLog);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the home pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_home set, reads the
 *  home_* fields, and returns a cache record keyed by roost_id. */
export function reconstructHomeCache(
  app: App,
): Record<string, { triage: "home"; extraction: HomeExtraction }> {
  const out: Record<string, { triage: "home"; extraction: HomeExtraction }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_home !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = {
      triage: "home",
      extraction: {
        title: String(fm.home_title ?? "Unknown"),
        room: typeof fm.home_room === "string" ? fm.home_room : "",
        ideaType: typeof fm.home_idea_type === "string" ? fm.home_idea_type : "",
        style: typeof fm.home_style === "string" ? fm.home_style : "",
        budget: typeof fm.home_budget === "string" ? fm.home_budget : null,
        description: typeof fm.home_description === "string" ? fm.home_description : "",
        products: Array.isArray(fm.home_products) ? fm.home_products : [],
        tips: Array.isArray(fm.home_tips) ? fm.home_tips : [],
      },
    };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const HOME_ENRICHMENT: EnrichmentDef = {
  id: "home",
  displayName: "Home & Interiors",
  schemaVersion: HOME_PIPELINE_VERSION,
  commandId: "run-home-pipeline",
  commandName: "Run Home extraction pipeline",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructHomeCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runHomePipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog);
  },
  panelDetail: "Extract home ideas, room types, and style tips from decor bookmarks.",
  categoryMatches: ["Home", "Interiors", "Home & Interiors", "Decor"],
  fieldsWritten: Object.values(HOME_FIELDS).filter(f => f !== HOME_FIELDS.version),
  chips: [
    { field: "home_room", kind: "location" },
    { field: "home_style", kind: "tag" },
    { field: "home_budget", kind: "price" },
  ],
};
