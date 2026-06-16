import { describe, it, expect } from "vitest";
import {
  recipeFromFrontmatter,
  placeFromFrontmatter,
  pipelineTypeFromFrontmatter,
} from "@/pipeline/extraction-from-frontmatter";

// ── recipeFromFrontmatter ──────────────────────────────────────────────────────

describe("recipeFromFrontmatter", () => {
  it("returns null when enrichment_v_recipe is absent", () => {
    expect(recipeFromFrontmatter({})).toBeNull();
  });

  it("returns null when enrichment_v_recipe is not a number", () => {
    expect(recipeFromFrontmatter({ enrichment_v_recipe: "1" })).toBeNull();
    expect(recipeFromFrontmatter({ enrichment_v_recipe: null })).toBeNull();
  });

  it("builds a RecipeExtraction from recipe_* frontmatter fields", () => {
    const fm = {
      enrichment_v_recipe: 1,
      recipe_dish: "Pasta Carbonara",
      recipe_cuisine: "Italian",
      recipe_ingredients: [{ item: "eggs", qty: "4" }, { item: "pancetta", qty: "100g" }],
      recipe_steps: ["Boil pasta", "Fry pancetta", "Mix eggs"],
      recipe_prep_time: "10 min",
      recipe_cook_time: "20 min",
      recipe_difficulty: "medium",
      recipe_link: "https://example.com/recipe",
    };

    const result = recipeFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.dish).toBe("Pasta Carbonara");
    expect(result!.cuisine).toBe("Italian");
    expect(result!.ingredients).toEqual([{ item: "eggs", qty: "4" }, { item: "pancetta", qty: "100g" }]);
    expect(result!.steps).toEqual(["Boil pasta", "Fry pancetta", "Mix eggs"]);
    expect(result!.prepTime).toBe("10 min");
    expect(result!.cookTime).toBe("20 min");
    expect(result!.difficulty).toBe("medium");
    expect(result!.notes).toBeNull();
    expect(result!.recipeLink).toBe("https://example.com/recipe");
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { enrichment_v_recipe: 2 };
    const result = recipeFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.dish).toBe("Unknown");
    expect(result!.cuisine).toBe("Unknown");
    expect(result!.ingredients).toEqual([]);
    expect(result!.steps).toEqual([]);
    expect(result!.prepTime).toBeNull();
    expect(result!.cookTime).toBeNull();
    expect(result!.difficulty).toBe("medium");
    expect(result!.notes).toBeNull();
    expect(result!.recipeLink).toBeNull();
  });

  it("coerces difficulty to 'easy' when value is 'easy'", () => {
    const fm = { enrichment_v_recipe: 1, recipe_difficulty: "easy" };
    expect(recipeFromFrontmatter(fm)!.difficulty).toBe("easy");
  });

  it("coerces difficulty to 'hard' when value is 'hard'", () => {
    const fm = { enrichment_v_recipe: 1, recipe_difficulty: "hard" };
    expect(recipeFromFrontmatter(fm)!.difficulty).toBe("hard");
  });

  it("falls back difficulty to 'medium' for unrecognised values", () => {
    const fm = { enrichment_v_recipe: 1, recipe_difficulty: "extreme" };
    expect(recipeFromFrontmatter(fm)!.difficulty).toBe("medium");
  });
});

// ── placeFromFrontmatter ───────────────────────────────────────────────────────

describe("placeFromFrontmatter", () => {
  it("returns null when enrichment_v_place is absent", () => {
    expect(placeFromFrontmatter({})).toBeNull();
  });

  it("returns null when enrichment_v_place is not a number", () => {
    expect(placeFromFrontmatter({ enrichment_v_place: "1" })).toBeNull();
  });

  it("builds a PlaceExtraction from place_* frontmatter fields", () => {
    const fm = {
      enrichment_v_place: 1,
      place_name: "Eiffel Tower",
      place_city: "Paris",
      place_country: "France",
      place_type: "Landmark",
      place_best_for: "Sightseeing",
      place_address: "Champ de Mars, 5 Av. Anatole France",
      place_lat: 48.8584,
      place_lng: 2.2945,
      place_description: "Iconic iron tower in Paris",
      place_vibes: ["romantic", "touristy"],
      place_tips: ["Go at night", "Book in advance"],
    };

    const result = placeFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Eiffel Tower");
    expect(result!.city).toBe("Paris");
    expect(result!.country).toBe("France");
    expect(result!.placeType).toBe("Landmark");
    expect(result!.bestFor).toBe("Sightseeing");
    expect(result!.address).toBe("Champ de Mars, 5 Av. Anatole France");
    expect(result!.lat).toBe(48.8584);
    expect(result!.lng).toBe(2.2945);
    expect(result!.description).toBe("Iconic iron tower in Paris");
    expect(result!.vibes).toEqual(["romantic", "touristy"]);
    expect(result!.tips).toEqual(["Go at night", "Book in advance"]);
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { enrichment_v_place: 1 };
    const result = placeFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Unknown");
    expect(result!.city).toBe("");
    expect(result!.country).toBe("");
    expect(result!.placeType).toBe("");
    expect(result!.bestFor).toBe("");
    expect(result!.address).toBeNull();
    expect(result!.lat).toBeNull();
    expect(result!.lng).toBeNull();
    expect(result!.description).toBe("");
    expect(result!.vibes).toEqual([]);
    expect(result!.tips).toEqual([]);
  });
});

// ── pipelineTypeFromFrontmatter ────────────────────────────────────────────────

describe("pipelineTypeFromFrontmatter", () => {
  it("returns null for empty frontmatter", () => {
    expect(pipelineTypeFromFrontmatter({})).toBeNull();
  });

  it("detects recipe via enrichment_v_recipe", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_recipe: 1 })).toBe("recipe");
  });

  it("detects place via enrichment_v_place", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_place: 1 })).toBe("place");
  });

  it("detects media via pipeline_v_media", () => {
    expect(pipelineTypeFromFrontmatter({ pipeline_v_media: 1 })).toBe("media");
  });

  it("detects media via enrichment_v_mediaExtraction", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_mediaExtraction: 2 })).toBe("media");
  });

  it("detects product via enrichment_v_product", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_product: 1 })).toBe("product");
  });

  it("detects workout via enrichment_v_workout", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_workout: 1 })).toBe("workout");
  });

  it("detects tutorial via enrichment_v_tutorial", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_tutorial: 1 })).toBe("tutorial");
  });

  it("detects home via enrichment_v_home", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_home: 1 })).toBe("home");
  });

  it("returns null when version fields are not numbers", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_recipe: "1", pipeline_v_media: null })).toBeNull();
  });

  it("recipe wins over place when both present (recipe checked first)", () => {
    expect(pipelineTypeFromFrontmatter({ enrichment_v_recipe: 1, enrichment_v_place: 1 })).toBe("recipe");
  });
});
