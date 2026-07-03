/**
 * Products & Gear extraction pipeline — finds product review/recommendation
 * bookmarks, triages them, extracts structured product data, and writes
 * product_* fields onto the source bookmark's frontmatter.
 *
 * Data sources per item (in priority order):
 * 1. raw.json `videoSuggestWordsList` — TikTok entity extraction (often has product names)
 * 2. raw.json `contents` — structured line-by-line description
 * 3. frontmatter `title` — flattened caption
 * 4. frontmatter `subtitle` — speech-to-text transcript
 * 5. embedding cache `vision` — LLM description of video frames
 * 6. raw.json `challenges` — hashtags (amazonfinds, tiktokmademebuyit, etc.)
 */
import { App, TFile } from "obsidian";
import { buildFileIndex, stripWikilink } from "@/lib/vault-utils";
import { updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import {
  loadEmbeddingCache,
  ollamaGenerate,
  readRawJson,
  extractDescription,
  loadPipelineCache,
  savePipelineCache,
} from "@/pipeline/shared";
import {
  runCategoryPipeline,
  type CategoryPipelineConfig,
} from "@/pipeline/run-category-pipeline";

// ── Types ──

type ProductCategory =
  | "tech" | "fashion" | "beauty" | "kitchen" | "fitness"
  | "home" | "outdoor" | "office" | "kids" | "other";

const PRODUCT_CATEGORY_VALUES: readonly ProductCategory[] = [
  "tech", "fashion", "beauty", "kitchen", "fitness", "home", "outdoor", "office", "kids", "other",
];

/** Narrow an arbitrary frontmatter value to a ProductCategory, defaulting to
 *  "other" for missing/unknown values (the union's catch-all). */
function asProductCategory(v: unknown): ProductCategory {
  return typeof v === "string" && (PRODUCT_CATEGORY_VALUES as readonly string[]).includes(v)
    ? (v as ProductCategory)
    : "other";
}

interface ProductExtraction {
  productType: ProductCategory;
  name: string;
  brand: string;
  price: string | null;
  rating: string | null;
  whereToBuy: string | null;
  description: string;
}

interface CacheEntry {
  triage: "product" | "skip";
  extraction: ProductExtraction | null;
}

interface ProductCandidate {
  roostId: string;
  file: TFile;
  title: string;
  subtitle: string;
  description: string;
  vision: string;
  tags: string[];
  author: string;
  authorHandle: string;
  url: string;
  suggestWords: string[];
}

// ── Constants ──

const FAST_PATH_TAGS = new Set([
  "unboxing", "haul", "amazonfinds", "tiktokmademebuyit",
  "productreview", "amazonmusthaves", "techreview",
]);

const VALID_PRODUCT_TYPES = new Set<ProductCategory>([
  "tech", "fashion", "beauty", "kitchen", "fitness",
  "home", "outdoor", "office", "kids", "other",
]);

const CACHE_FILE = "products-cache.json";
const CONCURRENCY = 3;

const PRODUCT_PIPELINE_VERSION = 1;

/** roost_category / roost_subcategory values the products pipeline owns. A note
 *  the user (or Smart-Assign) filed under one of these enters triage even if
 *  its embedding category/tags don't match. Mirrors recipe's FILED_RECIPE_CATEGORIES
 *  (plan 032); the string list MUST stay in sync with PRODUCT_ENRICHMENT.categoryMatches.
 *  Exported for the sync test that guards it against categoryMatches. */
export const FILED_PRODUCT_CATEGORIES = new Set(["product", "products", "gear", "shopping"]);

const PRODUCT_FIELDS = {
  name: "product_name",
  brand: "product_brand",
  type: "product_type",
  price: "product_price",
  rating: "product_rating",
  whereToBuy: "product_where_to_buy",
  description: "product_description",
  version: "enrichment_v_product",
} as const;

// ── Helpers ──

function extractSuggestWords(raw: any): string[] {
  const structs = raw?.videoSuggestWordsList?.video_suggest_words_struct;
  if (!Array.isArray(structs)) return [];
  const words: string[] = [];
  for (const s of structs) {
    for (const w of (s.words || [])) {
      if (w.word) words.push(w.word);
    }
  }
  return words;
}

function normalizeProductType(raw: string): ProductCategory {
  const lower = (raw || "").toLowerCase().trim();
  if (VALID_PRODUCT_TYPES.has(lower as ProductCategory)) return lower as ProductCategory;
  if (lower === "technology" || lower === "gadget" || lower === "electronics") return "tech";
  if (lower === "clothing" || lower === "style" || lower === "accessories") return "fashion";
  if (lower === "skincare" || lower === "makeup" || lower === "cosmetics") return "beauty";
  if (lower === "cooking" || lower === "food") return "kitchen";
  if (lower === "gym" || lower === "workout" || lower === "sports") return "fitness";
  if (lower === "garden" || lower === "camping" || lower === "hiking") return "outdoor";
  if (lower === "desk" || lower === "workspace" || lower === "stationery") return "office";
  if (lower === "baby" || lower === "toddler" || lower === "toys") return "kids";
  return "other";
}

function hasProductFastPath(tags: string[]): boolean {
  return tags.some(t => {
    const cleaned = t.toLowerCase().replace(/^#/, "");
    return FAST_PATH_TAGS.has(cleaned);
  });
}

// ── Candidate gathering ──

/** Id-only predicate — returns the set of roostIds that are product candidates.
 *  No readRawJson call, so this is cheap enough to use in the pending-pipeline scan. */
export function gatherProductCandidateIds(app: App, syncFolder: string): Set<string> {
  const fileIndex = buildFileIndex(app, syncFolder);
  const ids = new Set<string>();
  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const filedCat = String(fm[CATEGORY_FIELD] ?? "").toLowerCase();
    const filedSub = String(fm[SUBCATEGORY_FIELD] ?? "").toLowerCase();
    const filedMatch = FILED_PRODUCT_CATEGORIES.has(filedCat) || FILED_PRODUCT_CATEGORIES.has(filedSub);
    if (filedMatch) ids.add(roostId);
  }
  return ids;
}

function gatherCandidates(app: App, syncFolder: string): ProductCandidate[] {
  const ids = gatherProductCandidateIds(app, syncFolder);
  const fileIndex = buildFileIndex(app, syncFolder);
  const embeddingCache = loadEmbeddingCache(app.vault);
  const candidates: ProductCandidate[] = [];

  for (const roostId of ids) {
    const file = fileIndex.get(roostId);
    if (!file) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const embedded = embeddingCache[roostId];
    const fmTags: string[] = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).map(t => String(t).toLowerCase())
      : [];

    const raw = readRawJson(app.vault, syncFolder, roostId);
    const description = extractDescription(raw);
    const suggestWords = extractSuggestWords(raw);
    // raw is typed as Record<string, unknown> | null; cast inline at the
    // boundaries to TikTok's raw.json shape.
    const challenges = (raw?.challenges as Array<{title?: string}> | undefined) ?? [];
    const hashtags: string[] = challenges
      .map(c => c.title)
      .filter((t): t is string => Boolean(t));
    const rawAuthor = raw?.author as { uniqueId?: string } | undefined;

    candidates.push({
      roostId,
      file,
      title: fm.title || "",
      subtitle: fm.subtitle || "",
      description,
      vision: embedded?.vision || "",
      tags: [...new Set([...hashtags, ...fmTags])],
      author: fm.author ? stripWikilink(fm.author) : "",
      authorHandle: rawAuthor?.uniqueId || "",
      url: fm.url || "",
      suggestWords,
    });
  }

  return candidates;
}

