/**
 * Tutorials & Skills extraction pipeline — finds how-to/tutorial/learning
 * bookmarks, triages them, extracts structured tutorial data, and writes
 * enrichment fields back to the source bookmark's frontmatter.
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

// ── Enrichment field map ──

const TUTORIAL_PIPELINE_VERSION = 1;

export const TUTORIAL_FIELDS = {
  topic: "tutorial_topic",
  skillArea: "tutorial_skill_area",
  difficulty: "tutorial_difficulty",
  timeEstimate: "tutorial_time_estimate",
  description: "tutorial_description",
  tools: "tutorial_tools",
  steps: "tutorial_steps",
  version: "enrichment_v_tutorial",
} as const;

const TUTORIAL_CATEGORY_MATCHES = new Set(["Tutorials", "Tutorial", "How-To", "Skills"]);

// ── Types ──

type SkillArea =
  | "coding" | "art" | "music" | "photography" | "video"
  | "writing" | "language" | "craft" | "career" | "finance"
  | "cooking" | "repair" | "other";

type DifficultyLevel = "beginner" | "intermediate" | "advanced";

interface TutorialExtraction {
  skillArea: string;  // widened to string so the exported public API matches roost.d.ts
  topic: string;
  description: string;
  steps: string[];
  difficulty: DifficultyLevel;
  tools: string[];
  timeEstimate: string | null;
}

interface CacheEntry {
  triage: "tutorial" | "skip";
  extraction: TutorialExtraction | null;
}

interface TutorialCandidate {
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

const TUTORIAL_CATEGORIES = new Set([
  "tutorial", "howto", "diy", "learning", "education", "coding",
  "programming", "art", "drawing", "photography", "editing",
  "design", "craft", "woodworking", "sewing", "knitting",
]);

const TUTORIAL_TAG_KEYWORDS = [
  "tutorial", "howto", "diy", "learn", "tip", "trick", "hack",
  "guide", "stepbystep", "beginner", "advanced", "technique",
  "editing", "photoshop", "procreate", "blender", "coding",
  "programming", "drawing", "painting", "calligraphy", "crochet",
  "knitting", "sewing", "woodworking", "learnon", "edutok",
];

const FAST_PATH_TAGS = new Set([
  "tutorial", "stepbystep", "howto", "edutok", "learnontiktok",
]);

const VALID_SKILL_AREAS = new Set<SkillArea>([
  "coding", "art", "music", "photography", "video",
  "writing", "language", "craft", "career", "finance",
  "cooking", "repair", "other",
]);

const CACHE_FILE = "tutorials-cache.json";
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

function normalizeSkillArea(raw: string): SkillArea {
  const lower = (raw || "").toLowerCase().trim();
  if (VALID_SKILL_AREAS.has(lower as SkillArea)) return lower as SkillArea;
  if (lower === "programming" || lower === "software" || lower === "web development") return "coding";
  if (lower === "drawing" || lower === "painting" || lower === "design" || lower === "illustration") return "art";
  if (lower === "film" || lower === "editing" || lower === "filmmaking" || lower === "animation") return "video";
  if (lower === "photo") return "photography";
  if (lower === "diy" || lower === "woodworking" || lower === "sewing" || lower === "knitting" || lower === "crochet" || lower === "calligraphy") return "craft";
  if (lower === "money" || lower === "investing" || lower === "budgeting") return "finance";
  if (lower === "job" || lower === "resume" || lower === "interview") return "career";
  if (lower === "fix" || lower === "maintenance" || lower === "plumbing" || lower === "electrical") return "repair";
  return "other";
}

function normalizeDifficulty(raw: string): DifficultyLevel {
  const lower = (raw || "").toLowerCase().trim();
  if (lower === "beginner" || lower === "easy" || lower === "basic") return "beginner";
  if (lower === "advanced" || lower === "hard" || lower === "expert") return "advanced";
  return "intermediate";
}

function hasTutorialFastPath(tags: string[]): boolean {
  return tags.some(t => {
    const cleaned = t.toLowerCase().replace(/^#/, "");
    return FAST_PATH_TAGS.has(cleaned);
  });
}

// ── Candidate gathering ──

function gatherCandidates(app: App, syncFolder: string): TutorialCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const candidates: TutorialCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const embedded = embeddingCache[roostId];
    const category = (embedded?.category || "").toLowerCase();
    const rawTags: string[] = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).map(t => String(t).toLowerCase())
      : [];

    const categoryMatch = TUTORIAL_CATEGORIES.has(category);
    const tagMatch = rawTags.some(t =>
      TUTORIAL_TAG_KEYWORDS.some(kw => t.includes(kw)),
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

function buildTriagePrompt(c: TutorialCandidate): string {
  const text = (c.description || c.title).slice(0, 1500);
  const transcript = c.subtitle ? c.subtitle.slice(0, 800) : "No transcript.";
  const visual = c.vision ? c.vision.slice(0, 300) : "No description.";
  const tags = c.tags.slice(0, 15).join(", ");

  return `You are classifying a social media bookmark.

Caption: ${text}
Transcript: ${transcript}
Visual: ${visual}
Hashtags: ${tags}

Is this a TUTORIAL or HOW-TO that teaches a specific skill or technique — showing steps, explaining a process, or demonstrating how to do something?

Or is it general content NOT teaching a specific learnable skill?

Respond with ONLY one word: tutorial or skip`;
}

async function triageItem(c: TutorialCandidate): Promise<"tutorial" | "skip"> {
  const raw = await ollamaGenerate(buildTriagePrompt(c), { numPredict: 5, numCtx: 2048 });
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.includes("skip")) return "skip";
  return "tutorial";
}

// ── Extraction ──

function buildExtractPrompt(c: TutorialCandidate): string {
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
    sections.push(`Visual description: ${c.vision.slice(0, 400)}`);
  }

  if (c.tags.length > 0) {
    sections.push(`Tags: ${c.tags.slice(0, 15).join(", ")}`);
  }

  return `Extract the tutorial or how-to from this social media video.
Identify what skill or technique is being taught and break it into steps.

${sections.join("\n\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "skillArea": "coding|art|music|photography|video|writing|language|craft|career|finance|cooking|repair|other",
  "topic": "specific skill or technique being taught (e.g. 'Watercolor gradient wash', 'Git rebase workflow')",
  "description": "1-2 sentence summary of what you'll learn",
  "steps": ["step 1", "step 2", "step 3"],
  "difficulty": "beginner|intermediate|advanced",
  "tools": ["tool or material needed"],
  "timeEstimate": "estimated time to complete or null"
}`;
}

async function extractTutorial(c: TutorialCandidate): Promise<TutorialExtraction | null> {
  const raw = await ollamaGenerate(buildExtractPrompt(c), { numPredict: 1536, numCtx: 4096 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    const topic = parsed.topic || "";
    if (!topic || topic.toLowerCase() === "unknown") return null;

    return {
      skillArea: normalizeSkillArea(parsed.skillArea),
      topic,
      description: parsed.description || "",
      steps: Array.isArray(parsed.steps)
        ? (parsed.steps as unknown[]).map(s => String(s)).filter(Boolean)
        : [],
      difficulty: normalizeDifficulty(parsed.difficulty),
      tools: Array.isArray(parsed.tools)
        ? (parsed.tools as unknown[]).map(t => String(t)).filter(Boolean).slice(0, 10)
        : [],
      timeEstimate: parsed.timeEstimate && parsed.timeEstimate !== "null" ? parsed.timeEstimate : null,
    };
  } catch {
    console.warn(`[roost] tutorials: failed to parse extraction for ${c.roostId}:`, cleaned.slice(0, 200));
    return null;
  }
}

// ── In-place enrichment ──

/**
 * Compute the frontmatter updates to write back to the source bookmark.
 * Pure function — no I/O, safe to unit-test directly.
 */
