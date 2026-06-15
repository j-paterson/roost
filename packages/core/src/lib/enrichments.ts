/**
 * Enrichment registry — the central system that describes every per-item
 * backfill capability the plugin ships. Each EnrichmentDef binds:
 *   - the scanIncompleteIds bucket whose items it backfills
 *   - a display label for health-panel rows
 *   - a schema version so stale items get flagged when the schema bumps
 *   - an Obsidian command id + Cmd+P name
 *   - a backfill driver that owns its own cache file and resumability
 *
 * Adding a new enrichment (e.g. transcripts via Whisper, embedded-tweet
 * expansion, pinned-comment fetch) is one new entry in ENRICHMENTS — no
 * sync-pipeline changes required. main.ts iterates the registry to register
 * Cmd+P commands; the hub iterates it to render per-platform backlog rows.
 *
 * The "rawJson" bucket is intentionally NOT in the registry: items missing
 * their raw.json sidecar are only recoverable via a full re-sync (we don't
 * have the source data without it), so there's no standalone backfill.
 */
import type { IRoostPlugin } from "@/types/plugin";
import type { IncompleteByCategory } from "@/sync/vault-writer";

/** Subset of byCategory keys that have backfill commands. raw-json items
 *  need full re-sync — handled by the sync flow, not the registry. */
export type EnrichmentId =
  | "articleBody" | "thread" | "mediaFiles" | "playback" | "tweetBody" | "transcript"  // data backfills
  | "recipe" | "place" | "mediaExtraction" | "product"        // pipelines
  | "workout" | "tutorial" | "home";

export interface ChipDeclaration {
  field: string;
  kind: "time" | "difficulty" | "location" | "where" | "price" | "rating" | "tag";
  hideWhen?: "empty" | "null";
}

export interface BackfillOpts {
  filter?: { category: string; subcategory?: string };
  signal?: AbortSignal;
  onLog?: (msg: string) => void;
}

export interface EnrichmentDef {
  /** Stable id; matches scanIncompleteIds byCategory key. */
  id: EnrichmentId;
  /** Human label used in health-panel rows + log breakdowns. */
  displayName: string;
  /** Bumped when the detection predicate or output shape changes. Compared
   *  against each note's `enrichment_v_<id>` frontmatter field to invalidate
   *  stale items so they re-flow through the bucket on next scan. */
  schemaVersion: number;
  /** Obsidian command id (e.g. "backfill-x-articles"). The full command id
   *  registered with Obsidian is `roost:${commandId}` — main.ts handles the
   *  prefix when calling addCommand. */
  commandId: string;
  /** Cmd+P display name. */
  commandName: string;
  /** Backfill driver. Owns its own cache file + resumable runs.
   *  Throwing is fine — main.ts catches and surfaces via Notice. */
  runBackfill: (plugin: IRoostPlugin, opts?: BackfillOpts) => Promise<void>;
  /** One-line copy shown under the health-panel row when this bucket has
   *  pending items. */
  panelDetail: string;
  /** Category slugs (roost_category values) this enrichment applies to.
   *  Undefined means "all categories". */
  categoryMatches?: string[];
  /** Frontmatter field names this enrichment writes (besides enrichment_v_<id>). */
  fieldsWritten?: string[];
  /** Old frontmatter version-field names from before this enrichment was
   *  folded into the registry. Used by isVersionStale during the migration
   *  window so stale items are detected even if they only have the old field. */
  legacyAliases?: string[];
  /** Chip declarations for gallery display. */
  chips?: ChipDeclaration[];
}

// Per-enrichment defs are colocated with their runner+cache files so each
// enrichment is fully self-contained. The registry just collects them here.
import { ARTICLE_BODY_ENRICHMENT } from "@/sync/article-backfill";
import { THREAD_ENRICHMENT } from "@/sync/thread-backfill";
import { RENDERED_TWEET_ENRICHMENT } from "@/sync/tweet-body-backfill";
import { MEDIA_ENRICHMENT } from "@/sync/media-backfill";
import { TRANSCRIPT_ENRICHMENT } from "@/sync/transcript-backfill";
import { PLAYBACK_ENRICHMENT } from "@/pipeline/playback-enrichment";
import { RECIPE_ENRICHMENT } from "@/pipeline/recipe-pipeline";
import { PLACE_ENRICHMENT } from "@/pipeline/places-pipeline";
import { MEDIA_EXTRACTION_ENRICHMENT } from "@/pipeline/media-pipeline";
import { PRODUCT_ENRICHMENT } from "@/pipeline/products-pipeline";
import { WORKOUT_ENRICHMENT } from "@/pipeline/workouts-pipeline";
import { TUTORIAL_ENRICHMENT } from "@/pipeline/tutorials-pipeline";
import { HOME_ENRICHMENT } from "@/pipeline/home-pipeline";

/** All registered enrichments. Order is the order they render in the
 *  health panel. */