// ── Triage ──

function buildTriagePrompt(c: ProductCandidate): string {
  const text = (c.description || c.title).slice(0, 1500);
  const transcript = c.subtitle ? c.subtitle.slice(0, 800) : "No transcript.";
  const visual = c.vision ? c.vision.slice(0, 300) : "No description.";
  const tags = c.tags.slice(0, 15).join(", ");
  const suggest = c.suggestWords.length > 0
    ? `\nSearch suggestions: ${c.suggestWords.slice(0, 5).join(", ")}`
    : "";

  return `You are classifying a social media bookmark.

Caption: ${text}
Transcript: ${transcript}
Visual: ${visual}
Hashtags: ${tags}${suggest}

Is this a REVIEW or RECOMMENDATION of a specific purchasable product — naming or clearly showing a specific item you can buy?

Or is it general lifestyle/entertainment content NOT about a specific product?

Respond with ONLY one word: product or skip`;
}

async function triageItem(c: ProductCandidate): Promise<"product" | "skip"> {
  const raw = await ollamaGenerate(buildTriagePrompt(c), { numPredict: 5, numCtx: 2048 });
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word.includes("skip")) return "skip";
  return "product";
}

// ── Extraction ──

function buildExtractPrompt(c: ProductCandidate): string {
  const sections: string[] = [];

  if (c.suggestWords.length > 0) {
    sections.push(`TikTok search suggestions (often contain product names): ${c.suggestWords.slice(0, 8).join(", ")}`);
  }

  if (c.description) {
    sections.push(`Description:\n${c.description.slice(0, 1500)}`);
  } else if (c.title) {
    sections.push(`Caption: ${c.title.slice(0, 1500)}`);
  }

  if (c.subtitle) {
    sections.push(`Video transcript: ${c.subtitle.slice(0, 800)}`);
  }

  if (c.vision) {
    sections.push(`Visual description: ${c.vision.slice(0, 400)}`);
  }

  if (c.tags.length > 0) {
    sections.push(`Tags: ${c.tags.slice(0, 15).join(", ")}`);
  }

  return `Extract the product recommendation from this social media video.
Identify the specific product being reviewed or recommended.
If multiple products are shown, extract the MAIN one (most prominently featured).

${sections.join("\n\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "productType": "tech|fashion|beauty|kitchen|fitness|home|outdoor|office|kids|other",
  "name": "specific product name",
  "brand": "brand or manufacturer name",
  "price": "price if mentioned (e.g. '$29.99', '£15') or null",
  "rating": "any rating or opinion (e.g. '10/10', 'game changer', 'must buy') or null",
  "whereToBuy": "where to purchase (e.g. Amazon, Target, brand website) or null",
  "description": "1-2 sentence summary of what the product does and why it was recommended"
}`;
}

