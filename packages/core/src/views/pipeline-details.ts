/**
 * Pipeline extraction overlays and expanded detail sections for the gallery.
 *
 * Loads all pipeline caches once, provides:
 *   - getPipelineData(roostId) → type + extraction or null
 *   - renderPipelineOverlay(coverEl, type) → small themed icon on compact card
 *   - renderPipelineDetail(infoEl, type, extraction) → rich section in expanded card
 */
import { App, TFile } from "obsidian";
import { detectPlatformFromUrl } from "@/lib/extract";
import {
  pipelineTypeFromFrontmatter,
  recipeFromFrontmatter,
  placeFromFrontmatter,
  mediaFromFrontmatter,
  productFromFrontmatter,
  workoutFromFrontmatter,
  tutorialFromFrontmatter,
  homeFromFrontmatter,
} from "@/pipeline/extraction-from-frontmatter";
import { watchableUrl } from "@/views/pipeline-views/watchable-url";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";
import { reconstructRecipeCache } from "@/pipeline/recipe-pipeline";
import { reconstructPlacesCache } from "@/pipeline/places-pipeline";
import { reconstructMediaCache } from "@/pipeline/media-pipeline";
import { reconstructProductsCache } from "@/pipeline/products-pipeline";
import { reconstructWorkoutsCache } from "@/pipeline/workouts-pipeline";
import { reconstructTutorialsCache } from "@/pipeline/tutorials-pipeline";
import { reconstructHomeCache } from "@/pipeline/home-pipeline";
import type {
  PipelineCacheEntry, AnyExtractionData,
  RecipeExtraction, PlaceExtraction, MediaExtraction,
  ProductExtraction, WorkoutExtraction, TutorialExtraction, HomeExtraction,
} from "@/types/roost";

// ── Pipeline types ──

export type PipelineType = "recipe" | "place" | "media" | "product" | "workout" | "tutorial" | "home";

export interface PipelineHit {
  type: PipelineType;
  extraction: AnyExtractionData;
}

/** The note's source/intent context, threaded through to the detail renderers
 *  so each can offer a "watch source" link plus an intent-specific deep link. */
export interface PipelineSource {
  url: string | null;
  author: string | null;
  subcategory: string | null; // note.roost_subcategory (plural, e.g. "films")
}

// Icon + color for each pipeline type
const PIPELINE_META: Record<PipelineType, { icon: string; label: string; color: string }> = {
  recipe:   { icon: "🍳", label: "Recipe",   color: "#e67e22" },
  place:    { icon: "📍", label: "Place",    color: "#27ae60" },
  media:    { icon: "🎬", label: "Media",    color: "#8e44ad" },
  product:  { icon: "🛒", label: "Product",  color: "#2980b9" },
  workout:  { icon: "💪", label: "Workout",  color: "#e74c3c" },
  tutorial: { icon: "🎓", label: "Tutorial", color: "#f39c12" },
  home:     { icon: "🏠", label: "Home",     color: "#16a085" },
};

// [type, cacheFile, triage-match, reconstruct-from-frontmatter]. The reconstruct
// fn rebuilds the cache from each note's durable <cat>_* frontmatter — the
// source of truth — so the detail survives a cache wipe.
const CACHE_FILES: [PipelineType, string, string, (app: App) => Record<string, PipelineCacheEntry>][] = [
  ["recipe",   "recipe-cache.json",    "recipe",   reconstructRecipeCache],
  ["place",    "places-cache.json",    "place",    reconstructPlacesCache],
  ["media",    "media-cache.json",     "media",    reconstructMediaCache],
  ["product",  "products-cache.json",  "product",  reconstructProductsCache],
  ["workout",  "workouts-cache.json",  "workout",  reconstructWorkoutsCache],
  ["tutorial", "tutorials-cache.json", "tutorial", reconstructTutorialsCache],
  ["home",     "home-cache.json",      "home",     reconstructHomeCache],
];

// ── Cache loading ──

/** The media cache file's entries carry resolved deep-link ids on sibling
 *  sub-objects (mirrors media-pipeline.ts PlaybackResolution/DeepLinkResolution).
 *  The generic PipelineCacheEntry doesn't type them, so loadPipelineData reads
 *  them behind this narrow structural shape and merges them onto the stored
 *  MediaExtraction — otherwise the ids on disk are dropped and the card can only
 *  build search links. */
