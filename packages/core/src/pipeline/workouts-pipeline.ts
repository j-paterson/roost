/**
 * Workouts & Fitness extraction pipeline — finds workout/exercise/fitness
 * bookmarks, triages them, extracts structured workout data, and writes
 * workout_* fields onto the source bookmark's frontmatter.
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

type WorkoutType =
  | "strength" | "cardio" | "hiit" | "yoga" | "pilates"
  | "stretching" | "calisthenics" | "martial-arts" | "dance"
  | "running" | "cycling" | "swimming" | "other";

interface WorkoutExtraction {
  workoutType: WorkoutType;
  name: string;
  targetArea: string;
  exercises: string[];
  duration: string | null;
  difficulty: "beginner" | "intermediate" | "advanced";
  equipment: string[];
  notes: string | null;
}

/** Exported for unit-testing the extraction parse step. */
export type { WorkoutCandidate };

interface CacheEntry {
  triage: "workout" | "skip";
  extraction: WorkoutExtraction | null;
}

interface WorkoutCandidate {
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

const WORKOUT_CATEGORIES = new Set([
  "fitness", "workout", "exercise", "gym", "yoga", "pilates",
  "stretching", "running", "cycling", "bodybuilding", "crossfit",
  "calisthenics", "martial",
]);

const WORKOUT_TAG_KEYWORDS = [
  "workout", "fitness", "gym", "exercise", "hiit", "yoga",
  "pilates", "stretching", "calisthenics", "bodybuilding",
  "crossfit", "gains", "fitnessmotivation", "legday", "armday",
  "absworkout", "coreworkout", "homeworkout", "gymtok",
  "flexibility", "mobility", "cardio", "running", "lifting",
];

const FAST_PATH_TAGS = new Set([
  "gymtok", "homeworkout", "absworkout", "coreworkout",
  "legday", "armday", "hiitworkout",
]);

const VALID_WORKOUT_TYPES = new Set<WorkoutType>([
  "strength", "cardio", "hiit", "yoga", "pilates",
  "stretching", "calisthenics", "martial-arts", "dance",
  "running", "cycling", "swimming", "other",
]);

const CACHE_FILE = "workouts-cache.json";
const CONCURRENCY = 3;

const WORKOUT_PIPELINE_VERSION = 1;

const WORKOUT_FIELDS = {
  name: "workout_name",
  type: "workout_type",
  targetArea: "workout_target_area",
  difficulty: "workout_difficulty",
  duration: "workout_duration",
  equipment: "workout_equipment",
  exercises: "workout_exercises",
  notes: "workout_notes",
  version: "enrichment_v_workout",
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

function normalizeWorkoutType(raw: string): WorkoutType {
  const lower = (raw || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (VALID_WORKOUT_TYPES.has(lower as WorkoutType)) return lower as WorkoutType;
  if (lower === "weight-training" || lower === "weightlifting" || lower === "lifting" || lower === "bodybuilding") return "strength";
  if (lower === "crossfit") return "hiit";
  if (lower === "flexibility" || lower === "mobility") return "stretching";
  if (lower === "boxing" || lower === "kickboxing" || lower === "mma" || lower === "jiu-jitsu") return "martial-arts";
  if (lower === "jogging" || lower === "sprinting") return "running";
  if (lower === "spin" || lower === "biking") return "cycling";
  return "other";
}

function hasWorkoutFastPath(tags: string[]): boolean {
  return tags.some(t => {
    const cleaned = t.toLowerCase().replace(/^#/, "");
    return FAST_PATH_TAGS.has(cleaned);
  });
}

// ── Candidate gathering ──

function gatherCandidates(app: App, syncFolder: string): WorkoutCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const candidates: WorkoutCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const embedded = embeddingCache[roostId];
    const category = (embedded?.category || "").toLowerCase();
    const rawTags: string[] = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).map(t => String(t).toLowerCase())
      : [];

    const categoryMatch = WORKOUT_CATEGORIES.has(category);
    const tagMatch = rawTags.some(t =>
      WORKOUT_TAG_KEYWORDS.some(kw => t.includes(kw)),
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

function buildTriagePrompt(c: WorkoutCandidate): string {
  const text = (c.description || c.title).slice(0, 1500);
  const transcript = c.subtitle ? c.subtitle.slice(0, 800) : "No transcript.";
  const visual = c.vision ? c.vision.slice(0, 300) : "No description.";
  const tags = c.tags.slice(0, 15).join(", ");

  return `You are classifying a social media bookmark.

Caption: ${text}
Transcript: ${transcript}
Visual: ${visual}
Hashtags: ${tags}

Is this an actual WORKOUT or EXERCISE routine — showing or describing specific exercises, stretches, or physical training you can follow?

Or is it fitness motivation, body transformation, gym humor, or other content NOT containing a followable workout?

Respond with ONLY one word: workout or skip`;
}

async function triageItem(c: WorkoutCandidate): Promise<"workout" | "skip"> {
  const raw = await ollamaGenerate(buildTriagePrompt(c), { numPredict: 5, numCtx: 2048 });
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.includes("skip")) return "skip";
  return "workout";
}

// ── Extraction ──

function buildExtractPrompt(c: WorkoutCandidate): string {
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

  return `Extract the workout routine from this social media video.
Identify the exercises, target areas, and structure of the workout.

${sections.join("\n\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "workoutType": "strength|cardio|hiit|yoga|pilates|stretching|calisthenics|martial-arts|dance|running|cycling|swimming|other",
  "name": "descriptive name for this workout (e.g. '10-Min Ab Burner', 'Full Body Dumbbell Circuit')",
  "targetArea": "primary body area targeted (e.g. 'core', 'upper body', 'legs', 'full body', 'flexibility')",
  "exercises": [
    {"name": "exercise name", "reps": "reps, sets, or duration (e.g. '3x12', '30 seconds', '10 each side') or null"}
  ],
  "duration": "total workout duration if mentioned or null",
  "difficulty": "beginner|intermediate|advanced",
  "equipment": ["equipment needed (e.g. 'dumbbells', 'resistance band', 'none/bodyweight')"],
  "notes": "important form cues or tips, or null"
}`;
}

export async function extractWorkout(c: WorkoutCandidate): Promise<WorkoutExtraction | null> {
  const raw = await ollamaGenerate(buildExtractPrompt(c), { numPredict: 1536, numCtx: 4096 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    const name = parsed.name || "";
    if (!name || name.toLowerCase() === "unknown") return null;

    return {
      workoutType: normalizeWorkoutType(parsed.workoutType),
      name,
      targetArea: parsed.targetArea || "Full body",
      exercises: Array.isArray(parsed.exercises)
        ? (parsed.exercises as { name?: unknown; reps?: unknown }[])
            .flatMap(e => {
              const exName = String(e.name || "").trim();
              if (!exName) return [];
              const exReps = e.reps && e.reps !== "null" ? String(e.reps).trim() : null;
              return [exReps ? `${exName} — ${exReps}` : exName];
            })
        : [],
      duration: parsed.duration && parsed.duration !== "null" ? parsed.duration : null,
      difficulty: (["beginner", "intermediate", "advanced"].includes(parsed.difficulty)
        ? parsed.difficulty : "intermediate") as "beginner" | "intermediate" | "advanced",
      equipment: Array.isArray(parsed.equipment)
        ? (parsed.equipment as unknown[]).map(e => String(e)).filter(Boolean).slice(0, 10)
        : [],
      notes: parsed.notes && parsed.notes !== "null" ? parsed.notes : null,
    };
  } catch {
    console.warn(`[roost] workouts: failed to parse extraction for ${c.roostId}:`, cleaned.slice(0, 200));
    return null;
  }
}

// ── Frontmatter write helpers ──

export function computeWorkoutBackfillFields(
  extraction: WorkoutExtraction,
  existingFm: Record<string, unknown>,
): Record<string, FrontmatterValue> {
  const updates: Record<string, FrontmatterValue> = {};
  updates[WORKOUT_FIELDS.name] = extraction.name;
  updates[WORKOUT_FIELDS.type] = extraction.workoutType;
  updates[WORKOUT_FIELDS.targetArea] = extraction.targetArea;
  updates[WORKOUT_FIELDS.difficulty] = extraction.difficulty;
  updates[WORKOUT_FIELDS.duration] = extraction.duration;
  updates[WORKOUT_FIELDS.equipment] = extraction.equipment;
  updates[WORKOUT_FIELDS.exercises] = extraction.exercises;
  updates[WORKOUT_FIELDS.notes] = extraction.notes;
  updates[WORKOUT_FIELDS.version] = WORKOUT_PIPELINE_VERSION;

  // Subcategory backfill rule
  const existingCategory = typeof existingFm[CATEGORY_FIELD] === "string"
    ? existingFm[CATEGORY_FIELD] as string : null;
  const existingSubcategory = typeof existingFm[SUBCATEGORY_FIELD] === "string"
    ? existingFm[SUBCATEGORY_FIELD] as string : null;
  if (!existingSubcategory) {
    const matchesPipeline = existingCategory
      && ["Fitness", "Workouts", "Workout", "Exercise"].some(
        c => c.toLowerCase() === existingCategory.toLowerCase()
      );
    if (!existingCategory) {
      updates[CATEGORY_FIELD] = "Workouts";
      updates[SUBCATEGORY_FIELD] = extraction.workoutType;
    } else if (matchesPipeline) {
      updates[SUBCATEGORY_FIELD] = extraction.workoutType;
    }
  }
  return updates;
}

async function writeWorkoutToBookmark(
  app: App,
  file: TFile,
  extraction: WorkoutExtraction,
): Promise<void> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const updates = computeWorkoutBackfillFields(extraction, fm);
  const content = await app.vault.read(file);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated !== null) {
    await app.vault.modify(file, updated);
  }
}

// ── Main pipeline ──

interface WorkoutsPipelineResult {
  candidates: number;
  workouts: number;
  skipped: number;
  errors: number;
}

/** Workouts wiring for {@link runCategoryPipeline} — standard profile (tag fast-path, triage-throw → skip, extract-failure → demote). */
const WORKOUTS_CONFIG: CategoryPipelineConfig<
  WorkoutCandidate,
  WorkoutExtraction,
  "workout" | "skip",
  WorkoutsPipelineResult
> = {
  cacheFile: CACHE_FILE,
  concurrency: CONCURRENCY,
  extractVerdict: "workout",
  skipVerdict: "skip",
  onExtractFailure: "demote",
  onTriageFailure: "skip",
  gatherCandidates,
  fastPathTriage: c => (hasWorkoutFastPath(c.tags) ? "workout" : null),
  triageItem,
  extractItem: extractWorkout,
  onExtractError: (roostId, err) =>
    console.warn(`[roost] workouts: extraction error for ${roostId}:`, err),
  writeToBookmark: (app, c, ex) => writeWorkoutToBookmark(app, c.file, ex),
  storeExtractionInCache: false,
  buildResult: (candidates, cache, errors) => ({
    candidates: candidates.length,
    workouts: candidates.filter(
      c => cache[c.roostId]?.triage === "workout" && ((cache[c.roostId] as any)?.extracted === true || !!cache[c.roostId]?.extraction),
    ).length,
    skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
    errors,
  }),
  log: {
    candidatesFound: n => `Found ${n} workout candidates`,
    triageExtractCounts: (uncached, needExtract, complete) =>
      `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
    fastPath: n => `Tag fast-path: ${n} items auto-triaged as workout`,
    triageProgress: (done, total) => `Triaged ${done}/${total}`,
    wroteCached: n => `Wrote ${n} cached workouts`,
    extracting: n => `Extracting ${n} workouts...`,
    extractProgress: (done, total) => `Extracted ${done}/${total}`,
    done: r => `Done: ${r.workouts} workouts, ${r.skipped} skipped, ${r.errors} errors`,
  },
};

export async function runWorkoutsPipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
): Promise<WorkoutsPipelineResult> {
  return runCategoryPipeline(app, syncFolder, WORKOUTS_CONFIG, onLog);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the workouts pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_workout set, reads the
 *  workout_* fields, and returns a cache record keyed by roost_id. */
export function reconstructWorkoutsCache(
  app: App,
): Record<string, { triage: "workout"; extraction: null; extracted: true }> {
  const out: Record<string, { triage: "workout"; extraction: null; extracted: true }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_workout !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = { triage: "workout", extraction: null, extracted: true };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const WORKOUT_ENRICHMENT: EnrichmentDef = {
  id: "workout",
  displayName: "Workouts & Fitness",
  schemaVersion: 1,
  commandId: "run-workouts-pipeline",
  commandName: "Run Workouts extraction pipeline",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructWorkoutsCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runWorkoutsPipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog);
  },
  panelDetail: "Extract exercises, reps, and target areas from fitness bookmarks. Writes workout_* fields onto each source bookmark.",
  categoryMatches: ["Fitness", "Workouts", "Workout", "Exercise"],
  fieldsWritten: ["workout_name", "workout_type", "workout_target_area", "workout_difficulty", "workout_duration", "workout_equipment", "workout_exercises"],
  chips: [
    { field: "workout_duration", kind: "time" },
    { field: "workout_difficulty", kind: "difficulty" },
    { field: "workout_target_area", kind: "tag" },
  ],
};