export function computeTutorialBackfillFields(
  extraction: TutorialExtraction,
  existingFm: Record<string, unknown>,
): Record<string, FrontmatterValue> {
  const updates: Record<string, FrontmatterValue> = {
    [TUTORIAL_FIELDS.topic]: extraction.topic,
    [TUTORIAL_FIELDS.skillArea]: extraction.skillArea,
    [TUTORIAL_FIELDS.difficulty]: extraction.difficulty,
    [TUTORIAL_FIELDS.timeEstimate]: extraction.timeEstimate ?? null,
    [TUTORIAL_FIELDS.description]: extraction.description || null,
    [TUTORIAL_FIELDS.tools]: extraction.tools.length > 0 ? extraction.tools : null,
    [TUTORIAL_FIELDS.steps]: extraction.steps.length > 0 ? extraction.steps : null,
    [TUTORIAL_FIELDS.version]: TUTORIAL_PIPELINE_VERSION,
  };

  // Set roost_category / roost_subcategory only when the slot is empty or matches
  // a recognized tutorial category — never overwrite a user-assigned category.
  const existingCat = existingFm[CATEGORY_FIELD] as string | undefined;
  if (!existingCat) {
    updates[CATEGORY_FIELD] = "Tutorials";
    updates[SUBCATEGORY_FIELD] = extraction.skillArea;
  } else if (TUTORIAL_CATEGORY_MATCHES.has(existingCat)) {
    const existingSub = existingFm[SUBCATEGORY_FIELD] as string | undefined;
    if (!existingSub) {
      updates[SUBCATEGORY_FIELD] = extraction.skillArea;
    }
  }
  // If existingCat is set but NOT a recognized tutorial category, leave both alone.

  return updates;
}