interface MediaCacheExtras {
  playback?: { spotifyId: string | null };
  deepLink?: { tmdbId: string | null; tmdbType: "movie" | "tv" | null; anilistId: string | null };
}

let pipelineLookup: Map<string, PipelineHit> | null = null;

export function loadPipelineData(app: App): void {
  pipelineLookup = new Map();
  for (const [type, file, triageMatch, reconstruct] of CACHE_FILES) {
    let cache = loadPipelineCache<PipelineCacheEntry>(app.vault, file);
    // Self-heal: the expanded-card detail reads from these pipeline caches, but
    // the durable source of truth is each note's <cat>_* frontmatter. If the
    // cache file is missing or has been wiped, rebuild it from frontmatter so
    // the detail never disappears — and persist it so the scan only runs once.
    if (Object.keys(cache).length === 0) {
      const rebuilt = reconstruct(app);
      if (Object.keys(rebuilt).length > 0) {
        cache = rebuilt;
        savePipelineCache(app.vault, file, cache);
      }
    }
    for (const [id, entry] of Object.entries(cache)) {
      // Only include items that were triaged as relevant AND have extraction data
      if (entry.triage === triageMatch && entry.extraction) {
        let extraction = entry.extraction;
        // For the media cache, lift the resolved deep-link ids off the entry's
        // playback/deepLink sub-objects onto the MediaExtraction so the card can
        // build canonical links (not just search). Only the media cache has these.
        if (type === "media") {
          const ex = entry as PipelineCacheEntry & MediaCacheExtras;
          const m = extraction as MediaExtraction;
          extraction = {
            ...m,
            spotifyId: ex.playback?.spotifyId ?? m.spotifyId ?? null,
            tmdbId: ex.deepLink?.tmdbId ?? m.tmdbId ?? null,
            tmdbType: ex.deepLink?.tmdbType ?? m.tmdbType ?? null,
            anilistId: ex.deepLink?.anilistId ?? m.anilistId ?? null,
          } as MediaExtraction;
        }
        pipelineLookup.set(id, { type, extraction });
      }
    }
  }
}

export function getPipelineData(roostId: string): PipelineHit | null {
  return pipelineLookup?.get(roostId) ?? null;
}

export function pipelineHitFromEntry(app: App, file: TFile): PipelineHit | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return null;
  const type = pipelineTypeFromFrontmatter(fm);
  if (!type) return null;
  const extraction =
    type === "recipe" ? recipeFromFrontmatter(fm) :
    type === "place" ? placeFromFrontmatter(fm) :
    type === "media" ? mediaFromFrontmatter(fm) :
    type === "product" ? productFromFrontmatter(fm) :
    type === "workout" ? workoutFromFrontmatter(fm) :
    type === "tutorial" ? tutorialFromFrontmatter(fm) :
    homeFromFrontmatter(fm);
  return extraction ? { type, extraction } : null;
}

// ── Compact card overlay ──

export function renderPipelineOverlay(coverEl: HTMLElement, type: PipelineType): void {
  const meta = PIPELINE_META[type];
  const overlay = coverEl.createDiv({ cls: "roost-pipeline-overlay" });
  overlay.dataset.type = type;
  overlay.style.setProperty("--pipeline-color", meta.color);
  overlay.createEl("span", { cls: "roost-pipeline-overlay-icon", text: meta.icon });
  overlay.createEl("span", { cls: "roost-pipeline-overlay-label", text: meta.label });
}

// ── Expanded card detail section ──

export function renderPipelineDetail(infoEl: HTMLElement, hit: PipelineHit, source?: PipelineSource): void {
  const meta = PIPELINE_META[hit.type];
  const section = infoEl.createDiv({ cls: "roost-pipeline-section" });
  section.style.setProperty("--pipeline-color", meta.color);
  section.dataset.pipelineType = hit.type;

  // Delegate to type-specific renderer.
  // hit.type and hit.extraction are separate fields so TypeScript can't narrow
  // extraction automatically — we cast to the specific type in each branch.
  const content = section.createDiv({ cls: "roost-pipeline-section-content" });
  switch (hit.type) {
    case "recipe":   renderRecipe(content, hit.extraction as RecipeExtraction, source); break;
    case "place":    renderPlace(content, hit.extraction as PlaceExtraction, source); break;
    case "media":    renderMedia(content, hit.extraction as MediaExtraction, source); break;
    case "product":  renderProduct(content, hit.extraction as ProductExtraction, source); break;
    case "workout":  renderWorkout(content, hit.extraction as WorkoutExtraction, source); break;
    case "tutorial": renderTutorial(content, hit.extraction as TutorialExtraction, source); break;
    case "home":     renderHome(content, hit.extraction as HomeExtraction, source); break;
  }
}

