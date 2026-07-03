/**
 * Tests for recipe-pipeline-migrate.ts
 *
 * Focuses on the pure helper functions (stringFm-equivalent logic,
 * extraction reconstruction) rather than full vault I/O. Uses the
 * exported RECIPE_FIELDS + computeRecipeBackfillFields to verify the
 * migrator's field-mapping contract.
 */
import { describe, it, expect } from "vitest";
import { runRecipePipelineMigration } from "@/pipeline/recipe-pipeline-migrate";
import { RECIPE_FIELDS, computeRecipeBackfillFields } from "@/pipeline/recipe-pipeline";
import type { RecipeExtraction } from "@/types/roost";

// ── RECIPE_FIELDS contract ──────────────────────────────────────────────────

describe("RECIPE_FIELDS", () => {
  it("exports all expected field keys", () => {
    expect(RECIPE_FIELDS.dish).toBe("recipe_dish");
    expect(RECIPE_FIELDS.cuisine).toBe("recipe_cuisine");
    expect(RECIPE_FIELDS.prepTime).toBe("recipe_prep_time");
    expect(RECIPE_FIELDS.cookTime).toBe("recipe_cook_time");
    expect(RECIPE_FIELDS.difficulty).toBe("recipe_difficulty");
    expect(RECIPE_FIELDS.link).toBe("recipe_link");
    expect(RECIPE_FIELDS.ingredients).toBe("recipe_ingredients");
    expect(RECIPE_FIELDS.steps).toBe("recipe_steps");
    expect(RECIPE_FIELDS.version).toBe("enrichment_v_recipe");
  });
});

// ── computeRecipeBackfillFields ─────────────────────────────────────────────

const baseExtraction: RecipeExtraction = {
  dish: "Carbonara",
  cuisine: "Italian",
  ingredients: ["200g pasta", "100g guanciale"],
  steps: ["Boil pasta.", "Toss with cheese."],
  prepTime: "5 min",
  cookTime: "15 min",
  difficulty: "medium",
  notes: null,
  recipeLink: null,
};

describe("computeRecipeBackfillFields", () => {
  it("writes all recipe fields", () => {
    const updates = computeRecipeBackfillFields(baseExtraction, {});
    expect(updates[RECIPE_FIELDS.dish]).toBe("Carbonara");
    expect(updates[RECIPE_FIELDS.cuisine]).toBe("Italian");
    expect(updates[RECIPE_FIELDS.prepTime]).toBe("5 min");
    expect(updates[RECIPE_FIELDS.cookTime]).toBe("15 min");
    expect(updates[RECIPE_FIELDS.difficulty]).toBe("medium");
    expect(updates[RECIPE_FIELDS.version]).toBe(1);
  });

  it("does not assign roost_category/subcategory when source has none", () => {
    const updates = computeRecipeBackfillFields(baseExtraction, {});
    expect(updates["roost_category"]).toBeUndefined();
    expect(updates["roost_subcategory"]).toBeUndefined();
  });

  it("sets only subcategory when source already has a matching category", () => {
    const updates = computeRecipeBackfillFields(baseExtraction, { roost_category: "Recipes" });
    expect(updates["roost_category"]).toBeUndefined();
    expect(updates["roost_subcategory"]).toBe("Italian");
  });

  it("does not overwrite existing subcategory", () => {
    const updates = computeRecipeBackfillFields(baseExtraction, {
      roost_category: "Recipes",
      roost_subcategory: "Asian",
    });
    expect(updates["roost_subcategory"]).toBeUndefined();
  });

  it("leaves category alone when source has unrelated category", () => {
    const updates = computeRecipeBackfillFields(baseExtraction, { roost_category: "Fitness" });
    expect(updates["roost_category"]).toBeUndefined();
    expect(updates["roost_subcategory"]).toBeUndefined();
  });

  it("handles null prep/cook times", () => {
    const extraction = { ...baseExtraction, prepTime: null, cookTime: null };
    const updates = computeRecipeBackfillFields(extraction, {});
    expect(updates[RECIPE_FIELDS.prepTime]).toBeNull();
    expect(updates[RECIPE_FIELDS.cookTime]).toBeNull();
  });

  it("serialises recipe link when provided", () => {
    const extraction = { ...baseExtraction, recipeLink: "https://pasta.com/carbonara" };
    const updates = computeRecipeBackfillFields(extraction, {});
    expect(updates[RECIPE_FIELDS.link]).toBe("https://pasta.com/carbonara");
  });
});

// ── runRecipePipelineMigration export ───────────────────────────────────────

describe("runRecipePipelineMigration", () => {
  it("is a function (exports cleanly)", () => {
    expect(typeof runRecipePipelineMigration).toBe("function");
  });
});
