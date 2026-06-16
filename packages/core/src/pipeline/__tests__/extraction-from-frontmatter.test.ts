import { describe, it, expect } from "vitest";
import {
  recipeFromFrontmatter,
  placeFromFrontmatter,
  pipelineTypeFromFrontmatter,
  mediaFromFrontmatter,
  productFromFrontmatter,
  workoutFromFrontmatter,
  tutorialFromFrontmatter,
  homeFromFrontmatter,
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
      recipe_ingredients: ["4 eggs", "100g pancetta"],
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
    expect(result!.ingredients).toEqual(["4 eggs", "100g pancetta"]);
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

// ── mediaFromFrontmatter ───────────────────────────────────────────────────────

describe("mediaFromFrontmatter", () => {
  it("returns null when neither pipeline_v_media nor enrichment_v_mediaExtraction is present", () => {
    expect(mediaFromFrontmatter({})).toBeNull();
  });

  it("returns null when version fields are not numbers", () => {
    expect(mediaFromFrontmatter({ pipeline_v_media: "1" })).toBeNull();
    expect(mediaFromFrontmatter({ enrichment_v_mediaExtraction: null })).toBeNull();
  });

  it("builds a MediaExtraction from media_* frontmatter fields (pipeline_v_media gate)", () => {
    const fm = {
      pipeline_v_media: 3,
      media_title: "Dark Side of the Moon",
      media_creator: "Pink Floyd",
      roost_subcategory: "Music",
      media_genre: "Rock",
      media_rating: "5/5",
      media_where: "Spotify",
      media_description: "Classic album",
      media_spotify_id: "abc123",
      media_tmdb_id: null,
      media_tmdb_type: null,
      media_anilist_id: "",
      media_year: 1973,
    };

    const result = mediaFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Dark Side of the Moon");
    expect(result!.creator).toBe("Pink Floyd");
    expect(result!.mediaType).toBe("music");
    expect(result!.genre).toBe("Rock");
    expect(result!.rating).toBe("5/5");
    expect(result!.where).toBe("Spotify");
    expect(result!.description).toBe("Classic album");
    expect(result!.year).toBe(1973);
  });

  it("also gates on enrichment_v_mediaExtraction", () => {
    const fm = { enrichment_v_mediaExtraction: 2, media_title: "Dune" };
    const result = mediaFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Dune");
  });

  it("carries resolved spotifyId from frontmatter", () => {
    const fm = {
      pipeline_v_media: 1,
      media_spotify_id: "  spotify42  ",
    };
    const result = mediaFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.spotifyId).toBe("spotify42");
  });

  it("returns null for spotifyId when value is empty/null/literal-null", () => {
    expect(mediaFromFrontmatter({ pipeline_v_media: 1, media_spotify_id: "" })!.spotifyId).toBeNull();
    expect(mediaFromFrontmatter({ pipeline_v_media: 1, media_spotify_id: "null" })!.spotifyId).toBeNull();
    expect(mediaFromFrontmatter({ pipeline_v_media: 1 })!.spotifyId).toBeNull();
  });

  it("carries tmdbId and anilistId", () => {
    const fm = {
      pipeline_v_media: 1,
      media_tmdb_id: "tt1234567",
      media_tmdb_type: "movie",
      media_anilist_id: "9999",
    };
    const result = mediaFromFrontmatter(fm);
    expect(result!.tmdbId).toBe("tt1234567");
    expect(result!.tmdbType).toBe("movie");
    expect(result!.anilistId).toBe("9999");
  });

  it("nullifies tmdbType when value is not 'movie' or 'tv'", () => {
    const fm = { pipeline_v_media: 1, media_tmdb_type: "series" };
    expect(mediaFromFrontmatter(fm)!.tmdbType).toBeNull();
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { pipeline_v_media: 1 };
    const result = mediaFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Unknown");
    expect(result!.creator).toBe("");
    expect(result!.mediaType).toBe("other");
    expect(result!.genre).toBe("");
    expect(result!.rating).toBeNull();
    expect(result!.where).toBeNull();
    expect(result!.description).toBe("");
    expect(result!.spotifyId).toBeNull();
    expect(result!.tmdbId).toBeNull();
    expect(result!.tmdbType).toBeNull();
    expect(result!.anilistId).toBeNull();
    expect(result!.year).toBeNull();
  });
});

