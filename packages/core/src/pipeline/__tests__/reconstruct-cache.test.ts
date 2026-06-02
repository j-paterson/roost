/**
 * Cache reconstruction tests — verifies reconstruct* functions scan source-bookmark
 * frontmatter (Bookmarks/) rather than legacy Pipelines/<X>/ synthesized notes.
 *
 * Field-name mapping (new source: source-bookmark frontmatter fields):
 *   recipe:   enrichment_v_recipe → recipe_dish, recipe_cuisine, etc.
 *   place:    enrichment_v_place  → place_name, place_city, etc.
 *   media:    pipeline_v_media    → media_title, media_creator, etc.
 *   product:  enrichment_v_product → product_name, product_brand, etc.
 *   workout:  enrichment_v_workout → workout_name, workout_type, etc.
 *   tutorial: enrichment_v_tutorial → tutorial_topic, tutorial_skill_area, etc.
 *   home:     enrichment_v_home   → home_title, home_room, etc.
 */
import { describe, it, expect } from "vitest";
import { App, TFile } from "obsidian";
import { reconstructRecipeCache } from "@/pipeline/recipe-pipeline";
import { reconstructPlacesCache } from "@/pipeline/places-pipeline";
import { reconstructMediaCache } from "@/pipeline/media-pipeline";
import { reconstructProductsCache } from "@/pipeline/products-pipeline";
import { reconstructWorkoutsCache } from "@/pipeline/workouts-pipeline";
import { reconstructTutorialsCache } from "@/pipeline/tutorials-pipeline";
import { reconstructHomeCache } from "@/pipeline/home-pipeline";

// ── Types ──

type PipelineId = "recipe" | "place" | "media" | "product" | "workout" | "tutorial" | "home";

/** Local PIPELINES-like registry for the test (reconstruct + metadata). */
const PIPELINES: Array<{
  id: PipelineId;
  label: string;
  cacheFile: string;
  outputDir: string;
  runner: unknown;
  reconstruct: (app: App) => Record<string, unknown>;
}> = [
  { id: "recipe", label: "Recipes & Cooking", cacheFile: "recipe-cache.json", outputDir: "Pipelines/Recipes", runner: () => {}, reconstruct: reconstructRecipeCache },
  { id: "place", label: "Places & Travel", cacheFile: "places-cache.json", outputDir: "Pipelines/Places", runner: () => {}, reconstruct: reconstructPlacesCache },
  { id: "media", label: "Media Lists", cacheFile: "media-cache.json", outputDir: "Pipelines/Media", runner: () => {}, reconstruct: reconstructMediaCache },
  { id: "product", label: "Products & Gear", cacheFile: "products-cache.json", outputDir: "Pipelines/Products", runner: () => {}, reconstruct: reconstructProductsCache },
  { id: "workout", label: "Workouts & Fitness", cacheFile: "workouts-cache.json", outputDir: "Pipelines/Workouts", runner: () => {}, reconstruct: reconstructWorkoutsCache },
  { id: "tutorial", label: "Tutorials & Skills", cacheFile: "tutorials-cache.json", outputDir: "Pipelines/Tutorials", runner: () => {}, reconstruct: reconstructTutorialsCache },
  { id: "home", label: "Home & Interiors", cacheFile: "home-cache.json", outputDir: "Pipelines/Home", runner: () => {}, reconstruct: reconstructHomeCache },
];

interface ReconstructCase {
  id: PipelineId;
  /** Path of the source bookmark file under Bookmarks/. */
  samplePath: string;
  sampleFrontmatter: Record<string, any>;
  assert: (entry: any) => void;
}

// ── Test helper ──

function makeApp(samplePath: string, fm: Record<string, any>): App {
  const file = Object.assign(new TFile(), { path: samplePath });
  return {
    vault: { getMarkdownFiles: () => [file] },
    metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
  } as any;
}

// ── Cases ──
// Each case uses a source-bookmark path under Bookmarks/ with the new
// enrichment_v_<id> version field and <pipe>_* extraction fields.

