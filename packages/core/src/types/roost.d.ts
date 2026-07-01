// Type definitions for the Smart Assign pipeline
// Matches roost-app/src/ui/src/types/roost.d.ts

export interface ClassifySample {
  id?: string;
  name?: string;
  summary?: string;
  thumbnail?: string | null;
}

export interface ClassifyProposal {
  suggestedName: string;
  altNames: string[];
  count: number;
  itemIds: string[];
  certainItemIds?: string[];
  uncertainItemIds?: string[];
  samples: ClassifySample[];
  confidence?: number;
  source?: "centroid" | "cluster" | "collection";
  fromCollection?: boolean;
}

export interface SplitTreeNode {
  id: number | string;
  itemIds: string[];
  name: { suggestedName: string; altNames: string[]; fromCollection?: boolean };
  samples: ClassifySample[];
  cohesion: number;
  children: [SplitTreeNode, SplitTreeNode] | null;
}

export interface ClassifyProposalData {
  proposals: ClassifyProposal[];
  collections?: Record<string, string[]>;
  platform: string;
  noiseItemIds: string[];
  /** Items assigned by k-means but not confirmed by HDBSCAN */
  uncertainItemIds?: string[];
  unsortedIds?: string[];
  splitTree?: SplitTreeNode;
}

export interface LibraryFolder {
  name: string;
  source: "collection" | "smart-assign" | "manual" | "imported";
  parent: string | null;
}

export interface LibraryState {
  folders: Record<string, LibraryFolder>;
  assignments: Record<string, string>;
  unassigned: string[];
  lastExport: string | null;
}

export type PipelineStatus = "idle" | "running" | "done" | "error";

export interface EmbeddingCacheEntry {
  vision: string | null;
  summary: string | null;
  category: string | null;
  vec: number[] | null;
  vecText: number[] | null;
  vecVersion?: number | null;
  clipVec?: number[] | null;
}

// ── Pipeline extraction types ──
// Mirrored here so pipeline-details.ts and gallery views can reference
// proper types without importing from the individual pipeline modules.

export interface RecipeIngredient { item: string; qty: string | null; }
export interface RecipeExtraction {
  dish: string; cuisine: string; ingredients: string[];
  steps: string[]; prepTime: string | null; cookTime: string | null;
  difficulty: "easy" | "medium" | "hard"; notes: string | null; recipeLink: string | null;
}

export interface PlaceExtraction {
  name: string; city: string; country: string;
  placeType: string; description: string; vibes: string[];
  bestFor: string; tips: string[]; address: string | null;
  /** TikTok POI numeric ID when present; null for LLM-only extractions. */
  cityCode?: string | null;
  /** Resolved coordinates. When non-null, buildMapPins uses these directly
   *  instead of the hardcoded CITY_COORDS/COUNTRY_COORDS tables. */
  lat?: number | null;
  lng?: number | null;
  /** True when coords came from a Nominatim POI-level match (venue, landmark,
   *  or street address) — i.e. the pin points at the actual place, not the
   *  city centroid. Map rendering uses this to suppress per-pin jitter. */
  isExact?: boolean;
}

export interface MediaExtraction {
  mediaType: string; title: string; creator: string;
  genre: string; description: string; rating: string | null; where: string | null;
  // Resolved canonical deep-link ids (carried from the pipeline cache /
  // frontmatter so the gallery card can build canonical links, not just search).
  spotifyId?: string | null;
  tmdbId?: string | null;
  tmdbType?: "movie" | "tv" | null;
  anilistId?: string | null;
  year?: number | null;
}

export interface ProductExtraction {
  productType: string; name: string; brand: string;
  price: string | null; rating: string | null; whereToBuy: string | null; description: string;
}

export interface WorkoutExtraction {
  workoutType: string; name: string; targetArea: string;
  exercises: string[];
  duration: string | null; difficulty: "beginner" | "intermediate" | "advanced";
  equipment: string[]; notes: string | null;
}

export interface TutorialExtraction {
  skillArea: string; topic: string; description: string;
  steps: string[]; difficulty: "beginner" | "intermediate" | "advanced";
  tools: string[]; timeEstimate: string | null;
}

export interface HomeExtraction {
  room: string; ideaType: string; title: string;
  description: string; products: string[]; style: string;
  budget: string | null; tips: string[];
}

/** Union of all pipeline extraction objects */
export type AnyExtractionData =
  | RecipeExtraction | PlaceExtraction | MediaExtraction
  | ProductExtraction | WorkoutExtraction | TutorialExtraction | HomeExtraction;

/**
 * Generic pipeline cache entry — the on-disk shape shared by recipe, places,
 * workouts, tutorials, media, products, and home pipeline caches.
 * Each pipeline narrows the triage and extraction fields with its own types;
 * this generic version is used where the exact extraction shape doesn't matter
 * (e.g. gallery headers, pipeline-details overlay loader).
 *
 * For slim pipelines (recipe, products, workouts, tutorials, home) the
 * extraction payload is NOT stored in the cache — instead `extracted: true`
 * is set after a successful extraction to prevent re-extraction on the next run.
 * The payload lives in frontmatter (the source of truth).
 */
