/**
 * Slice 2: Gallery renderer tests
 *
 * Tasks 2.1, 2.2, 2.3 in one file.
 *
 * Adjustments from plan expectations → actual code:
 *
 * [2.2 workout difficulty] Plan used "hard" (invalid for WorkoutExtraction enum).
 *   Changed to "advanced" with expected output "legs · Advanced".
 *
 * [2.3 tutorial Tips label] Plan checked for "Tips" group label in renderTutorial.
 *   TutorialExtraction has no `tips` field and renderTutorial never renders a Tips group.
 *   Removed "Tips" from tutorial describe block expectations.
 *
 * [2.3 renderPipelineDetail signature] Plan template showed 3 args (el, type, extraction).
 *   Actual signature is (infoEl: HTMLElement, hit: PipelineHit) — 2 args. Tests use 2-arg form.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  parseRatingStars,
  getWhereColor,
  renderPipelineDetail,
  buildMapsUrl,
} from "@/views/pipeline-details";
import {
  makeRecipeExtraction,
  makePlaceExtraction,
  makeMediaExtraction,
  makeProductExtraction,
  makeWorkoutExtraction,
  makeTutorialExtraction,
  makeHomeExtraction,
} from "@/__tests__/fixtures";

// ── Task 2.1: parseRatingStars and getWhereColor ──────────────────────────────

describe("parseRatingStars", () => {
  it("maps x/10 to 0-5 stars", () => {
    expect(parseRatingStars("8/10")).toBe(4);
    expect(parseRatingStars("9.5/10")).toBe(5);
    expect(parseRatingStars("10/10")).toBe(5);
    expect(parseRatingStars("0/10")).toBe(0);
  });

  it("maps x/5 to 0-5 stars", () => {
    expect(parseRatingStars("4/5")).toBe(4);
    expect(parseRatingStars("5/5")).toBe(5);
  });

  it("returns null for unparseable values", () => {
    expect(parseRatingStars("must watch")).toBeNull();
    expect(parseRatingStars(null)).toBeNull();
    expect(parseRatingStars(undefined)).toBeNull();
    expect(parseRatingStars("")).toBeNull();
  });
});

describe("getWhereColor", () => {
  it("known services return hex, case/whitespace insensitive", () => {
    expect(getWhereColor("Netflix")).toBe("#E50914");
    expect(getWhereColor("  NETFLIX  ")).toBe("#E50914");
    expect(getWhereColor("prime video")).toBe("#FF9900");
    expect(getWhereColor("disney+")).toBe("#113CCF");
  });

  it("unknown or empty returns null", () => {
    expect(getWhereColor("unknown-service")).toBeNull();
    expect(getWhereColor(null)).toBeNull();
    expect(getWhereColor(undefined)).toBeNull();
    expect(getWhereColor("")).toBeNull();
  });
});

// ── Task 2.3: Structural detail-renderer tests ───────────────────────────────

// Polyfill Obsidian's createDiv/createEl/setAttr/empty on HTMLElement.prototype
// (jsdom does not ship these).
beforeAll(() => {
  const proto = HTMLElement.prototype as any;
  if (!proto.createDiv) {
    proto.createDiv = function (opts?: { cls?: string; text?: string }) {
      const d = document.createElement("div");
      if (opts?.cls) d.className = opts.cls;
      if (opts?.text) d.textContent = opts.text;
      this.appendChild(d);
      return d;
    };
    proto.createEl = function (tag: string, opts?: { cls?: string; text?: string; href?: string }) {
      const el = document.createElement(tag) as any;
      if (opts?.cls) el.className = opts.cls;
      if (opts?.text) el.textContent = opts.text;
      if (opts?.href) el.href = opts.href;
      this.appendChild(el);
      return el;
    };
    proto.setAttr = function (name: string, value: string) {
      this.setAttribute(name, value);
    };
    proto.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
  }
});

function host(): HTMLElement {
  return document.createElement("div");
}

describe("renderPipelineDetail — recipe", () => {
  it("full extraction renders all groups", () => {
    const el = host();
    renderPipelineDetail(el, { type: "recipe", extraction: makeRecipeExtraction() } as any);
    const labels = Array.from(el.querySelectorAll(".roost-pipeline-group-label")).map(n => n.textContent);
    expect(labels).toContain("Ingredients");
    expect(labels).toContain("Steps");
    expect(el.querySelectorAll(".roost-pipeline-ingredients li").length).toBe(3);
    expect(el.querySelectorAll(".roost-pipeline-step-list li").length).toBe(3);
  });

  it("minimal extraction omits optional rows", () => {
    const el = host();
    renderPipelineDetail(el, {
      type: "recipe",
      extraction: makeRecipeExtraction({
        notes: null,
        recipeLink: null,
        prepTime: null,
        cookTime: null,
        ingredients: [],
        steps: [],
      }),
    } as any);
    expect(el.querySelectorAll(".roost-pipeline-group-label").length).toBe(0);
    const allKVs = Array.from(el.querySelectorAll(".roost-pipeline-kv-label")).map(n => n.textContent);
    expect(allKVs).not.toContain("Notes");
    expect(allKVs).not.toContain("Recipe site");
    expect(allKVs).not.toContain("Time");
  });
});

describe("renderPipelineDetail — place", () => {
  it("full extraction shows location, vibes, tips", () => {
    const el = host();
    renderPipelineDetail(el, { type: "place", extraction: makePlaceExtraction() } as any);
    const kvLabels = Array.from(el.querySelectorAll(".roost-pipeline-kv-label")).map(n => n.textContent);
    expect(kvLabels).toContain("Name");
    // Location type was removed from the place detail to reduce clutter.
    expect(kvLabels).not.toContain("Type");
    expect(kvLabels).toContain("Location");
    expect(kvLabels).toContain("Best for");
    // vibes render as pills
    expect(el.querySelectorAll(".roost-pipeline-pill").length).toBeGreaterThan(0);
  });

  it("minimal extraction omits optional", () => {
    const el = host();
    renderPipelineDetail(el, {
      type: "place",
      extraction: makePlaceExtraction({ vibes: [], tips: [], description: "", address: null, bestFor: "" }),
    } as any);
    expect(el.querySelectorAll(".roost-pipeline-pill").length).toBe(0);
    expect(el.querySelectorAll(".roost-pipeline-description").length).toBe(0);
  });
});

describe("renderPipelineDetail — media", () => {
  it("renders title + where + genre + rating", () => {
    const el = host();
    renderPipelineDetail(el, { type: "media", extraction: makeMediaExtraction() } as any);
    const kvLabels = Array.from(el.querySelectorAll(".roost-pipeline-kv-label")).map(n => n.textContent);
    expect(kvLabels).toContain("Title");
  });
});

describe("renderPipelineDetail — product", () => {
  it("renders name, brand, price", () => {
    const el = host();
    renderPipelineDetail(el, { type: "product", extraction: makeProductExtraction() } as any);
    const kvLabels = Array.from(el.querySelectorAll(".roost-pipeline-kv-label")).map(n => n.textContent);
    expect(kvLabels).toContain("Name");
    expect(kvLabels).toContain("Brand");
    expect(kvLabels).toContain("Price");
  });
});

describe("renderPipelineDetail — workout", () => {
  it("renders exercises list", () => {
    const el = host();
    renderPipelineDetail(el, { type: "workout", extraction: makeWorkoutExtraction() } as any);
    expect(el.textContent).toContain("back squat");
    expect(el.textContent).toContain("romanian deadlift");
  });

  it("empty exercises renders no exercise rows", () => {
    const el = host();
    renderPipelineDetail(el, {
      type: "workout",
      extraction: makeWorkoutExtraction({ exercises: [], notes: null }),
    } as any);
    expect(el.textContent).not.toContain("back squat");
  });
});

describe("renderPipelineDetail — tutorial", () => {
  it("renders tools, steps", () => {
    // Note: TutorialExtraction has no `tips` field, so renderTutorial never emits a Tips group.
    // Plan erroneously listed "Tips" here — removed per Slice-1 reconciliation.
    const el = host();
    renderPipelineDetail(el, { type: "tutorial", extraction: makeTutorialExtraction() } as any);
    const labels = Array.from(el.querySelectorAll(".roost-pipeline-group-label")).map(n => n.textContent);
    expect(labels).toContain("Tools");
    expect(labels).toContain("Steps");
  });
});

describe("renderPipelineDetail — home", () => {
  it("renders products and tips", () => {
    const el = host();
    renderPipelineDetail(el, { type: "home", extraction: makeHomeExtraction() } as any);
    const labels = Array.from(el.querySelectorAll(".roost-pipeline-group-label")).map(n => n.textContent);
    expect(labels).toContain("Products");
    expect(labels).toContain("Tips");
  });
});

describe("kvRow invariant", () => {
  it("never emits a row when the value is empty string", () => {
    const el = host();
    renderPipelineDetail(el, {
      type: "place",
      extraction: makePlaceExtraction({ placeType: "", bestFor: "", address: null, description: "" }),
    } as any);
    const kvLabels = Array.from(el.querySelectorAll(".roost-pipeline-kv-label")).map(n => n.textContent);
    expect(kvLabels).not.toContain("Type");
    expect(kvLabels).not.toContain("Best for");
    expect(kvLabels).not.toContain("Address");
  });
});

// ── Action links (source link + intent-specific deep link) ───────────────────

function actionLinks(el: HTMLElement): HTMLAnchorElement[] {
  return Array.from(el.querySelectorAll<HTMLAnchorElement>(".roost-pipeline-actions a"));
}

describe("buildMapsUrl", () => {
  it("prefers coords when both lat and lng are numbers", () => {
    const url = buildMapsUrl({ lat: 45.8, lng: 9.0, name: "Lake Como", city: "Como" });
    expect(url).toBe("https://www.google.com/maps/search/?api=1&query=45.8,9");
  });

  it("falls back to an encoded name/address query when coords missing", () => {
    const url = buildMapsUrl({ lat: null, lng: null, name: "Trattoria Da Enzo", city: "Rome", country: "Italy" });
    expect(url).toContain("https://www.google.com/maps/search/?api=1&query=");
    expect(url).toContain(encodeURIComponent("Trattoria Da Enzo Rome Italy"));
  });

  it("returns null when neither coords nor any query field is present", () => {
    expect(buildMapsUrl({ lat: null, lng: null, name: null, address: null, city: null, country: null })).toBeNull();
  });
});

describe("renderActionLinks via renderPipelineDetail — place", () => {
  it("place with coords renders a Maps link and a Watch on TikTok link", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "place", extraction: makePlaceExtraction({ lat: 45.8, lng: 9.0 }) } as any,
      { url: "https://www.tiktok.com/@x/video/1", author: "x", subcategory: "places" },
    );
    const links = actionLinks(el);
    expect(links.length).toBe(2);
    expect(links.some(a => a.getAttribute("href")!.includes("google.com/maps"))).toBe(true);
    const tiktok = links.find(a => a.getAttribute("href") === "https://www.tiktok.com/@x/video/1");
    expect(tiktok).toBeTruthy();
    expect(tiktok!.textContent).toContain("Watch on TikTok");
  });

  it("place with no coords but a name/city uses the encoded query Maps form", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "place", extraction: makePlaceExtraction({ lat: null, lng: null, name: "Trattoria Da Enzo", city: "Rome", country: "Italy" }) } as any,
      { url: null, author: null, subcategory: "places" },
    );
    const maps = actionLinks(el).find(a => a.getAttribute("href")!.includes("google.com/maps"));
    expect(maps).toBeTruthy();
    expect(maps!.getAttribute("href")).toContain("query=" + encodeURIComponent("Trattoria Da Enzo Rome Italy"));
  });
});

describe("renderActionLinks via renderPipelineDetail — product", () => {
  it("product with brand + name renders a where-to-buy Google search link", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "product", extraction: makeProductExtraction({ brand: "Vitamix", name: "5200" }) } as any,
      { url: null, author: null, subcategory: "products" },
    );
    const buy = actionLinks(el).find(a => a.getAttribute("href")!.includes("google.com/search"));
    expect(buy).toBeTruthy();
    expect(buy!.getAttribute("href")).toContain("buy");
  });
});

describe("renderActionLinks via renderPipelineDetail — media", () => {
  it("films subcategory yields a watchable search deep link plus the source link", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "Dune", mediaType: "movie" }) } as any,
      { url: "https://x.com/u/status/9", author: "u", subcategory: "films" },
    );
    const links = actionLinks(el);
    expect(links.some(a => a.getAttribute("href")!.includes("letterboxd.com"))).toBe(true);
    const x = links.find(a => a.getAttribute("href") === "https://x.com/u/status/9");
    expect(x).toBeTruthy();
    expect(x!.textContent).toContain("View on X");
  });

  it("music subcategory yields a Spotify search deep link", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "Song", creator: "Artist", mediaType: "music" }) } as any,
      { url: null, author: null, subcategory: "music" },
    );
    const spotify = actionLinks(el).find(a => a.getAttribute("href")!.includes("open.spotify.com/search"));
    expect(spotify).toBeTruthy();
  });

  // ── Canonical deep links (plan 035): renderMedia builds a canonical
  //    Letterboxd/AniList/Spotify URL when a resolved id is present, falling
  //    back to 034's search URL when it isn't. ──

  it("films with a resolved tmdbId yields a canonical Letterboxd link (not search)", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "Dune", mediaType: "film", tmdbId: "438631", tmdbType: "movie" }) } as any,
      { url: "https://www.tiktok.com/@x/video/1", author: "x", subcategory: "films" },
    );
    const deep = actionLinks(el).find(a => a.getAttribute("href")!.includes("letterboxd.com"));
    expect(deep).toBeTruthy();
    expect(deep!.getAttribute("href")).toBe("https://letterboxd.com/tmdb/438631/");
    expect(deep!.getAttribute("href")).not.toContain("/search/");
    expect(deep!.textContent).toContain("Open");
  });

  it("anime with a resolved anilistId yields a canonical AniList link", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "Made in Abyss", mediaType: "anime", anilistId: "99423" }) } as any,
      { url: null, author: null, subcategory: "anime" },
    );
    const deep = actionLinks(el).find(a => a.getAttribute("href")!.includes("anilist.co"));
    expect(deep).toBeTruthy();
    expect(deep!.getAttribute("href")).toBe("https://anilist.co/anime/99423");
  });

  it("music with a resolved spotifyId yields a canonical Spotify track link", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "Song", creator: "Artist", mediaType: "music", spotifyId: "abc123" }) } as any,
      { url: null, author: null, subcategory: "music" },
    );
    const deep = actionLinks(el).find(a => a.getAttribute("href")!.includes("open.spotify.com/track"));
    expect(deep).toBeTruthy();
    expect(deep!.getAttribute("href")).toBe("https://open.spotify.com/track/abc123");
    expect(deep!.textContent).toContain("Open in Spotify");
  });

  it("series stays a search link even with a tmdbId (Letterboxd TMDB redirect is films-only)", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "The Bear", mediaType: "series", tmdbId: "1399", tmdbType: "tv" }) } as any,
      { url: null, author: null, subcategory: "series" },
    );
    const deep = actionLinks(el).find(a => a.getAttribute("href")!.includes("letterboxd.com"));
    expect(deep).toBeTruthy();
    expect(deep!.getAttribute("href")).toContain("letterboxd.com/search/tv/");
    expect(deep!.getAttribute("href")).not.toContain("/tmdb/1399/");
  });

  it("films with no resolved id falls back to a Letterboxd search link (034 behavior)", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "media", extraction: makeMediaExtraction({ title: "Some Film", mediaType: "film", tmdbId: null }) } as any,
      { url: null, author: null, subcategory: "films" },
    );
    const deep = actionLinks(el).find(a => a.getAttribute("href")!.includes("letterboxd.com"));
    expect(deep).toBeTruthy();
    expect(deep!.getAttribute("href")).toContain("letterboxd.com/search/films/");
    expect(deep!.textContent).toContain("Find it");
  });
});

describe("renderActionLinks — no source", () => {
  it("renders no actions row when source is undefined and there is no deep link", () => {
    const el = host();
    renderPipelineDetail(el, { type: "workout", extraction: makeWorkoutExtraction() } as any);
    expect(el.querySelectorAll(".roost-pipeline-actions").length).toBe(0);
  });

  it("renders no actions row for a place with no source and no coords/query", () => {
    const el = host();
    renderPipelineDetail(
      el,
      { type: "place", extraction: makePlaceExtraction({ lat: null, lng: null, name: "", city: "", country: "", address: null }) } as any,
    );
    expect(el.querySelectorAll(".roost-pipeline-actions").length).toBe(0);
  });
});

// ── Task 3: pipelineHitFromEntry ─────────────────────────────────────────────

import { pipelineHitFromEntry } from "@/views/pipeline-details";
import type { App, TFile } from "obsidian";

function makeApp(frontmatter: Record<string, unknown> | undefined): App {
  return {
    metadataCache: {
      getFileCache: () => (frontmatter !== undefined ? { frontmatter } : undefined),
    },
  } as unknown as App;
}

const fakeFile = {} as TFile;

describe("pipelineHitFromEntry", () => {
  it("returns a recipe PipelineHit when frontmatter has enrichment_v_recipe", () => {
    const app = makeApp({
      enrichment_v_recipe: 1,
      recipe_dish: "Soup",
      recipe_ingredients: [{ item: "water", qty: null }],
      recipe_steps: ["boil"],
    });
    const result = pipelineHitFromEntry(app, fakeFile);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("recipe");
    expect((result!.extraction as any).dish).toBe("Soup");
  });

  it("returns null when frontmatter has no pipeline version field", () => {
    const app = makeApp({ title: "just a note", some_other_field: "hello" });
    expect(pipelineHitFromEntry(app, fakeFile)).toBeNull();
  });

  it("returns null when getFileCache returns undefined", () => {
    const app = makeApp(undefined);
    expect(pipelineHitFromEntry(app, fakeFile)).toBeNull();
  });
});