/**
 * Read the source bookmark's current content, compute the enrichment updates,
 * and write them back in-place via updateNoteFrontmatter.
 */
export async function writeTutorialToBookmark(
  app: App,
  file: TFile,
  extraction: TutorialExtraction,
): Promise<void> {
  const content = await app.vault.read(file);
  const existingFm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  const updates = computeTutorialBackfillFields(extraction, existingFm);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated !== null) {
    await app.vault.modify(file, updated);
  }
}

// ── Main pipeline ──

interface TutorialsPipelineResult {
  candidates: number;
  tutorials: number;
  skipped: number;
  errors: number;
}

/** Tutorials wiring for {@link runCategoryPipeline} — standard profile (tag fast-path, triage-throw → skip, extract-failure → demote), plus a distinct skillArea count (`areas`) computed in buildResult. */
const TUTORIALS_CONFIG: CategoryPipelineConfig<
  TutorialCandidate,
  TutorialExtraction,
  "tutorial" | "skip",
  TutorialsPipelineResult
> = {
  cacheFile: CACHE_FILE,
  concurrency: CONCURRENCY,
  extractVerdict: "tutorial",
  skipVerdict: "skip",
  onExtractFailure: "demote",
  onTriageFailure: "skip",
  gatherCandidates,
  fastPathTriage: c => (hasTutorialFastPath(c.tags) ? "tutorial" : null),
  triageItem,
  extractItem: extractTutorial,
  onExtractError: (roostId, err) =>
    console.warn(`[roost] tutorials: extraction error for ${roostId}:`, err),
  writeToBookmark: (app, c, ex) => writeTutorialToBookmark(app, c.file, ex),
  storeExtractionInCache: false,
  buildResult: (candidates, cache, errors) => ({
    candidates: candidates.length,
    tutorials: candidates.filter(
      c => cache[c.roostId]?.triage === "tutorial" && ((cache[c.roostId] as any)?.extracted === true || !!cache[c.roostId]?.extraction),
    ).length,
    skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
    errors,
  }),
  log: {
    candidatesFound: n => `Found ${n} tutorial candidates`,
    triageExtractCounts: (uncached, needExtract, complete) =>
      `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
    fastPath: n => `Tag fast-path: ${n} items auto-triaged as tutorial`,
    triageProgress: (done, total) => `Triaged ${done}/${total}`,
    wroteCached: n => `Enriched ${n} cached tutorials`,
    extracting: n => `Extracting ${n} tutorials...`,
    extractProgress: (done, total) => `Extracted ${done}/${total}`,
    done: r => `Done: ${r.tutorials} tutorials, ${r.skipped} skipped, ${r.errors} errors`,
  },
};

export async function runTutorialsPipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<TutorialsPipelineResult> {
  return runCategoryPipeline(app, syncFolder, TUTORIALS_CONFIG, onLog, signal);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the tutorials pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_tutorial set, reads the
 *  tutorial_* fields, and returns a cache record keyed by roost_id. */
export function reconstructTutorialsCache(
  app: App,
): Record<string, { triage: "tutorial"; extraction: null; extracted: true }> {
  const out: Record<string, { triage: "tutorial"; extraction: null; extracted: true }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_tutorial !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = { triage: "tutorial", extraction: null, extracted: true };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const TUTORIAL_ENRICHMENT: EnrichmentDef = {
  id: "tutorial",
  displayName: "Tutorials & Skills",
  schemaVersion: 1,
  commandId: "run-tutorials-pipeline",
  commandName: "Run Tutorials extraction pipeline",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructTutorialsCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runTutorialsPipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog, opts?.signal);
  },
  panelDetail: "Extract step-by-step skill tutorials from how-to bookmarks. Writes tutorial_* fields onto each source bookmark.",
  categoryMatches: ["Tutorials", "Tutorial", "How-To", "Skills"],
  fieldsWritten: ["tutorial_topic", "tutorial_skill_area", "tutorial_difficulty", "tutorial_time_estimate", "tutorial_tools", "tutorial_steps"],
  chips: [
    { field: "tutorial_time_estimate", kind: "time" },
    { field: "tutorial_difficulty", kind: "difficulty" },
    { field: "tutorial_skill_area", kind: "tag" },
  ],
};