// ── productFromFrontmatter ─────────────────────────────────────────────────────

describe("productFromFrontmatter", () => {
  it("returns null when enrichment_v_product is absent", () => {
    expect(productFromFrontmatter({})).toBeNull();
  });

  it("returns null when enrichment_v_product is not a number", () => {
    expect(productFromFrontmatter({ enrichment_v_product: "1" })).toBeNull();
  });

  it("builds a ProductExtraction from product_* frontmatter fields", () => {
    const fm = {
      enrichment_v_product: 1,
      product_name: "AirPods Pro",
      product_brand: "Apple",
      product_type: "tech",
      product_price: "$249",
      product_rating: "4.5/5",
      product_where_to_buy: "Apple Store",
      product_description: "Wireless earbuds with ANC",
    };

    const result = productFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("AirPods Pro");
    expect(result!.brand).toBe("Apple");
    expect(result!.productType).toBe("tech");
    expect(result!.price).toBe("$249");
    expect(result!.rating).toBe("4.5/5");
    expect(result!.whereToBuy).toBe("Apple Store");
    expect(result!.description).toBe("Wireless earbuds with ANC");
  });

  it("falls back to 'other' for unrecognised productType", () => {
    const fm = { enrichment_v_product: 1, product_type: "vehicle" };
    expect(productFromFrontmatter(fm)!.productType).toBe("other");
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { enrichment_v_product: 1 };
    const result = productFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Unknown");
    expect(result!.brand).toBe("");
    expect(result!.productType).toBe("other");
    expect(result!.price).toBeNull();
    expect(result!.rating).toBeNull();
    expect(result!.whereToBuy).toBeNull();
    expect(result!.description).toBe("");
  });
});

// ── workoutFromFrontmatter ─────────────────────────────────────────────────────

describe("workoutFromFrontmatter", () => {
  it("returns null when enrichment_v_workout is absent", () => {
    expect(workoutFromFrontmatter({})).toBeNull();
  });

  it("returns null when enrichment_v_workout is not a number", () => {
    expect(workoutFromFrontmatter({ enrichment_v_workout: "1" })).toBeNull();
  });

  it("builds a WorkoutExtraction from workout_* frontmatter fields", () => {
    const fm = {
      enrichment_v_workout: 1,
      workout_name: "Full Body Blast",
      workout_type: "hiit",
      workout_target_area: "Full Body",
      workout_difficulty: "intermediate",
      workout_duration: "45 min",
      workout_equipment: ["dumbbells", "mat"],
      workout_exercises: [{ name: "Burpees", reps: "20" }],
      workout_notes: "Rest 30s between sets",
    };

    const result = workoutFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Full Body Blast");
    expect(result!.workoutType).toBe("hiit");
    expect(result!.targetArea).toBe("Full Body");
    expect(result!.difficulty).toBe("intermediate");
    expect(result!.duration).toBe("45 min");
    expect(result!.equipment).toEqual(["dumbbells", "mat"]);
    expect(result!.exercises).toEqual([{ name: "Burpees", reps: "20" }]);
    expect(result!.notes).toBe("Rest 30s between sets");
  });

  it("normalizes workout type aliases (e.g. weight-training → strength)", () => {
    const fm = { enrichment_v_workout: 1, workout_type: "weight-training" };
    expect(workoutFromFrontmatter(fm)!.workoutType).toBe("strength");
  });

  it("falls back to 'other' for unrecognised workout type", () => {
    const fm = { enrichment_v_workout: 1, workout_type: "juggling" };
    expect(workoutFromFrontmatter(fm)!.workoutType).toBe("other");
  });

  it("falls back difficulty to 'intermediate' for unrecognised value", () => {
    const fm = { enrichment_v_workout: 1, workout_difficulty: "elite" };
    expect(workoutFromFrontmatter(fm)!.difficulty).toBe("intermediate");
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { enrichment_v_workout: 1 };
    const result = workoutFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Unknown");
    expect(result!.workoutType).toBe("other");
    expect(result!.targetArea).toBe("");
    expect(result!.difficulty).toBe("intermediate");
    expect(result!.duration).toBeNull();
    expect(result!.equipment).toEqual([]);
    expect(result!.exercises).toEqual([]);
    expect(result!.notes).toBeNull();
  });
});

