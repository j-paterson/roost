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

import type { RecipeExtraction, PlaceExtraction } from "@/types/roost";
import type { PipelineType } from "@/views/pipeline-details";

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
    ingredients: Array.isArray(fm.recipe_ingredients) ? fm.recipe_ingredients : [],
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