const CASES: ReconstructCase[] = [
  {
    id: "recipe",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      enrichment_v_recipe: 1,
      recipe_dish: "Pasta",
      recipe_cuisine: "Italian",
      recipe_difficulty: "easy",
      recipe_prep_time: "5 min",
      recipe_cook_time: "15 min",
      recipe_link: "https://example.com/pasta",
    },
    assert: (e) => {
      expect(e.triage).toBe("recipe");
      expect(e.extraction.dish).toBe("Pasta");
      expect(e.extraction.cuisine).toBe("Italian");
      expect(e.extraction.difficulty).toBe("easy");
      expect(e.extraction.prepTime).toBe("5 min");
      expect(e.extraction.cookTime).toBe("15 min");
      expect(e.extraction.recipeLink).toBe("https://example.com/pasta");
    },
  },
  {
    id: "place",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      enrichment_v_place: 1,
      place_name: "Trattoria Da Enzo",
      place_city: "Rome",
      place_country: "Italy",
      place_type: "restaurant",
      place_best_for: "carbonara",
    },
    assert: (e) => {
      expect(e.triage).toBe("place");
      expect(e.extraction.name).toBe("Trattoria Da Enzo");
      expect(e.extraction.city).toBe("Rome");
      expect(e.extraction.country).toBe("Italy");
      expect(e.extraction.placeType).toBe("restaurant");
      expect(e.extraction.bestFor).toBe("carbonara");
    },
  },
  {
    id: "media",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      pipeline_v_media: 2,
      media_title: "The Bear",
      media_creator: "Christopher Storer",
      roost_subcategory: "Series",
      media_genre: "drama",
      media_rating: "9/10",
      media_where: "Hulu",
    },
    assert: (e) => {
      expect(e.triage).toBe("media");
      expect(e.extraction.title).toBe("The Bear");
      expect(e.extraction.creator).toBe("Christopher Storer");
      expect(e.extraction.mediaType).toBe("series"); // lowercased from roost_subcategory
      expect(e.extraction.genre).toBe("drama");
      expect(e.extraction.rating).toBe("9/10");
      expect(e.extraction.where).toBe("Hulu");
    },
  },
  {
    id: "product",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      enrichment_v_product: 1,
      product_name: "Vitamix 5200",
      product_brand: "Vitamix",
      product_type: "other",
      product_price: "$549",
      product_where_to_buy: "Amazon",
    },
    assert: (e) => {
      expect(e.triage).toBe("product");
      expect(e.extraction.name).toBe("Vitamix 5200");
      expect(e.extraction.brand).toBe("Vitamix");
      expect(e.extraction.productType).toBe("other");
      expect(e.extraction.price).toBe("$549");
      expect(e.extraction.whereToBuy).toBe("Amazon");
    },
  },
  {
    id: "workout",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      enrichment_v_workout: 1,
      workout_name: "Lower Body Strength",
      workout_type: "strength",
      workout_target_area: "legs",
      workout_difficulty: "intermediate",
      workout_duration: "45 min",
    },
    assert: (e) => {
      expect(e.triage).toBe("workout");
      expect(e.extraction.name).toBe("Lower Body Strength");
      expect(e.extraction.workoutType).toBe("strength");
      expect(e.extraction.targetArea).toBe("legs");
      expect(e.extraction.difficulty).toBe("intermediate");
      expect(e.extraction.duration).toBe("45 min");
    },
  },
  {
    id: "tutorial",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      enrichment_v_tutorial: 1,
      tutorial_topic: "Pour-over coffee",
      tutorial_skill_area: "cooking",
      tutorial_difficulty: "beginner",
      tutorial_time_estimate: "5 min",
    },
    assert: (e) => {
      expect(e.triage).toBe("tutorial");
      expect(e.extraction.topic).toBe("Pour-over coffee");
      expect(e.extraction.skillArea).toBe("cooking");
      expect(e.extraction.difficulty).toBe("beginner");
      expect(e.extraction.timeEstimate).toBe("5 min");
    },
  },
  {
    id: "home",
    samplePath: "Bookmarks/synced/tiktok-abc/tiktok-abc.md",
    sampleFrontmatter: {
      roost_id: "tiktok:abc",
      enrichment_v_home: 1,
      home_title: "Living room reading corner",
      home_room: "living-room",
      home_idea_type: "decor",
      home_style: "mid-century modern",
    },
    assert: (e) => {
      expect(e.triage).toBe("home");
      expect(e.extraction.title).toBe("Living room reading corner");
      expect(e.extraction.room).toBe("living-room");
      expect(e.extraction.ideaType).toBe("decor");
      expect(e.extraction.style).toBe("mid-century modern");
    },
  },
];

// ── Tests ──

describe("pipeline cache reconstruction", () => {
  for (const c of CASES) {
    it(`${c.id}: rebuilds cache from source-bookmark frontmatter`, () => {
      const app = makeApp(c.samplePath, c.sampleFrontmatter);
      const def = PIPELINES.find(p => p.id === c.id)!;
      const cache = def.reconstruct(app);
      const entry = cache[c.sampleFrontmatter.roost_id];
      expect(entry).toBeTruthy();
      c.assert(entry);
    });
  }

  it("skips files outside Bookmarks/", () => {
    const app = makeApp("Some/Other/Folder/note.md", {
      roost_id: "tiktok:x",
      enrichment_v_recipe: 1,
      recipe_dish: "X",
    });
    const def = PIPELINES.find(p => p.id === "recipe")!;
    const cache = def.reconstruct(app);
    expect(Object.keys(cache)).toHaveLength(0);
  });

  it("skips files missing the enrichment version field", () => {
    const app = makeApp("Bookmarks/synced/tiktok-x/tiktok-x.md", {
      roost_id: "tiktok:x",
      recipe_dish: "X",
      // enrichment_v_recipe absent — should not be reconstructed
    });
    const def = PIPELINES.find(p => p.id === "recipe")!;
    const cache = def.reconstruct(app);
    expect(Object.keys(cache)).toHaveLength(0);
  });

  it("skips files missing roost_id", () => {
    const app = makeApp("Bookmarks/synced/tiktok-x/tiktok-x.md", {
      enrichment_v_recipe: 1,
      recipe_dish: "X",
      // roost_id absent
    });
    const def = PIPELINES.find(p => p.id === "recipe")!;
    const cache = def.reconstruct(app);
    expect(Object.keys(cache)).toHaveLength(0);
  });
});

describe("PIPELINES registry", () => {
  it("has a recipe entry with required fields", () => {
    const recipe = PIPELINES.find(p => p.id === "recipe");
    expect(recipe).toBeDefined();
    expect(recipe?.cacheFile).toBe("recipe-cache.json");
    expect(recipe?.outputDir).toBe("Pipelines/Recipes");
    expect(typeof recipe?.runner).toBe("function");
    expect(typeof recipe?.reconstruct).toBe("function");
  });

  it("every registered pipeline defines all fields", () => {
    for (const p of PIPELINES) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.cacheFile).toMatch(/-cache\.json$/);
      expect(p.outputDir.startsWith("Pipelines/")).toBe(true);
      expect(typeof p.runner).toBe("function");
      expect(typeof p.reconstruct).toBe("function");
    }
  });
});
