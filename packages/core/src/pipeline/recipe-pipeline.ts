/**
 * Recipe extraction pipeline — finds food/recipe bookmarks, triages them,
 * extracts structured recipe data, and writes recipe_* fields onto the source
 * bookmark's frontmatter.
 *
 * Data sources per item (in priority order):
 * 1. raw.json `contents` — structured line-by-line description (often has full recipe)
 * 2. frontmatter `title` — flattened caption (same data as contents, but one long string)
 * 3. frontmatter `subtitle` — speech-to-text transcript from the video
 * 4. embedding cache `vision` — LLM description of video frames
 * 5. raw.json `author.signature` — creator bio, may contain recipe site links
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

interface RecipeIngredient {
  item: string;
  qty: string | null;
}

interface RecipeExtraction {
  dish: string;
  cuisine: string;
  ingredients: string[];
  steps: string[];
  prepTime: string | null;
  cookTime: string | null;
  difficulty: "easy" | "medium" | "hard";
  notes: string | null;
  recipeLink: string | null;
}

interface CacheEntry {
  triage: "recipe" | "restaurant" | "skip";
  extraction: RecipeExtraction | null;
}


export interface RecipeCandidate {
  roostId: string;
  file: TFile;
  title: string;
  subtitle: string;
  /** Structured description from raw.json contents field (line-per-entry) */
  description: string;
  vision: string;
  tags: string[];
  author: string;
  authorHandle: string;
  url: string;
  /** Recipe site URL extracted from creator bio, if any */
  recipeLink: string | null;
}

// ── Constants ──

/** Single source of truth for the roost_category / roost_subcategory values the
 *  recipe pipeline owns. Consumed by FILED_RECIPE_CATEGORIES (the gather gate,
 *  lowercased) and RECIPE_ENRICHMENT.categoryMatches (UI/settings gating), so the
 *  two can't silently desync. */
const RECIPE_FILED_CATEGORIES = ["Recipes", "Food", "Food & Drink", "Cooking"] as const;

/** roost_category / roost_subcategory values the recipe pipeline owns. A note
 *  the user (or Smart-Assign) filed under one of these enters triage even if
 *  its embedding category/tags don't match. Derived from RECIPE_FILED_CATEGORIES.
 *  Exported for the sync test that guards it against RECIPE_ENRICHMENT.categoryMatches. */
export const FILED_RECIPE_CATEGORIES = new Set(RECIPE_FILED_CATEGORIES.map(c => c.toLowerCase()));

const CACHE_FILE = "recipe-cache.json";
const CONCURRENCY = 3;

const RECIPE_PIPELINE_VERSION = 1;

export const RECIPE_FIELDS = {
  dish: "recipe_dish",
  cuisine: "recipe_cuisine",
  prepTime: "recipe_prep_time",
  cookTime: "recipe_cook_time",
  difficulty: "recipe_difficulty",
  link: "recipe_link",
  ingredients: "recipe_ingredients",
  steps: "recipe_steps",
  version: "enrichment_v_recipe",
} as const;

/** Extract recipe-related link from author bio signature */
function extractRecipeLink(raw: any): string | null {
  const sig = raw?.author?.signature || "";
  if (!sig) return null;

  // Look for explicit URLs
  const urlMatch = sig.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0];

  // Look for domain patterns
  const domainMatch = sig.match(/\b[\w-]+\.(com|co|io|org|net)\b/i);
  if (domainMatch) return `https://${domainMatch[0]}`;

  return null;
}

// ── Candidate gathering ──

/** Id-only predicate — returns the set of roostIds that are recipe candidates.
 *  No readRawJson call, so this is cheap enough to use in the pending-pipeline scan. */
export function gatherRecipeCandidateIds(app: App, syncFolder: string): Set<string> {
  const fileIndex = buildFileIndex(app, syncFolder);
  const ids = new Set<string>();
  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
    const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
    const filedMatch = FILED_RECIPE_CATEGORIES.has(filedCat) || FILED_RECIPE_CATEGORIES.has(filedSub);
    if (filedMatch) ids.add(roostId);
  }
  return ids;
}