export interface PipelineCacheEntry {
  triage: string;
  extraction: AnyExtractionData | null;
  /** Set to true for slim-cache pipelines after a successful extraction.
   *  When true, the entry is considered done even though extraction is null. */
  extracted?: boolean;
}

/** A single entry in the gallery folder tree */
export interface FolderView {
  name: string;
  count: number;
  itemIds: string[];
  cohesion?: number;
  /** Optional stable id used by Smart Assign proposals; falls back to name. */
  id?: string;
}

/**
 * Per-item scoring detail returned by the evaluate pipeline.
 * Defined here (rather than pipeline/evaluate.ts) so RoostFilter can
 * reference it without creating a types/roost ↔ pipeline/evaluate cycle.
 */
export interface MatchDetail {
  collection: string;
  score: number;
  /** Raw centroid similarity of the final pick (not the rounded `score`).
   * Used to threshold precisely — the rounded `score` has a blind band
   * at sim ∈ [0.85, 0.87) where items round up to 9 and escape a
   * score-based weak filter despite failing Phase 5's 0.87
   * disagree-reject gate. */
  sim: number;
  reason: string;
  /** T1_letter pick name (null if parse failed) */
  t1Pick?: string | null;
  /** T2_json pick name (null if parse failed) */
  t2Pick?: string | null;
  /** How the ensemble resolved: agree | a_wins | b_wins | a_only | b_only | fail */
  decision?: string;
  /** Top-K centroid sims (name → sim), ordered by similarity descending */
  topCentroids?: { name: string; sim: number }[];
  /** Item's Ollama topic-LLM category from embedding cache */
  ollamaCategory?: string;
  /** Short vision/summary snippet from embedding cache */
  summarySnippet?: string;
  /** Whether result came from score cache vs fresh LLM call */
  cached?: boolean;
}

/**
 * Gallery filter — passed from sidebar → gallery via plugin.setFilter().
 * null means show all items.
 */
export type RoostFilter = {
  platform?: string;
  category?: string | null;
  /** When set, filter requires both category AND subcategory match */
  subcategory?: string;
  itemIds?: string[];
  certainItemIds?: string[];
  uncertainItemIds?: string[];
  matchedItemIds?: string[];
  matchDetailMap?: Map<string, MatchDetail>;
  groupId?: string;  // which group's items are showing (for reassignment)
  folders?: FolderView[];
  /** Explorer mode: filter to files under this vault folder path */
  folder?: string;
  /** Collection name shown as header in the gallery */
  categoryName?: string;
  /** Collection description shown below the name */
  categoryDescription?: string;
  /** Collection NOT-description */
  categoryNotDescription?: string;
} | null;

/** Active Bases view mode — bookmarks gallery vs general file explorer */
export type RoostMode = "bookmarks" | "explorer" | null;

/**
 * Discriminated union of all item-click payloads fired from the gallery modal
 * and handled by RoostView's onItemClick listener.
 */
export type ItemClickData =
  | { action: "move"; itemId: string; from: string; to: string }
  | { action: "acceptSuggestions"; itemIds: string[] }
  | { action: "dismissSuggestions" }
  | { action: "reject"; itemId: string; groupId: string }
  | { action: "delete"; roostId: string }
  | { action: "rejectItems"; itemIds: string[] }
  | { action: "moveItems"; itemIds: string[]; to: string }
  | { action: "deleteItems"; roostIds: string[] }
  /** Fired by the "Start review pass" button in RoostView; handled by the gallery
   *  view's onItemClick subscriber which calls feedMode.startReviewPass + setTrainingMode. */
  | { action: "startReviewPass"; itemIds: string[] };

/**
 * Input for a Smart Assign run. The hook operates purely as a function
 * of this input — callers resolve scope (filter, resort, subcategorize)
 * into an input via the builders in `src/ui/lib/smart-assign-inputs.ts`.
 */
export type SmartAssignInput = {
  /** Items the pipeline will score and (on confirm) write to. Also the writable set. */
  itemIds: string[];
  /** Anchor collections for Phase 1 scoring, keyed by collection name. */
  collections: Record<string, string[]>;
  /** Constrained topic set passed through to embed + score. */
  topics: string[];
  /** Per-item provenance carried through Smart Assign for assigned-by tracking. */
  itemProvenance: Map<string, "human" | "auto">;
  /** How final labels are persisted on confirm. */
  write:
    | { into: "category" }
    | { into: "subcategoryOf"; parent: string };
  /** When true, Phase 2 Discover runs on unmatched items. When false, unmatched items go to Misc. */
  allowDiscovery: boolean;
  /** Pre-flight ranked candidate topics from item LLM categories.
   *  Populated by buildSubcategorizeInput; absent in filter/resort modes. */
  suggestedTopics?: { name: string; count: number }[];
};
