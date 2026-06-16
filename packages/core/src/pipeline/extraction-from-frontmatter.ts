/**
 * extraction-from-frontmatter.ts
 *
 * Pure mapping functions: frontmatter Record → typed extraction objects.
 * These are the single-note counterparts of the reconstruct*Cache functions;
 * they contain exactly the same per-note field logic, lifted out so display
 * and cache-reconstruct callers share one definition.
 *
 * No Obsidian APIs, no I/O — pure functions of a plain object.
 */

import type {
  RecipeExtraction,
  PlaceExtraction,
  MediaExtraction,
  ProductExtraction,
  WorkoutExtraction,
  TutorialExtraction,
  HomeExtraction,
} from "@/types/roost";
import type { PipelineType } from "@/views/pipeline-details";

// ── Private helpers (inlined from pipeline modules — those versions are not exported) ──

/**
 * Read an id-style frontmatter value (mirrors readNullableIdFm in media-pipeline.ts):
 * absent / non-string / empty / literal "null" → null; trimmed non-empty string → that string.
 */
function readNullableIdFm(fm: Record<string, unknown>, key: string): string | null {
  const raw = fm[key];
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.toLowerCase() === "null") return null;
  return t;
}

/** Valid product categories (mirrors PRODUCT_CATEGORY_VALUES in products-pipeline.ts). */
const PRODUCT_CATEGORY_VALUES = new Set([
  "tech", "fashion", "beauty", "kitchen", "fitness",
  "home", "outdoor", "office", "kids", "other",
]);

/**
 * Narrow an arbitrary frontmatter value to a product category string,
 * defaulting to "other" (mirrors asProductCategory in products-pipeline.ts).
 */
function asProductCategory(v: unknown): string {
  return typeof v === "string" && PRODUCT_CATEGORY_VALUES.has(v) ? v : "other";
}

/** Valid workout types (mirrors VALID_WORKOUT_TYPES in workouts-pipeline.ts). */
const VALID_WORKOUT_TYPES = new Set([
  "strength", "cardio", "hiit", "yoga", "pilates",
  "stretching", "calisthenics", "martial-arts", "dance",
  "running", "cycling", "swimming", "other",
]);

/**
 * Normalize a raw workout_type string to a known type, with alias handling.
 * Mirrors normalizeWorkoutType in workouts-pipeline.ts.
 */