// ── tutorialFromFrontmatter ────────────────────────────────────────────────────

describe("tutorialFromFrontmatter", () => {
  it("returns null when enrichment_v_tutorial is absent", () => {
    expect(tutorialFromFrontmatter({})).toBeNull();
  });

  it("returns null when enrichment_v_tutorial is not a number", () => {
    expect(tutorialFromFrontmatter({ enrichment_v_tutorial: "1" })).toBeNull();
  });

  it("builds a TutorialExtraction from tutorial_* frontmatter fields", () => {
    const fm = {
      enrichment_v_tutorial: 1,
      tutorial_topic: "React Hooks",
      tutorial_skill_area: "Web Development",
      tutorial_difficulty: "beginner",
      tutorial_time_estimate: "2 hours",
      tutorial_description: "Learn useState and useEffect",
      tutorial_tools: ["VS Code", "Node.js"],
      tutorial_steps: ["Install Node", "Create project", "Add hooks"],
    };

    const result = tutorialFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe("React Hooks");
    expect(result!.skillArea).toBe("Web Development");
    expect(result!.difficulty).toBe("beginner");
    expect(result!.timeEstimate).toBe("2 hours");
    expect(result!.description).toBe("Learn useState and useEffect");
    expect(result!.tools).toEqual(["VS Code", "Node.js"]);
    expect(result!.steps).toEqual(["Install Node", "Create project", "Add hooks"]);
  });

  it("falls back difficulty to 'intermediate' for unrecognised value", () => {
    const fm = { enrichment_v_tutorial: 1, tutorial_difficulty: "expert" };
    expect(tutorialFromFrontmatter(fm)!.difficulty).toBe("intermediate");
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { enrichment_v_tutorial: 1 };
    const result = tutorialFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe("Unknown");
    expect(result!.skillArea).toBe("");
    expect(result!.difficulty).toBe("intermediate");
    expect(result!.timeEstimate).toBeNull();
    expect(result!.description).toBe("");
    expect(result!.tools).toEqual([]);
    expect(result!.steps).toEqual([]);
  });
});

// ── homeFromFrontmatter ────────────────────────────────────────────────────────

describe("homeFromFrontmatter", () => {
  it("returns null when enrichment_v_home is absent", () => {
    expect(homeFromFrontmatter({})).toBeNull();
  });

  it("returns null when enrichment_v_home is not a number", () => {
    expect(homeFromFrontmatter({ enrichment_v_home: "1" })).toBeNull();
  });

  it("builds a HomeExtraction from home_* frontmatter fields", () => {
    const fm = {
      enrichment_v_home: 1,
      home_title: "Cozy Reading Nook",
      home_room: "Living Room",
      home_idea_type: "Decor",
      home_style: "Scandinavian",
      home_budget: "$500",
      home_description: "Minimalist reading corner with warm lighting",
      home_products: ["IKEA shelf", "Floor lamp"],
      home_tips: ["Use warm bulbs", "Add plants"],
    };

    const result = homeFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Cozy Reading Nook");
    expect(result!.room).toBe("Living Room");
    expect(result!.ideaType).toBe("Decor");
    expect(result!.style).toBe("Scandinavian");
    expect(result!.budget).toBe("$500");
    expect(result!.description).toBe("Minimalist reading corner with warm lighting");
    expect(result!.products).toEqual(["IKEA shelf", "Floor lamp"]);
    expect(result!.tips).toEqual(["Use warm bulbs", "Add plants"]);
  });

  it("falls back to defaults for missing optional fields", () => {
    const fm = { enrichment_v_home: 1 };
    const result = homeFromFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Unknown");
    expect(result!.room).toBe("");
    expect(result!.ideaType).toBe("");
    expect(result!.style).toBe("");
    expect(result!.budget).toBeNull();
    expect(result!.description).toBe("");
    expect(result!.products).toEqual([]);
    expect(result!.tips).toEqual([]);
  });
});