/** Exported for unit testing. */
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
    const description = extractDescription(raw);

    // raw is typed as Record<string, unknown> | null; cast inline to TikTok's
    // raw.json shape for the author handle access.
    const rawAuthor = raw?.author as { uniqueId?: string } | undefined;
    candidates.push({
      roostId,
      file,
      title: fm.title || "",
      subtitle: fm.subtitle || "",
      description,
      vision: embedded?.vision || "",
      tags: fm.tags || [],
      author: fm.author ? stripWikilink(fm.author) : "",
      authorHandle: rawAuthor?.uniqueId || "",
      url: fm.url || "",
      recipeLink: extractRecipeLink(raw),
    });
  }

  return candidates;
}

// ── Triage ──

/** True when the caption / structured description already contains a recipe —
 *  an explicit "ingredients" + "steps/method" pair, or several measurement-bearing
 *  lines. Used as a fast-path so a caption recipe is never lost to an unrelated
 *  transcript at the LLM triage step. */
export function hasCaptionRecipe(c: RecipeCandidate): boolean {
  const text = c.description || c.title || "";
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasIngredientsWord = /\bingredients?\b/.test(lower);
  const hasStepsWord = /\b(steps?|method|instructions?|directions?)\b/.test(lower);
  if (hasIngredientsWord && hasStepsWord) return true;
  const measure = /(\d|½|¼|¾|cups?|tbsp|tsp|tablespoons?|teaspoons?|grams?|\bg\b|\bml\b|\boz\b|pounds?|\blb\b|cloves?|pinch)/i;
  const lines = text.split(/\n|\s\|\s/).map(l => l.trim()).filter(Boolean);
  const ingredientLines = lines.filter(l => measure.test(l)).length;
  return ingredientLines >= 4;
}

function buildTriagePrompt(c: RecipeCandidate): string {
  // Use structured description if available (richer than flattened title)
  const text = c.description || c.title;
  return `You are classifying a social media bookmark about food or cooking.

Title: ${text.slice(0, 4000)}
Transcript: ${(c.subtitle || "No transcript available.").slice(0, 1000)}
Visual: ${(c.vision || "No description.").slice(0, 300)}

Classify as ONE of:
- "recipe" — contains actual cookable instructions (ingredients and/or steps to prepare a dish)
- "restaurant" — recommends a specific restaurant or place to eat
- "skip" — food content that is not a recipe or restaurant recommendation

Respond with ONLY one word: recipe, restaurant, or skip`;
}

async function triageItem(c: RecipeCandidate): Promise<"recipe" | "restaurant" | "skip"> {
  const raw = await ollamaGenerate(
    buildTriagePrompt(c),
    { numPredict: 5, numCtx: 2048 },
  );
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.startsWith("recipe")) return "recipe";
  if (word.startsWith("restaurant")) return "restaurant";
  return "skip";
}

// ── Extraction ──

function buildExtractPrompt(c: RecipeCandidate): string {
  // Assemble all available text, prioritizing structured description
  const sections: string[] = [];

  if (c.description) {
    sections.push(`Description (from post — may contain structured recipe):\n${c.description}`);
  } else if (c.title) {
    sections.push(`Caption: ${c.title}`);
  }

  if (c.subtitle) {
    sections.push(`Video transcript: ${c.subtitle}`);
  }

  if (c.vision) {
    sections.push(`Visual description: ${c.vision.slice(0, 500)}`);
  }

  if (c.tags.length > 0) {
    sections.push(`Tags: ${c.tags.slice(0, 15).join(", ")}`);
  }

  return `Extract the recipe from this social media video into structured JSON.
Use EXACT measurements when they appear in the description or transcript.
If a measurement is spoken informally (e.g. "a cup of flour"), convert it to a standard quantity.
If no amount is given for an ingredient, use null for qty.
The recipe may be NARRATED conversationally rather than written as a list.
Infer every ingredient mentioned (use qty: null when no amount is spoken) and
every step in the order the actions are described. Do not return empty arrays if
the text describes cooking a dish.

${sections.join("\n\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "dish": "Name of the dish",
  "cuisine": "Cuisine type (e.g. Italian, Mexican, American BBQ, Asian fusion)",
  "ingredients": [
    {"item": "ingredient name", "qty": "exact amount with unit, or null if not specified"}
  ],
  "steps": [
    "Step 1 description",
    "Step 2 description"
  ],
  "prepTime": "prep time or null",
  "cookTime": "cook time or null",
  "difficulty": "easy or medium or hard",
  "notes": "important tips, substitutions, or null"
}`;
}

