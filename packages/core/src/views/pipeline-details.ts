/**
 * Pipeline extraction overlays and expanded detail sections for the gallery.
 *
 * Loads all pipeline caches once, provides:
 *   - getPipelineData(roostId) → type + extraction or null
 *   - renderPipelineOverlay(coverEl, type) → small themed icon on compact card
 *   - renderPipelineDetail(infoEl, type, extraction) → rich section in expanded card
 */
import { App } from "obsidian";
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
        pipelineLookup.set(id, { type, extraction: entry.extraction });
      }
    }
  }
}

export function getPipelineData(roostId: string): PipelineHit | null {
  return pipelineLookup?.get(roostId) ?? null;
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

export function renderPipelineDetail(infoEl: HTMLElement, hit: PipelineHit): void {
  const meta = PIPELINE_META[hit.type];
  const section = infoEl.createDiv({ cls: "roost-pipeline-section" });
  section.style.setProperty("--pipeline-color", meta.color);
  section.dataset.pipelineType = hit.type;

  // Delegate to type-specific renderer.
  // hit.type and hit.extraction are separate fields so TypeScript can't narrow
  // extraction automatically — we cast to the specific type in each branch.
  const content = section.createDiv({ cls: "roost-pipeline-section-content" });
  switch (hit.type) {
    case "recipe":   renderRecipe(content, hit.extraction as RecipeExtraction); break;
    case "place":    renderPlace(content, hit.extraction as PlaceExtraction); break;
    case "media":    renderMedia(content, hit.extraction as MediaExtraction); break;
    case "product":  renderProduct(content, hit.extraction as ProductExtraction); break;
    case "workout":  renderWorkout(content, hit.extraction as WorkoutExtraction); break;
    case "tutorial": renderTutorial(content, hit.extraction as TutorialExtraction); break;
    case "home":     renderHome(content, hit.extraction as HomeExtraction); break;
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

// ── Compact card chips ──

/** Return a short chip string for compact cards, e.g. "Italian · 30min · Easy" */
export function getCompactChips(hit: PipelineHit): string | null {
  // hit.type and hit.extraction are separate fields so TypeScript can't narrow
  // the extraction union automatically — we cast to the specific type in each branch.
  let parts: (string | null | undefined)[];
  switch (hit.type) {
    case "recipe": {
      const d = hit.extraction as RecipeExtraction;
      parts = [d.cuisine, d.cookTime, d.difficulty ? capitalize(d.difficulty) : null];
      break;
    }
    case "place": {
      const d = hit.extraction as PlaceExtraction;
      return [d.city, d.country].filter(Boolean).join(", ") || null;
    }
    case "media": {
      const d = hit.extraction as MediaExtraction;
      parts = [d.where, d.genre];
      break;
    }
    case "product": {
      const d = hit.extraction as ProductExtraction;
      parts = [d.price, d.whereToBuy];
      break;
    }
    case "workout": {
      const d = hit.extraction as WorkoutExtraction;
      parts = [d.targetArea, d.difficulty ? capitalize(d.difficulty) : null];
      break;
    }
    case "tutorial": {
      const d = hit.extraction as TutorialExtraction;
      parts = [d.skillArea ? capitalize(d.skillArea) : null, d.timeEstimate];
      break;
    }
    case "home": {
      const d = hit.extraction as HomeExtraction;
      parts = [d.room ? capitalize(d.room) : null, d.style];
      break;
    }
    default:
      return null;
  }
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length > 0 ? filtered.join(" · ") : null;
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
  const ol = parent.createEl("ol", { cls: "roost-pipeline-steps" });
  for (const step of items) {
    ol.createEl("li", { text: step });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");
}

// ── Type-specific renderers ──

function renderRecipe(el: HTMLElement, data: RecipeExtraction): void {
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
      const text = ing.qty ? `${ing.qty} ${ing.item}` : ing.item;
      list.createEl("li", { text });
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
}

function renderPlace(el: HTMLElement, data: PlaceExtraction): void {
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
}

function renderMedia(el: HTMLElement, data: MediaExtraction): void {
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
}

function renderProduct(el: HTMLElement, data: ProductExtraction): void {
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
}

function renderWorkout(el: HTMLElement, data: WorkoutExtraction): void {
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
      const text = ex.reps ? `${ex.name} — ${ex.reps}` : ex.name;
      list.createEl("li", { text });
    }
  }

  if (data.notes) kvRow(el, "Notes", data.notes);
}

function renderTutorial(el: HTMLElement, data: TutorialExtraction): void {
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
}

function renderHome(el: HTMLElement, data: HomeExtraction): void {
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
}
