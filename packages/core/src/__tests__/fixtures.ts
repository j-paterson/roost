import * as fs from "fs";
import * as path from "path";
import type {
  RecipeExtraction, PlaceExtraction, MediaExtraction, ProductExtraction,
  WorkoutExtraction, TutorialExtraction, HomeExtraction, PipelineCacheEntry,
} from "@/types/roost";

export function makeRecipeExtraction(overrides: Partial<RecipeExtraction> = {}): RecipeExtraction {
  return {
    dish: "Cacio e Pepe",
    cuisine: "Italian",
    ingredients: [
      { qty: "400g", item: "spaghetti" },
      { qty: "200g", item: "pecorino romano" },
      { qty: "1 tbsp", item: "black pepper" },
    ],
    steps: ["Boil pasta.", "Toast pepper.", "Toss with cheese."],
    prepTime: "5 min",
    cookTime: "15 min",
    difficulty: "medium",
    notes: null,
    recipeLink: null,
    ...overrides,
  };
}

export function makePlaceExtraction(overrides: Partial<PlaceExtraction> = {}): PlaceExtraction {
  return {
    name: "Trattoria Da Enzo",
    city: "Rome",
    country: "Italy",
    placeType: "restaurant",
    description: "Classic Roman trattoria in Trastevere.",
    vibes: ["cozy", "authentic"],
    bestFor: "carbonara",
    tips: ["Go early; no reservations."],
    address: null,
    ...overrides,
  };
}

// Field-name reconciliations vs. task template:
//   template had `summary` → actual type uses `description`
//   template was missing `creator` → added with realistic default
export function makeMediaExtraction(overrides: Partial<MediaExtraction> = {}): MediaExtraction {
  return {
    title: "The Bear",
    mediaType: "tv",
    creator: "Christopher Storer",
    genre: "drama",
    description: "A Chicago chef returns to run his family sandwich shop.",
    rating: "9/10",
    where: "Hulu",
    ...overrides,
  };
}

// Field-name reconciliations vs. task template:
//   template had `category` → actual type uses `productType`
//   template had `summary`  → actual type uses `description`
//   actual type also has `rating`; added with null default
export function makeProductExtraction(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
  return {
    productType: "blender",
    name: "Vitamix 5200",
    brand: "Vitamix",
    price: "$549",
    rating: null,
    whereToBuy: "Amazon",
    description: "Workhorse blender.",
    ...overrides,
  };
}

// Field-name reconciliations vs. task template:
//   template had difficulty "medium" → actual type uses "beginner"|"intermediate"|"advanced"; using "intermediate"
//   template exercises had `sets`    → actual type omits sets; removed
//   template was missing `workoutType` and `equipment` → added with realistic defaults
export function makeWorkoutExtraction(overrides: Partial<WorkoutExtraction> = {}): WorkoutExtraction {
  return {
    workoutType: "strength",
    name: "Lower Body Strength",
    targetArea: "legs",
    difficulty: "intermediate",
    duration: "45 min",
    exercises: [
      { name: "back squat", reps: "6-8" },
      { name: "romanian deadlift", reps: "10" },
    ],
    equipment: ["barbell", "rack"],
    notes: null,
    ...overrides,
  };
}

// Field-name reconciliations vs. task template:
//   template had `skill`     → actual type uses `topic`
//   template had difficulty "easy" → actual type uses "beginner"|"intermediate"|"advanced"; using "beginner"
//   template had `tips`      → actual type has no `tips` field; removed
export function makeTutorialExtraction(overrides: Partial<TutorialExtraction> = {}): TutorialExtraction {
  return {
    skillArea: "coffee",
    topic: "Pour-over coffee",
    description: "How to brew a clean, balanced pour-over cup.",
    difficulty: "beginner",
    timeEstimate: "5 min",
    tools: ["V60", "scale", "gooseneck kettle"],
    steps: ["Rinse filter.", "Bloom 30s.", "Pour in stages."],
    ...overrides,
  };
}

// Field-name reconciliations vs. task template:
//   template had `idea`  → actual type uses `title` (+ separate `ideaType`)
//   template had `style` → actual type also has `style`; kept
//   actual type also has `ideaType`, `description`, `budget` → added with realistic defaults
export function makeHomeExtraction(overrides: Partial<HomeExtraction> = {}): HomeExtraction {
  return {
    room: "living-room",
    ideaType: "decor",
    title: "Living room reading corner",
    description: "A cozy reading nook anchored by a mid-century armchair.",
    style: "mid-century modern",
    products: ["armchair", "floor lamp", "rug"],
    budget: null,
    tips: ["Anchor with a rug."],
    ...overrides,
  };
}

export interface RawPost {
  id: string;
  text: string;
  author: string;
  url?: string;
  platform?: "tiktok" | "x";
}

export function makeRawPost(overrides: Partial<RawPost> = {}): RawPost {
  return {
    id: "post_abc12345",
    text: "How to make perfect cacio e pepe at home.",
    author: "@pastanight",
    url: "https://example.com/post/1",
    platform: "tiktok",
    ...overrides,
  };
}

export function seedPipelineCache(
  vaultBase: string,
  cacheFile: string,
  entries: Record<string, PipelineCacheEntry>,
): void {
  const dir = path.join(vaultBase, ".roost", "cache");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cacheFile), JSON.stringify(entries, null, 2));
}