async function runExtract(prompt: string): Promise<RecipeExtraction | null> {
  const raw = await ollamaGenerate(prompt, { numPredict: 2048, numCtx: 4096 });

  // Strip markdown fences if the model wraps the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    return {
      dish: parsed.dish || "Unknown Dish",
      cuisine: parsed.cuisine || "Unknown",
      ingredients: Array.isArray(parsed.ingredients)
        ? (parsed.ingredients as { item?: unknown; qty?: unknown }[])
            .map(i => {
              const item = String(i.item ?? "").trim();
              const qty = i.qty && i.qty !== "null" ? String(i.qty).trim() : "";
              return qty ? `${qty} ${item}` : item;
            })
            .filter(s => s.length > 0)
        : [],
      steps: Array.isArray(parsed.steps)
        ? (parsed.steps as unknown[]).map(s => String(s))
        : [],
      prepTime: parsed.prepTime || parsed.prep_time || null,
      cookTime: parsed.cookTime || parsed.cook_time || null,
      difficulty: ["easy", "medium", "hard"].includes(parsed.difficulty)
        ? parsed.difficulty
        : "medium",
      notes: parsed.notes && parsed.notes !== "null" ? parsed.notes : null,
      recipeLink: null, // populated by caller from candidate
    };
  } catch {
    return null;
  }
}

export async function extractRecipe(c: RecipeCandidate): Promise<RecipeExtraction | null> {
  let result = await runExtract(buildExtractPrompt(c));
  const isEmpty = (r: RecipeExtraction | null) =>
    !r || (r.ingredients.length === 0 && r.steps.length === 0);
  if (isEmpty(result)) {
    // One forceful repair pass — the first attempt found no list.
    const repair = buildExtractPrompt(c) +
      "\n\nThe previous attempt returned no ingredients or steps. This post DOES " +
      "contain a recipe — re-read the description and transcript carefully and list " +
      "every ingredient and every step in order.";
    result = await runExtract(repair);
  }
  // Empty after repair → null so the runner leaves it for a later run (e.g. once
  // a transcript is backfilled) rather than caching an empty recipe as 'done'.
  return isEmpty(result) ? null : result;
}

// ── Frontmatter write helpers ──

export function computeRecipeBackfillFields(
  extraction: RecipeExtraction,
  existingFm: Record<string, unknown>,
): Record<string, FrontmatterValue> {
  const updates: Record<string, FrontmatterValue> = {};
  updates[RECIPE_FIELDS.dish] = extraction.dish;
  updates[RECIPE_FIELDS.cuisine] = extraction.cuisine;
  updates[RECIPE_FIELDS.prepTime] = extraction.prepTime;
  updates[RECIPE_FIELDS.cookTime] = extraction.cookTime;
  updates[RECIPE_FIELDS.difficulty] = extraction.difficulty;
  updates[RECIPE_FIELDS.link] = extraction.recipeLink;
  updates[RECIPE_FIELDS.ingredients] = extraction.ingredients;
  updates[RECIPE_FIELDS.steps] = extraction.steps;
  updates[RECIPE_FIELDS.version] = RECIPE_PIPELINE_VERSION;

  // Subcategory backfill rule
  const existingCategory = typeof existingFm[CATEGORY_FIELD] === "string"
    ? existingFm[CATEGORY_FIELD] as string : null;
  const existingSubcategory = typeof existingFm[SUBCATEGORY_FIELD] === "string"
    ? existingFm[SUBCATEGORY_FIELD] as string : null;
  if (!existingSubcategory) {
    const matchesPipeline = existingCategory
      && ["Recipes", "Food", "Food & Drink", "Cooking"].some(
        c => c.toLowerCase() === existingCategory.toLowerCase()
      );
    if (matchesPipeline) {
      updates[SUBCATEGORY_FIELD] = extraction.cuisine;
    }
  }
  return updates;
}

