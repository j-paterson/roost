// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeRecipeBackfillFields } from "../recipe-pipeline";
import { computePlaceBackfillFields } from "../places-pipeline";
import { computeProductBackfillFields } from "../products-pipeline";
import { computeWorkoutBackfillFields } from "../workouts-pipeline";
import { computeTutorialBackfillFields } from "../tutorials-pipeline";
import { computeHomeBackfillFields } from "../home-pipeline";

type BackfillFn = (extraction: unknown, fm: Record<string, unknown>) => Record<string, unknown>;

const PIPELINE_BACKFILL_CASES: {
  id: string;
  compute: BackfillFn;
  extraction: unknown;
  category: string;
  subcategory: string;
  wrongCategory: string;
  assertFields: (updates: Record<string, unknown>) => void;
}[] = [
  {
    id: "recipe",
    compute: computeRecipeBackfillFields as BackfillFn,
    extraction: {
      dish: "Carbonara",
      cuisine: "Italian",
      prepTime: "10m",
      cookTime: "20m",
      difficulty: "medium",
      notes: null,
      recipeLink: "https://example.com/r",
      ingredients: ["eggs", "pasta"],
      steps: ["boil", "mix"],
    },
    category: "Recipes",
    subcategory: "Italian",
    wrongCategory: "Travel",
    assertFields: (u) => {
      expect(u.recipe_dish).toBe("Carbonara");
      expect(u.enrichment_v_recipe).toBe(1);
    },
  },
  {
    id: "place",
    compute: computePlaceBackfillFields as BackfillFn,
    extraction: {
      name: "Mister Jiu's",
      city: "San Francisco",
      country: "USA",
      placeType: "Restaurant",
      bestFor: "Modern Chinese",
      address: "28 Waverly Pl",
      description: "",
      vibes: [],
      tips: [],
      lat: 37.794,
      lng: -122.407,
    },
    category: "Places",
    subcategory: "Restaurant",
    wrongCategory: "Media",
    assertFields: (u) => {
      expect(u.place_name).toBe("Mister Jiu's");
      expect(u.place_lat).toBe(37.794);
      expect(u.enrichment_v_place).toBe(1);
    },
  },
  {
    id: "product",
    compute: computeProductBackfillFields as BackfillFn,
    extraction: {
      name: "Widget Pro",
      brand: "Acme",
      productType: "Tech",
      price: "$199",
      rating: "4.5",
      whereToBuy: "https://example.com",
      description: "",
    },
    category: "Products",
    subcategory: "Tech",
    wrongCategory: "Travel",
    assertFields: (u) => {
      expect(u.product_name).toBe("Widget Pro");
      expect(u.enrichment_v_product).toBe(1);
    },
  },
  {
    id: "workout",
    compute: computeWorkoutBackfillFields as BackfillFn,
    extraction: {
      name: "Full-body HIIT",
      workoutType: "Cardio",
      targetArea: "Full body",
      difficulty: "intermediate",
      duration: "20m",
      equipment: ["mat"],
      exercises: [{ name: "burpees", reps: null }],
      notes: null,
    },
    category: "Workouts",
    subcategory: "Cardio",
    wrongCategory: "Media",
    assertFields: (u) => {
      expect(u.workout_name).toBe("Full-body HIIT");
      expect(u.enrichment_v_workout).toBe(1);
    },
  },
  {
    id: "tutorial",
    compute: computeTutorialBackfillFields as BackfillFn,
    extraction: {
      topic: "Sourdough basics",
      skillArea: "Cooking",
      difficulty: "beginner",
      timeEstimate: "1h",
      description: "",
      tools: ["scale"],
      steps: ["mix", "rest"],
    },
    category: "Tutorials",
    subcategory: "Cooking",
    wrongCategory: "Recipes",
    assertFields: (u) => {
      expect(u.tutorial_topic).toBe("Sourdough basics");
      expect(u.enrichment_v_tutorial).toBe(1);
    },
  },
  {
    id: "home",
    compute: computeHomeBackfillFields as BackfillFn,
    extraction: {
      title: "Compact kitchen",
      room: "Kitchen",
      ideaType: "Storage",
      style: "Modern",
      budget: "$$",
      description: "",
      products: [],
      tips: ["use vertical space"],
    },
    category: "Home",
    subcategory: "Kitchen",
    wrongCategory: "Workouts",
    assertFields: (u) => {
      expect(u.home_title).toBe("Compact kitchen");
      expect(u.enrichment_v_home).toBe(1);
    },
  },
];

describe.each(PIPELINE_BACKFILL_CASES)("$id compute*BackfillFields", (c) => {
  it("writes typed fields and enrichment version", () => {
    c.assertFields(c.compute(c.extraction, {}));
  });

  it("sets category and subcategory when both empty in frontmatter", () => {
    const u = c.compute(c.extraction, {});
    expect(u.roost_category).toBe(c.category);
    expect(u.roost_subcategory).toBe(c.subcategory);
  });

  it("does not overwrite an existing subcategory", () => {
    const u = c.compute(c.extraction, {
      roost_category: c.category,
      roost_subcategory: "Existing",
    });
    expect(u.roost_subcategory).toBeUndefined();
  });

  it("does not set category when note already has a different category", () => {
    const u = c.compute(c.extraction, { roost_category: c.wrongCategory });
    expect(u.roost_category).toBeUndefined();
    expect(u.roost_subcategory).toBeUndefined();
  });
});