export const ENRICHMENTS: readonly EnrichmentDef[] = [
  ARTICLE_BODY_ENRICHMENT,
  THREAD_ENRICHMENT,
  RENDERED_TWEET_ENRICHMENT,
  MEDIA_ENRICHMENT,
  TRANSCRIPT_ENRICHMENT,
  PLAYBACK_ENRICHMENT,
  RECIPE_ENRICHMENT,
  PLACE_ENRICHMENT,
  MEDIA_EXTRACTION_ENRICHMENT,
  PRODUCT_ENRICHMENT,
  WORKOUT_ENRICHMENT,
  TUTORIAL_ENRICHMENT,
  HOME_ENRICHMENT,
] as const;

/** Category extraction pipelines (LLM-gated toggles in settings.pipelines). */
export const PIPELINE_ENRICHMENTS = ENRICHMENTS.filter(
  (e): e is EnrichmentDef & { categoryMatches: readonly string[] } =>
    (e.categoryMatches?.length ?? 0) > 0,
);

export const PIPELINE_ENRICHMENT_IDS = PIPELINE_ENRICHMENTS.map((e) => e.id);

export type PipelineId = (typeof PIPELINE_ENRICHMENTS)[number]["id"];

export function isPipelineEnrichmentId(id: string): id is PipelineId {
  return (PIPELINE_ENRICHMENT_IDS as readonly string[]).includes(id);
}

/** Normalized result shape returned by pipeline run adapters.
 *  Surfaced inline in library-tree rows after a pipeline completes. */
export interface PipelineRunResult {
  processed: number;
  written: number;
  skipped: number;
  errors: number;
}

/** Look up by id. Returns undefined if no enrichment is registered for that
 *  bucket (e.g. "rawJson", which doesn't have a backfill command). */
export function getEnrichmentById(id: string): EnrichmentDef | undefined {
  return ENRICHMENTS.find(e => e.id === id);
}

/** Lowercased set of all category names tied to any enrichment that declares
 *  categoryMatches. Used to quickly decide if a category has a corresponding
 *  extraction pipeline. */
export function getPipelineCategoryNames(): Set<string> {
  const s = new Set<string>();
  for (const e of ENRICHMENTS) {
    if (!e.categoryMatches) continue;
    for (const c of e.categoryMatches) s.add(c.toLowerCase());
  }
  return s;
}

/** Find the enrichment that handles a given category name (case-insensitive).
 *  Returns null when no pipeline-enrichment covers that category. */
export function getEnrichmentForCategory(categoryName: string): EnrichmentDef | null {
  const target = categoryName.toLowerCase();
  for (const e of ENRICHMENTS) {
    if (!e.categoryMatches) continue;
    if (e.categoryMatches.some(c => c.toLowerCase() === target)) return e;
  }
  return null;
}

/** Subset of byCategory keys that map 1:1 to a data-backfill bucket.
 *  Pipeline ids ("recipe", "product", etc.) live in EnrichmentId but NOT
 *  in IncompleteByCategory, so countFor only accepts the overlap. */
type ByCategId = keyof IncompleteByCategory;

/** Pull the count for an enrichment from a byCategory breakdown. */
export function countFor(
  id: ByCategId,
  byCategory: IncompleteByCategory | null | undefined,
): number {
  if (!byCategory) return 0;
  return byCategory[id].size;
}

/** Frontmatter field name for an enrichment's stored schema version. Each
 *  successful backfill stamps this field on the note so a future
 *  schemaVersion bump automatically flags the item for re-enrichment.
 *  Flat per-id field (rather than a nested object) because FrontmatterValue
 *  doesn't support nested records and flat fields are first-class in
 *  Obsidian's metadataCache. */
export function enrichmentVersionField(id: EnrichmentId): string {
  return `enrichment_v_${id}`;
}

/** True when the stored version (if any) is strictly less than the current
 *  schemaVersion — i.e., a schema bump has happened since this item was
 *  last enriched. A missing version field returns false: legacy items
 *  (pre-Phase-3) are not auto-flagged for re-enrichment, only items that
 *  explicitly recorded a now-outdated version. The data-based predicates
 *  (no content_state, no thread.json, etc.) remain authoritative for the
 *  "is this enrichment present at all" question.
 *
 *  The optional `legacyAliases` param lists old frontmatter field names that
 *  stored a version number before the enrichment was registered under its
 *  canonical `enrichment_v_<id>` field. When the canonical field is absent,
 *  the first matching alias is used instead. */
export function isVersionStale(
  id: EnrichmentId,
  fm: Record<string, unknown> | undefined,
  currentSchemaVersion: number,
  legacyAliases?: string[],
): boolean {
  if (!fm) return false;
  const canonical = fm[enrichmentVersionField(id)];
  if (typeof canonical === "number") return canonical < currentSchemaVersion;
  if (legacyAliases) {
    for (const aliasField of legacyAliases) {
      const v = fm[aliasField];
      if (typeof v === "number") return v < currentSchemaVersion;
    }
  }
  return false;
}