async function writeRecipeToBookmark(
  app: App,
  file: TFile,
  extraction: RecipeExtraction,
): Promise<void> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const updates = computeRecipeBackfillFields(extraction, fm);
  const content = await app.vault.read(file);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated !== null) {
    await app.vault.modify(file, updated);
  }
}

// ── Main pipeline ──

interface RecipePipelineResult {
  candidates: number;
  recipes: number;
  restaurants: number;
  skipped: number;
  errors: number;
}

/**
 * Recipe wiring for the generic {@link runCategoryPipeline}. Every value here
 * reproduces the recipe pipeline's prior inline behavior verbatim — the
 * "recipe" extract verdict, the "skip" verdict, recipe's retry/leave failure
 * policy, the recipeLink post-extract attach, and the exact log strings.
 */
const RECIPE_CONFIG: CategoryPipelineConfig<
  RecipeCandidate,
  RecipeExtraction,
  "recipe" | "restaurant" | "skip",
  RecipePipelineResult
> = {
  cacheFile: CACHE_FILE,
  concurrency: CONCURRENCY,
  extractVerdict: "recipe",
  skipVerdict: "skip",
  onExtractFailure: "retry",
  onTriageFailure: "leave",
  gatherCandidates,
  fastPathTriage: (c) => (hasCaptionRecipe(c) ? "recipe" : null),
  triageItem,
  extractItem: extractRecipe,
  afterExtract: (ex, c) => { ex.recipeLink = c.recipeLink; },
  writeToBookmark: (app, c, ex) => writeRecipeToBookmark(app, c.file, ex),
  storeExtractionInCache: false,
  buildResult: (candidates, cache, errors) => ({
    candidates: candidates.length,
    recipes: candidates.filter(
      c => cache[c.roostId]?.triage === "recipe" && ((cache[c.roostId] as any)?.extracted === true || !!cache[c.roostId]?.extraction),
    ).length,
    restaurants: candidates.filter(c => cache[c.roostId]?.triage === "restaurant").length,
    skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
    errors,
  }),
  log: {
    candidatesFound: n => `Found ${n} food/recipe candidates`,
    triageExtractCounts: (uncached, needExtract, complete) =>
      `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
    fastPath: n => `Caption fast-path: ${n} recipes from the post text`,
    triageProgress: (done, total) => `Triage: ${done}/${total}`,
    wroteCached: n => `Wrote ${n} cached recipes`,
    extracting: n => `Extracting ${n} new recipes`,
    extractProgress: (done, total) => `Extract: ${done}/${total}`,
    done: r => `Done: ${r.recipes} recipes, ${r.restaurants} restaurants, ${r.skipped} skipped, ${r.errors} errors`,
  },
};

export async function runRecipePipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<RecipePipelineResult> {
  return runCategoryPipeline(app, syncFolder, RECIPE_CONFIG, onLog, signal);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the recipe pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_recipe set, reads the
 *  recipe_* fields, and returns a cache record keyed by roost_id. */
export function reconstructRecipeCache(
  app: App,
): Record<string, { triage: "recipe"; extraction: null; extracted: true }> {
  const out: Record<string, { triage: "recipe"; extraction: null; extracted: true }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_recipe !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = { triage: "recipe", extraction: null, extracted: true };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const RECIPE_ENRICHMENT: EnrichmentDef = {
  id: "recipe",
  displayName: "Recipes & Cooking",
  schemaVersion: 1,
  commandId: "run-recipe-pipeline",
  commandName: "Run Recipe extraction pipeline",
  cacheFile: CACHE_FILE,
  gatherCandidateIds: gatherRecipeCandidateIds,
  pendingExtractVerdict: "recipe",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructRecipeCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runRecipePipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog, opts?.signal);
  },
  panelDetail: "Extract ingredients and steps from food/cooking bookmarks. Writes recipe_* fields onto each source bookmark.",
  categoryMatches: [...RECIPE_FILED_CATEGORIES],
  fieldsWritten: ["recipe_dish", "recipe_cuisine", "recipe_prep_time", "recipe_cook_time", "recipe_difficulty", "recipe_link", "recipe_ingredients", "recipe_steps"],
  chips: [
    { field: "recipe_prep_time", kind: "time" },
    { field: "recipe_difficulty", kind: "difficulty" },
    { field: "recipe_cuisine", kind: "tag" },
  ],
};