// ── Media card helpers ──

/** Where-to-watch service color map */
const WHERE_COLORS: Record<string, string> = {
  netflix: "#E50914",
  amazon: "#FF9900",
  "prime video": "#FF9900",
  "disney+": "#113CCF",
  "disney plus": "#113CCF",
  hbo: "#5822b4",
  "hbo max": "#5822b4",
  max: "#5822b4",
  "apple tv": "#555",
  "apple tv+": "#555",
  hulu: "#1CE783",
  spotify: "#1DB954",
  youtube: "#FF0000",
  crunchyroll: "#F47521",
};

/** Parse a rating string like "8/10", "9.5/10", "must watch" into 0-5 star count, or null */
export function parseRatingStars(rating: string | null | undefined): number | null {
  if (!rating) return null;
  const match = rating.match(/^(\d+(?:\.\d+)?)\s*\/\s*10$/);
  if (match) return Math.round(parseFloat(match[1]) / 2);
  const match5 = rating.match(/^(\d+(?:\.\d+)?)\s*\/\s*5$/);
  if (match5) return Math.round(parseFloat(match5[1]));
  return null;
}

/** Get the color for a "where to watch" service, or null for default */
export function getWhereColor(where: string | null | undefined): string | null {
  if (!where) return null;
  const key = where.trim().toLowerCase();
  return WHERE_COLORS[key] ?? null;
}

// ── Helpers ──

function kvRow(parent: HTMLElement, label: string, value: string | null | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  // "Unknown", "Unknown, US", "Other" are placeholder values from extraction pipelines — skip
  if (/^unknown(,|\s|$)/i.test(trimmed) || trimmed.toLowerCase() === "other") return;
  const row = parent.createDiv({ cls: "roost-pipeline-kv" });
  row.createEl("span", { cls: "roost-pipeline-kv-label", text: label });
  row.createEl("span", { cls: "roost-pipeline-kv-value", text: trimmed });
}

function pillList(parent: HTMLElement, items: string[]): void {
  if (!items || items.length === 0) return;
  const row = parent.createDiv({ cls: "roost-pipeline-pills" });
  for (const item of items) {
    row.createEl("span", { cls: "roost-pipeline-pill", text: item });
  }
}