async function extractProduct(c: ProductCandidate): Promise<ProductExtraction | null> {
  const raw = await ollamaGenerate(buildExtractPrompt(c), { numPredict: 1024, numCtx: 3072 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    const name = parsed.name || "";
    if (!name || name.toLowerCase() === "unknown") return null;

    return {
      productType: normalizeProductType(parsed.productType),
      name,
      brand: parsed.brand || "Unknown",
      price: parsed.price && parsed.price !== "null" ? parsed.price : null,
      rating: parsed.rating && parsed.rating !== "null" ? parsed.rating : null,
      whereToBuy: parsed.whereToBuy && parsed.whereToBuy !== "null" ? parsed.whereToBuy : null,
      description: parsed.description || "",
    };
  } catch {
    console.warn(`[roost] products: failed to parse extraction for ${c.roostId}:`, cleaned.slice(0, 200));
    return null;
  }
}

// ── Frontmatter write helpers ──

export function computeProductBackfillFields(
  extraction: ProductExtraction,
  existingFm: Record<string, unknown>,
): Record<string, FrontmatterValue> {
  const updates: Record<string, FrontmatterValue> = {};
  updates[PRODUCT_FIELDS.name] = extraction.name;
  updates[PRODUCT_FIELDS.brand] = extraction.brand;
  updates[PRODUCT_FIELDS.type] = extraction.productType;
  updates[PRODUCT_FIELDS.price] = extraction.price;
  updates[PRODUCT_FIELDS.rating] = extraction.rating;
  updates[PRODUCT_FIELDS.whereToBuy] = extraction.whereToBuy;
  updates[PRODUCT_FIELDS.description] = extraction.description || null;
  updates[PRODUCT_FIELDS.version] = PRODUCT_PIPELINE_VERSION;

  // Subcategory backfill rule
  const existingCategory = typeof existingFm[CATEGORY_FIELD] === "string"
    ? existingFm[CATEGORY_FIELD] as string : null;
  const existingSubcategory = typeof existingFm[SUBCATEGORY_FIELD] === "string"
    ? existingFm[SUBCATEGORY_FIELD] as string : null;
  if (!existingSubcategory) {
    const matchesPipeline = existingCategory
      && ["Product", "Products", "Gear", "Shopping"].some(
        c => c.toLowerCase() === existingCategory.toLowerCase()
      );
    if (matchesPipeline) {
      updates[SUBCATEGORY_FIELD] = extraction.productType;
    }
  }
  return updates;
}

async function writeProductToBookmark(
  app: App,
  file: TFile,
  extraction: ProductExtraction,
): Promise<void> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const updates = computeProductBackfillFields(extraction, fm);
  const content = await app.vault.read(file);
  const updated = updateNoteFrontmatter(content, updates);
  if (updated !== null) {
    await app.vault.modify(file, updated);
  }
}

// ── Main pipeline ──

