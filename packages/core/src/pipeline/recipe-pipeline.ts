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
  ingredients: RecipeIngredient[];
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


interface RecipeCandidate {
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

const RECIPE_CATEGORIES = new Set([
  "recipe", "cooking", "food", "restaurant", "meal", "dinner",
  "lunch", "breakfast", "baking", "bbq", "grilling", "vegan",
  "vegetarian",
]);

const RECIPE_TAG_KEYWORDS = [
  "recipe", "cooking", "cook", "food", "baking", "meal",
  "dinner", "lunch", "breakfast", "ingredient",
];

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

function gatherCandidates(app: App, syncFolder: string): RecipeCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const candidates: RecipeCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const embedded = embeddingCache[roostId];
    const category = (embedded?.category || "").toLowerCase();
    const rawTags = Array.isArray(fm.tags) ? fm.tags : [];
    const tags: string[] = rawTags.map(t => String(t).toLowerCase());

    const categoryMatch = RECIPE_CATEGORIES.has(category);
    const tagMatch = tags.some(t =>
      RECIPE_TAG_KEYWORDS.some(kw => t.includes(kw)),
    );

    if (!categoryMatch && !tagMatch) continue;

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

function buildTriagePrompt(c: RecipeCandidate): string {
  // Use structured description if available (richer than flattened title)
  const text = c.description || c.title;
  return `You are classifying a social media bookmark about food or cooking.

Title: ${text.slice(0, 1500)}
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

async function extractRecipe(c: RecipeCandidate): Promise<RecipeExtraction | null> {
  const raw = await ollamaGenerate(
    buildExtractPrompt(c),
    { numPredict: 2048, numCtx: 4096 },
  );

  // Strip markdown fences if the model wraps the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    return {
      dish: parsed.dish || "Unknown Dish",
      cuisine: parsed.cuisine || "Unknown",
      ingredients: Array.isArray(parsed.ingredients)
        ? (parsed.ingredients as { item?: unknown; qty?: unknown }[]).map(i => ({
            item: String(i.item || ""),
            qty: i.qty && i.qty !== "null" ? String(i.qty) : null,
          }))
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
  updates[RECIPE_FIELDS.ingredients] = extraction.ingredients as unknown as string[];
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
    if (!existingCategory) {
      updates[CATEGORY_FIELD] = "Recipes";
      updates[SUBCATEGORY_FIELD] = extraction.cuisine;
    } else if (matchesPipeline) {
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
  triageItem,
  extractItem: extractRecipe,
  afterExtract: (ex, c) => { ex.recipeLink = c.recipeLink; },
  writeToBookmark: (app, c, ex) => writeRecipeToBookmark(app, c.file, ex),
  buildResult: (candidates, cache, errors) => ({
    candidates: candidates.length,
    recipes: candidates.filter(
      c => cache[c.roostId]?.triage === "recipe" && cache[c.roostId]?.extraction,
    ).length,
    restaurants: candidates.filter(c => cache[c.roostId]?.triage === "restaurant").length,
    skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
    errors,
  }),
  log: {
    candidatesFound: n => `Found ${n} food/recipe candidates`,
    triageExtractCounts: (uncached, needExtract, complete) =>
      `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
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
): Promise<RecipePipelineResult> {
  return runCategoryPipeline(app, syncFolder, RECIPE_CONFIG, onLog);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the recipe pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_recipe set, reads the
 *  recipe_* fields, and returns a cache record keyed by roost_id. */
export function reconstructRecipeCache(
  app: App,
): Record<string, { triage: "recipe"; extraction: RecipeExtraction }> {
  const out: Record<string, { triage: "recipe"; extraction: RecipeExtraction }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_recipe !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = {
      triage: "recipe",
      extraction: {
        dish: String(fm.recipe_dish ?? "Unknown"),
        cuisine: String(fm.recipe_cuisine ?? "Unknown"),
        ingredients: Array.isArray(fm.recipe_ingredients) ? fm.recipe_ingredients : [],
        steps: Array.isArray(fm.recipe_steps) ? fm.recipe_steps : [],
        prepTime: typeof fm.recipe_prep_time === "string" ? fm.recipe_prep_time : null,
        cookTime: typeof fm.recipe_cook_time === "string" ? fm.recipe_cook_time : null,
        difficulty: (fm.recipe_difficulty === "easy" || fm.recipe_difficulty === "hard")
          ? fm.recipe_difficulty : "medium",
        notes: null,
        recipeLink: typeof fm.recipe_link === "string" ? fm.recipe_link : null,
      },
    };
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
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructRecipeCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runRecipePipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog);
  },
  panelDetail: "Extract ingredients and steps from food/cooking bookmarks. Writes recipe_* fields onto each source bookmark.",
  categoryMatches: ["Recipes", "Food", "Food & Drink", "Cooking"],
  fieldsWritten: ["recipe_dish", "recipe_cuisine", "recipe_prep_time", "recipe_cook_time", "recipe_difficulty", "recipe_link", "recipe_ingredients", "recipe_steps"],
  chips: [
    { field: "recipe_prep_time", kind: "time" },
    { field: "recipe_difficulty", kind: "difficulty" },
    { field: "recipe_cuisine", kind: "tag" },
  ],
};
