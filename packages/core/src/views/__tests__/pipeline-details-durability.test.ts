/**
 * Pipeline detail durability — the expanded-card extraction detail (renderRecipe
 * etc.) must survive a wiped pipeline cache. loadPipelineData reads the per-
 * pipeline caches, but the durable source of truth is each note's <cat>_*
 * frontmatter; when a cache is missing it must rebuild from frontmatter so the
 * detail never disappears. Regression guard for the "lost recipe extraction"
 * report (recipe-cache.json was gone but the recipe_* frontmatter survived).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, type App } from "obsidian";

// Force the pipeline cache files to look empty (by default) so loadPipelineData
// MUST reconstruct from frontmatter; no-op the self-heal save so the test writes
// nothing to disk. (reconstruct*Cache use getMarkdownFiles + metadataCache,
// not these two, so they stay fully real.) loadPipelineCache is a vi.fn so a
// single test can override it to return a populated cache (the merge path).
const loadPipelineCacheMock = vi.fn(
  (_vault: unknown, _file: string): Record<string, unknown> => ({}),
);
vi.mock("@/pipeline/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/shared")>();
  return {
    ...actual,
    loadPipelineCache: (vault: unknown, file: string) => loadPipelineCacheMock(vault, file),
    savePipelineCache: () => {},
  };
});

import { loadPipelineData, getPipelineData } from "@/views/pipeline-details";
import type { RecipeExtraction, MediaExtraction } from "@/types/roost";

beforeEach(() => {
  loadPipelineCacheMock.mockReset();
  loadPipelineCacheMock.mockReturnValue({});
});

/** An app whose vault/metadataCache are inert — used for the populated-cache
 *  merge path, where reconstruct*Cache (the cache-wipe self-heal) shouldn't run
 *  for any type. getMarkdownFiles returns [] so each reconstruct is a no-op. */
function inertApp(): App {
  return {
    vault: { getMarkdownFiles: () => [] },
    metadataCache: { getFileCache: () => undefined },
  } as unknown as App;
}

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

  // ── Plan 035: BOTH load paths must carry the resolved deep-link ids onto the
  //    MediaExtraction, so the card builds canonical links whether the cache
  //    file exists (loadPipelineData merge) or was wiped (reconstructMediaCache). ──

  it("reconstructMediaCache carries the five deep-link ids from frontmatter (cache-wiped path)", () => {
    // Default mock returns empty caches → loadPipelineData rebuilds media from frontmatter.
    const app = makeApp("Bookmarks/TikTok/m1.md", {
      roost_id: "m1",
      pipeline_v_media: 2,
      roost_subcategory: "Films",
      media_title: "Dune",
      media_creator: "Denis Villeneuve",
      media_spotify_id: "spfilm",
      media_tmdb_id: "438631",
      media_tmdb_type: "movie",
      media_anilist_id: "null",
      media_year: 2021,
    });

    loadPipelineData(app);

    const hit = getPipelineData("m1");
    expect(hit?.type).toBe("media");
    const ex = hit?.extraction as MediaExtraction;
    expect(ex.tmdbId).toBe("438631");
    expect(ex.tmdbType).toBe("movie");
    expect(ex.spotifyId).toBe("spfilm");
    expect(ex.anilistId).toBeNull(); // literal "null" frontmatter collapses to null
    expect(ex.year).toBe(2021);
  });

  it("loadPipelineData merges playback/deepLink ids off the media cache entry (populated-cache path)", () => {
    // Override the cache mock so the media cache file returns a populated entry
    // whose ids live on the playback/deepLink sub-objects (as the pipeline writes
    // them), NOT on extraction. The merge must lift them onto the extraction.
    loadPipelineCacheMock.mockImplementation((_vault: unknown, file: string) => {
      if (file === "media-cache.json") {
        return {
          c1: {
            triage: "media",
            extraction: {
              title: "Cowboy Bebop", creator: "Shinichiro Watanabe", mediaType: "anime",
              genre: "sci-fi", description: "", rating: null, where: null,
            },
            playback: { spotifyId: "trk999", resolvedAt: "2026-01-01" },
            deepLink: { tmdbId: "30991", tmdbType: "tv", anilistId: "1", resolvedAt: "2026-01-01", attempts: 1 },
          },
        };
      }
      return {};
    });

    loadPipelineData(inertApp());

    const hit = getPipelineData("c1");
    expect(hit?.type).toBe("media");
    const ex = hit?.extraction as MediaExtraction;
    expect(ex.spotifyId).toBe("trk999");
    expect(ex.tmdbId).toBe("30991");
    expect(ex.tmdbType).toBe("tv");
    expect(ex.anilistId).toBe("1");
  });
});