function numberedList(parent: HTMLElement, items: string[]): void {
  if (!items || items.length === 0) return;
  const ol = parent.createEl("ol", { cls: "roost-pipeline-step-list" });
  for (const step of items) {
    ol.createEl("li", { text: step });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");
}

// ── Action links (source + intent-specific deep link) ──

/** Build a Google Maps URL from coords (preferred) or a name/address query. */
export function buildMapsUrl(o: { lat?: number | null; lng?: number | null; address?: string | null; name?: string | null; city?: string | null; country?: string | null }): string | null {
  if (typeof o.lat === "number" && typeof o.lng === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}`;
  }
  const q = [o.name, o.address, o.city, o.country].filter(Boolean).join(" ").trim();
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

/** Append a "roost-pipeline-actions" row with a Watch-source link + an optional
 *  intent-specific deep link. Both open in a new tab and stop the click from
 *  toggling the expanded card. */
function renderActionLinks(
  el: HTMLElement,
  source?: PipelineSource,
  deepLink?: { label: string; url: string; icon?: string } | null,
): void {
  const links: { label: string; url: string; icon?: string }[] = [];
  if (deepLink) links.push(deepLink);
  if (source?.url) {
    const platform = detectPlatformFromUrl(source.url);
    const label = platform === "tiktok" ? "Watch on TikTok" : platform === "twitter" ? "View on X" : "Open source";
    links.push({ label, url: source.url, icon: "↗" });
  }
  if (links.length === 0) return;
  const row = el.createDiv({ cls: "roost-pipeline-actions" });
  for (const l of links) {
    const a = row.createEl("a", { cls: "roost-pipeline-action", href: l.url, text: (l.icon ? l.icon + " " : "") + l.label });
    a.setAttr("target", "_blank");
    a.setAttr("rel", "noopener noreferrer");
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.open(l.url, "_blank", "noopener"); });
  }
}

// ── Type-specific renderers ──

function renderRecipe(el: HTMLElement, data: RecipeExtraction, source?: PipelineSource): void {
  kvRow(el, "Dish", data.dish);
  kvRow(el, "Cuisine", data.cuisine);
  kvRow(el, "Difficulty", capitalize(data.difficulty ?? ""));

  // Time row
  const times: string[] = [];
  if (data.prepTime) times.push(`Prep: ${data.prepTime}`);
  if (data.cookTime) times.push(`Cook: ${data.cookTime}`);
  if (times.length) kvRow(el, "Time", times.join(" · "));

  // Ingredients
  if (data.ingredients?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Ingredients" });
    const list = group.createEl("ul", { cls: "roost-pipeline-ingredients" });
    for (const ing of data.ingredients) {
      list.createEl("li", { text: ing });
    }
  }

  // Steps
  if (data.steps?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Steps" });
    numberedList(group, data.steps);
  }

  if (data.notes) kvRow(el, "Notes", data.notes);

  // Recipe site link from creator bio
  if (data.recipeLink) {
    const linkRow = el.createDiv({ cls: "roost-pipeline-kv" });
    linkRow.createEl("span", { cls: "roost-pipeline-kv-label", text: "Recipe site" });
    const linkEl = linkRow.createEl("a", {
      cls: "roost-pipeline-recipe-link",
      text: data.recipeLink.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      href: data.recipeLink,
    });
    linkEl.setAttr("target", "_blank");
    linkEl.setAttr("rel", "noopener");
  }

  renderActionLinks(el, source);
}

function renderPlace(el: HTMLElement, data: PlaceExtraction, source?: PipelineSource): void {
  kvRow(el, "Name", data.name);
  const location = [data.city, data.country].filter(Boolean).join(", ");
  kvRow(el, "Location", location || null);
  kvRow(el, "Type", capitalize(data.placeType ?? ""));
  kvRow(el, "Best for", data.bestFor);
  kvRow(el, "Address", data.address);

  if (data.description) {
    const desc = el.createDiv({ cls: "roost-pipeline-description" });
    desc.textContent = data.description;
  }

  if (data.vibes?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Vibes" });
    pillList(group, data.vibes);
  }

  if (data.tips?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Tips" });
    const list = group.createEl("ul", { cls: "roost-pipeline-tips" });
    for (const tip of data.tips) list.createEl("li", { text: tip });
  }

  const mapsUrl = buildMapsUrl({ lat: data.lat, lng: data.lng, address: data.address, name: data.name, city: data.city, country: data.country });
  renderActionLinks(el, source, mapsUrl ? { label: "Open in Maps", url: mapsUrl, icon: "📍" } : null);
}

function renderMedia(el: HTMLElement, data: MediaExtraction, source?: PipelineSource): void {
  kvRow(el, "Title", data.title);
  kvRow(el, "Creator", data.creator);
  kvRow(el, "Type", capitalize(data.mediaType ?? ""));
  kvRow(el, "Genre", data.genre);
  kvRow(el, "Rating", data.rating);
  kvRow(el, "Where", data.where);

  if (data.description) {
    const desc = el.createDiv({ cls: "roost-pipeline-description" });
    desc.textContent = data.description;
  }

  let mediaLink: { label: string; url: string; icon?: string } | null = null;
  const sub = (source?.subcategory ?? data.mediaType ?? "").toLowerCase();
  if (sub === "music") {
    // Canonical Spotify track link when we resolved a track id; otherwise fall
    // back to a Spotify search for the title/creator.
    if (typeof data.spotifyId === "string" && data.spotifyId) {
      mediaLink = { label: "Open in Spotify", url: `https://open.spotify.com/track/${data.spotifyId}`, icon: "🎧" };
    } else {
      const q = encodeURIComponent([data.title, data.creator].filter(Boolean).join(" "));
      if (q) mediaLink = { label: "Search on Spotify", url: `https://open.spotify.com/search/${q}`, icon: "🎧" };
    }
  } else {
    // Pass the resolved ids so watchableUrl returns a canonical Letterboxd/
    // AniList URL when possible, falling back to its search URL when not. Use
    // the plural source.subcategory (watchableUrl matches films/series/anime/
    // documentaries), not the singular data.mediaType. Series stays search even
    // with a tmdbId — Letterboxd's TMDB redirect is films-only.
    const w = watchableUrl({
      subcategory: sub,
      title: data.title,
      year: data.year ?? null,
      tmdbId: data.tmdbId ?? null,
      tmdbType: data.tmdbType ?? null,
      anilistId: data.anilistId ?? null,
    });
    if (w) mediaLink = { label: w.kind === "canonical" ? "Open" : "Find it", url: w.url, icon: "▶" };
  }
  renderActionLinks(el, source, mediaLink);
}