function normalizeWorkoutType(raw: string): string {
  const lower = (raw || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (VALID_WORKOUT_TYPES.has(lower)) return lower;
  if (lower === "weight-training" || lower === "weightlifting" || lower === "lifting" || lower === "bodybuilding") return "strength";
  if (lower === "crossfit") return "hiit";
  if (lower === "flexibility" || lower === "mobility") return "stretching";
  if (lower === "boxing" || lower === "kickboxing" || lower === "mma" || lower === "jiu-jitsu") return "martial-arts";
  if (lower === "jogging" || lower === "sprinting") return "running";
  if (lower === "spin" || lower === "biking") return "cycling";
  return "other";
}

// ── Recipe ────────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link RecipeExtraction}.
 * Returns `null` when `enrichment_v_recipe` is not a number (i.e. this note
 * has not been through the recipe pipeline).
 *
 * Field mapping mirrors `reconstructRecipeCache` in recipe-pipeline.ts.
 */
export function recipeFromFrontmatter(fm: Record<string, unknown>): RecipeExtraction | null {
  if (typeof fm.enrichment_v_recipe !== "number") return null;

  return {
    dish: String(fm.recipe_dish ?? "Unknown"),
    cuisine: String(fm.recipe_cuisine ?? "Unknown"),
    ingredients: Array.isArray(fm.recipe_ingredients) ? fm.recipe_ingredients as string[] : [],
    steps: Array.isArray(fm.recipe_steps) ? fm.recipe_steps : [],
    prepTime: typeof fm.recipe_prep_time === "string" ? fm.recipe_prep_time : null,
    cookTime: typeof fm.recipe_cook_time === "string" ? fm.recipe_cook_time : null,
    difficulty: (fm.recipe_difficulty === "easy" || fm.recipe_difficulty === "hard")
      ? fm.recipe_difficulty : "medium",
    notes: null,
    recipeLink: typeof fm.recipe_link === "string" ? fm.recipe_link : null,
  };
}

// ── Place ─────────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link PlaceExtraction}.
 * Returns `null` when `enrichment_v_place` is not a number.
 *
 * Field mapping mirrors `reconstructPlacesCache` in places-pipeline.ts.
 */
export function placeFromFrontmatter(fm: Record<string, unknown>): PlaceExtraction | null {
  if (typeof fm.enrichment_v_place !== "number") return null;

  return {
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
  };
}

// ── Media ─────────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link MediaExtraction}.
 * Returns `null` when neither `pipeline_v_media` nor `enrichment_v_mediaExtraction`
 * is a number (i.e. this note has not been through the media pipeline).
 *
 * Field mapping mirrors `reconstructMediaCache` in media-pipeline.ts, including
 * the resolved canonical deep-link ids (spotifyId, tmdbId, tmdbType, anilistId).
 * `readNullableIdFm` is inlined here because it is private in media-pipeline.ts.
 */
export function mediaFromFrontmatter(fm: Record<string, unknown>): MediaExtraction | null {
  if (typeof fm.pipeline_v_media !== "number" && typeof fm.enrichment_v_mediaExtraction !== "number") return null;

  const tmdbTypeRaw = fm["media_tmdb_type"];
  return {
    title: String(fm.media_title ?? "Unknown"),
    creator: typeof fm.media_creator === "string" ? fm.media_creator : "",
    mediaType: typeof fm.roost_subcategory === "string" ? fm.roost_subcategory.toLowerCase() : "other",
    genre: typeof fm.media_genre === "string" ? fm.media_genre : "",
    rating: typeof fm.media_rating === "string" ? fm.media_rating : null,
    where: typeof fm.media_where === "string" ? fm.media_where : null,
    description: typeof fm.media_description === "string" ? fm.media_description : "",
    spotifyId: readNullableIdFm(fm, "media_spotify_id"),
    tmdbId: readNullableIdFm(fm, "media_tmdb_id"),
    tmdbType: tmdbTypeRaw === "movie" || tmdbTypeRaw === "tv" ? tmdbTypeRaw : null,
    anilistId: readNullableIdFm(fm, "media_anilist_id"),
    year: typeof fm["media_year"] === "number" ? fm["media_year"] as number : null,
  };
}

// ── Product ───────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link ProductExtraction}.
 * Returns `null` when `enrichment_v_product` is not a number.
 *
 * Field mapping mirrors `reconstructProductsCache` in products-pipeline.ts.
 * `asProductCategory` is inlined here because it is private in products-pipeline.ts.
 */
export function productFromFrontmatter(fm: Record<string, unknown>): ProductExtraction | null {
  if (typeof fm.enrichment_v_product !== "number") return null;

  return {
    name: String(fm.product_name ?? "Unknown"),
    brand: typeof fm.product_brand === "string" ? fm.product_brand : "",
    productType: asProductCategory(fm.product_type),
    price: typeof fm.product_price === "string" ? fm.product_price : null,
    rating: typeof fm.product_rating === "string" ? fm.product_rating : null,
    whereToBuy: typeof fm.product_where_to_buy === "string" ? fm.product_where_to_buy : null,
    description: typeof fm.product_description === "string" ? fm.product_description : "",
  };
}

// ── Workout ───────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link WorkoutExtraction}.
 * Returns `null` when `enrichment_v_workout` is not a number.
 *
 * Field mapping mirrors `reconstructWorkoutsCache` in workouts-pipeline.ts.
 * `normalizeWorkoutType` is inlined here because it is private in workouts-pipeline.ts.
 */
export function workoutFromFrontmatter(fm: Record<string, unknown>): WorkoutExtraction | null {
  if (typeof fm.enrichment_v_workout !== "number") return null;

  return {
    name: String(fm.workout_name ?? "Unknown"),
    workoutType: normalizeWorkoutType(typeof fm.workout_type === "string" ? fm.workout_type : ""),
    targetArea: typeof fm.workout_target_area === "string" ? fm.workout_target_area : "",
    difficulty: (fm.workout_difficulty === "beginner" || fm.workout_difficulty === "advanced")
      ? fm.workout_difficulty : "intermediate",
    duration: typeof fm.workout_duration === "string" ? fm.workout_duration : null,
    equipment: Array.isArray(fm.workout_equipment) ? fm.workout_equipment : [],
    exercises: Array.isArray(fm.workout_exercises) ? fm.workout_exercises : [],
    notes: typeof fm.workout_notes === "string" ? fm.workout_notes : null,
  };
}

// ── Tutorial ──────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link TutorialExtraction}.
 * Returns `null` when `enrichment_v_tutorial` is not a number.
 *
 * Field mapping mirrors `reconstructTutorialsCache` in tutorials-pipeline.ts.
 */
export function tutorialFromFrontmatter(fm: Record<string, unknown>): TutorialExtraction | null {
  if (typeof fm.enrichment_v_tutorial !== "number") return null;

  return {
    topic: String(fm.tutorial_topic ?? "Unknown"),
    skillArea: typeof fm.tutorial_skill_area === "string" ? fm.tutorial_skill_area : "",
    difficulty: (fm.tutorial_difficulty === "beginner" || fm.tutorial_difficulty === "advanced")
      ? fm.tutorial_difficulty : "intermediate",
    timeEstimate: typeof fm.tutorial_time_estimate === "string" ? fm.tutorial_time_estimate : null,
    description: typeof fm.tutorial_description === "string" ? fm.tutorial_description : "",
    tools: Array.isArray(fm.tutorial_tools) ? fm.tutorial_tools : [],
    steps: Array.isArray(fm.tutorial_steps) ? fm.tutorial_steps : [],
  };
}

// ── Home ──────────────────────────────────────────────────────────────────────

/**
 * Map a source-bookmark frontmatter object to a {@link HomeExtraction}.
 * Returns `null` when `enrichment_v_home` is not a number.
 *
 * Field mapping mirrors `reconstructHomeCache` in home-pipeline.ts.
 */
export function homeFromFrontmatter(fm: Record<string, unknown>): HomeExtraction | null {
  if (typeof fm.enrichment_v_home !== "number") return null;

  return {
    title: String(fm.home_title ?? "Unknown"),
    room: typeof fm.home_room === "string" ? fm.home_room : "",
    ideaType: typeof fm.home_idea_type === "string" ? fm.home_idea_type : "",
    style: typeof fm.home_style === "string" ? fm.home_style : "",
    budget: typeof fm.home_budget === "string" ? fm.home_budget : null,
    description: typeof fm.home_description === "string" ? fm.home_description : "",
    products: Array.isArray(fm.home_products) ? fm.home_products : [],
    tips: Array.isArray(fm.home_tips) ? fm.home_tips : [],
  };
}

// ── Pipeline type resolver ────────────────────────────────────────────────────

/**
 * Detect which pipeline enriched a bookmark by inspecting its frontmatter
 * version fields.  Priority order matches the order pipelines are checked
 * in the display layer.  Returns `null` when no known pipeline version field
 * is present.
 */
export function pipelineTypeFromFrontmatter(fm: Record<string, unknown>): PipelineType | null {
  if (typeof fm.enrichment_v_recipe === "number") return "recipe";
  if (typeof fm.enrichment_v_place === "number") return "place";
  if (typeof fm.pipeline_v_media === "number" || typeof fm.enrichment_v_mediaExtraction === "number") return "media";
  if (typeof fm.enrichment_v_product === "number") return "product";
  if (typeof fm.enrichment_v_workout === "number") return "workout";
  if (typeof fm.enrichment_v_tutorial === "number") return "tutorial";
  if (typeof fm.enrichment_v_home === "number") return "home";
  return null;
}