interface ProductsPipelineResult {
  candidates: number;
  products: number;
  skipped: number;
  errors: number;
}

/**
 * Products wiring for the generic {@link runCategoryPipeline}. Data behavior
 * (cache entries, frontmatter writes, result counts) reproduces the prior
 * inline loop exactly; log strings drift to the runner's shape (approved).
 * The tag fast-path and the demote-on-failure policies carry over verbatim.
 */
const PRODUCTS_CONFIG: CategoryPipelineConfig<
  ProductCandidate,
  ProductExtraction,
  "product" | "skip",
  ProductsPipelineResult
> = {
  cacheFile: CACHE_FILE,
  concurrency: CONCURRENCY,
  extractVerdict: "product",
  skipVerdict: "skip",
  onExtractFailure: "demote",
  onTriageFailure: "skip",
  gatherCandidates,
  fastPathTriage: c => (hasProductFastPath(c.tags) ? "product" : null),
  triageItem,
  extractItem: extractProduct,
  onExtractError: (roostId, err) =>
    console.warn(`[roost] products: extraction error for ${roostId}:`, err),
  writeToBookmark: (app, c, ex) => writeProductToBookmark(app, c.file, ex),
  storeExtractionInCache: false,
  buildResult: (candidates, cache, errors) => ({
    candidates: candidates.length,
    products: candidates.filter(
      c => cache[c.roostId]?.triage === "product" && ((cache[c.roostId] as any)?.extracted === true || !!cache[c.roostId]?.extraction),
    ).length,
    skipped: candidates.filter(c => cache[c.roostId]?.triage === "skip").length,
    errors,
  }),
  log: {
    candidatesFound: n => `Found ${n} product candidates`,
    triageExtractCounts: (uncached, needExtract, complete) =>
      `${uncached} need triage, ${needExtract} need extraction (${complete} complete)`,
    fastPath: n => `Tag fast-path: ${n} items auto-triaged as product`,
    triageProgress: (done, total) => `Triaged ${done}/${total}`,
    wroteCached: n => `Wrote ${n} cached products`,
    extracting: n => `Extracting ${n} products...`,
    extractProgress: (done, total) => `Extracted ${done}/${total}`,
    done: r => `Done: ${r.products} products, ${r.skipped} skipped, ${r.errors} errors`,
  },
};

export async function runProductsPipeline(
  app: App,
  syncFolder: string,
  onLog?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<ProductsPipelineResult> {
  return runCategoryPipeline(app, syncFolder, PRODUCTS_CONFIG, onLog, signal);
}

// ─── Cache reconstruction ─────────────────────────────────────────────────────

/** Rebuild the products pipeline cache from source-bookmark frontmatter.
 *  Scans Bookmarks/ for notes with enrichment_v_product set, reads the
 *  product_* fields, and returns a cache record keyed by roost_id. */
export function reconstructProductsCache(
  app: App,
): Record<string, { triage: "product"; extraction: null; extracted: true }> {
  const out: Record<string, { triage: "product"; extraction: null; extracted: true }> = {};
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith("Bookmarks/")) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || typeof fm.enrichment_v_product !== "number") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    out[id] = { triage: "product", extraction: null, extracted: true };
  }
  return out;
}

// ─── Enrichment registry entry ────────────────────────────────────────────────
import type { EnrichmentDef } from "@/lib/enrichments";

export const PRODUCT_ENRICHMENT: EnrichmentDef = {
  id: "product",
  displayName: "Products & Gear",
  schemaVersion: 1,
  commandId: "run-products-pipeline",
  commandName: "Run Products extraction pipeline",
  cacheFile: CACHE_FILE,
  gatherCandidateIds: gatherProductCandidateIds,
  pendingExtractVerdict: "product",
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) {
      const reconstructed = reconstructProductsCache(plugin.app);
      if (Object.keys(reconstructed).length > 0) {
        savePipelineCache(vault, CACHE_FILE, reconstructed);
      }
    }
    await runProductsPipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog, opts?.signal);
  },
  panelDetail: "Extract product names, brands, prices, and where-to-buy links. Writes product_* fields onto each source bookmark.",
  categoryMatches: ["Product", "Products", "Gear", "Shopping"],
  fieldsWritten: ["product_name", "product_brand", "product_type", "product_price", "product_rating", "product_where_to_buy", "product_description"],
  chips: [
    { field: "product_price", kind: "price" },
    { field: "product_brand", kind: "tag" },
  ],
};