function renderProduct(el: HTMLElement, data: ProductExtraction, source?: PipelineSource): void {
  kvRow(el, "Name", data.name);
  kvRow(el, "Brand", data.brand);
  kvRow(el, "Type", capitalize(data.productType ?? ""));
  kvRow(el, "Price", data.price);
  kvRow(el, "Rating", data.rating);
  kvRow(el, "Where to buy", data.whereToBuy);

  if (data.description) {
    const desc = el.createDiv({ cls: "roost-pipeline-description" });
    desc.textContent = data.description;
  }

  const q = encodeURIComponent([data.brand, data.name].filter(Boolean).join(" ") + " buy");
  renderActionLinks(el, source, q ? { label: "Find where to buy", url: `https://www.google.com/search?q=${q}`, icon: "🛒" } : null);
}

function renderWorkout(el: HTMLElement, data: WorkoutExtraction, source?: PipelineSource): void {
  kvRow(el, "Name", data.name);
  kvRow(el, "Type", capitalize(data.workoutType ?? ""));
  kvRow(el, "Target", data.targetArea);
  kvRow(el, "Difficulty", capitalize(data.difficulty ?? ""));
  kvRow(el, "Duration", data.duration);

  if (data.equipment?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Equipment" });
    pillList(group, data.equipment);
  }

  if (data.exercises?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Exercises" });
    const list = group.createEl("ul", { cls: "roost-pipeline-exercises" });
    for (const ex of data.exercises) {
      list.createEl("li", { text: ex });
    }
  }

  if (data.notes) kvRow(el, "Notes", data.notes);

  renderActionLinks(el, source);
}

function renderTutorial(el: HTMLElement, data: TutorialExtraction, source?: PipelineSource): void {
  kvRow(el, "Topic", data.topic);
  kvRow(el, "Skill area", capitalize(data.skillArea ?? ""));
  kvRow(el, "Difficulty", capitalize(data.difficulty ?? ""));
  kvRow(el, "Time", data.timeEstimate);

  if (data.description) {
    const desc = el.createDiv({ cls: "roost-pipeline-description" });
    desc.textContent = data.description;
  }

  if (data.tools?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Tools" });
    pillList(group, data.tools);
  }

  if (data.steps?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Steps" });
    numberedList(group, data.steps);
  }

  renderActionLinks(el, source);
}

function renderHome(el: HTMLElement, data: HomeExtraction, source?: PipelineSource): void {
  kvRow(el, "Title", data.title);
  kvRow(el, "Room", capitalize(data.room ?? ""));
  kvRow(el, "Type", capitalize(data.ideaType ?? ""));
  kvRow(el, "Style", data.style);
  kvRow(el, "Budget", data.budget);

  if (data.description) {
    const desc = el.createDiv({ cls: "roost-pipeline-description" });
    desc.textContent = data.description;
  }

  if (data.products?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Products" });
    pillList(group, data.products);
  }

  if (data.tips?.length) {
    const group = el.createDiv({ cls: "roost-pipeline-group" });
    group.createDiv({ cls: "roost-pipeline-group-label", text: "Tips" });
    const list = group.createEl("ul", { cls: "roost-pipeline-tips" });
    for (const tip of data.tips) list.createEl("li", { text: tip });
  }

  renderActionLinks(el, source);
}
