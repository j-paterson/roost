/**
 * Pipeline detail durability — the expanded-card extraction detail (renderRecipe
 * etc.) must survive a wiped pipeline cache. loadPipelineData reads the per-
 * pipeline caches, but the durable source of truth is each note's <cat>_*
 * frontmatter; when a cache is missing it must rebuild from frontmatter so the
 * detail never disappears. Regression guard for the "lost recipe extraction"
 * report (recipe-cache.json was gone but the recipe_* frontmatter survived).
 */
import { describe, it, expect, vi } from "vitest";
import { TFile, type App } from "obsidian";

// Force the pipeline cache files to look empty so loadPipelineData MUST
// reconstruct from frontmatter; no-op the self-heal save so the test writes
// nothing to disk. (reconstruct*Cache use getMarkdownFiles + metadataCache,
// not these two, so they stay fully real.)
vi.mock("@/pipeline/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/shared")>();
  return { ...actual, loadPipelineCache: () => ({}), savePipelineCache: () => {} };
});

import { loadPipelineData, getPipelineData } from "@/views/pipeline-details";
import type { RecipeExtraction } from "@/types/roost";

function makeApp(path: string, fm: Record<string, unknown>): App {
  const file = Object.assign(new TFile(), { path });
  return {
    vault: { getMarkdownFiles: () => [file] },
    metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
  } as unknown as App;
}

describe("pipeline detail durability (cache-wipe self-heal)", () => {
  it("reconstructs the recipe extraction from frontmatter when the cache is wiped", () => {
    const app = makeApp("Bookmarks/TikTok/r1.md", {
      roost_id: "r1",
      enrichment_v_recipe: 1,
      recipe_dish: "Carbonara",
      recipe_cuisine: "Italian",
      recipe_ingredients: [{ item: "spaghetti", qty: "200g" }, { item: "egg", qty: "2" }],
      recipe_steps: ["Boil the pasta", "Toss with egg and pancetta"],
      recipe_difficulty: "easy",
    });

    loadPipelineData(app); // caches mocked empty → must rebuild from frontmatter

    const hit = getPipelineData("r1");
    expect(hit?.type).toBe("recipe");
    const ex = hit?.extraction as RecipeExtraction;
    expect(ex.dish).toBe("Carbonara");
    expect(ex.ingredients).toHaveLength(2);
    expect(ex.steps).toEqual(["Boil the pasta", "Toss with egg and pancetta"]);
  });

  it("does not invent a hit for a note with no pipeline frontmatter", () => {
    const app = makeApp("Bookmarks/TikTok/plain.md", { roost_id: "p1", title: "Just a video" });
    loadPipelineData(app);
    expect(getPipelineData("p1")).toBeNull();
  });
});
