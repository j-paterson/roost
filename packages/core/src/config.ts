/**
 * Centralized configuration constants.
 * All tuning parameters in one place for easy adjustment.
 */

// ── Plugin identity ──
export const PLUGIN_ID = "roost";
/** Frontmatter field for Smart Assign categories */
export const CATEGORY_FIELD = "roost_category";
/** Frontmatter field for subcategories within a category */
export const SUBCATEGORY_FIELD = "roost_subcategory";
/** Frontmatter field tracking how the category was assigned ("human" | "auto") */
export const ASSIGNED_BY_FIELD = "roost_assigned_by";

// ── Cascade thresholds ──
/** Cascade tier-1 cutoff: head max-softmax below this defers the item to the centroid
 *  tier (then discovery). Calibrated conservative (≥0.90 precision-on-accepted). */
export const HEAD_REJECT_TAU = 0.6149;
/** Cascade tier-2 cutoff: nearest-centroid sim below this leaves the item unmatched for
 *  discovery. Weak signal (AUROC 0.613) — kept low, stopgap only. */
export const CENTROID_REJECT_TAU = 0.50;

// ── Clustering ──
export const ABSORPTION_THRESHOLD = 0.3;
export const TAXONOMY_MIN_CLUSTER_SIZE = 2;
export const TAXONOMY_EPSILON_DEFAULT = 0.3;
export const MIN_DISCOVERY_COHESION = 0.75;

// ── Sync ──
export const SYNC_BATCH_SIZE = 200;
export const TIKTOK_VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MEDIA_DOWNLOAD_MAX_RETRIES = 2;
/** Per-stage cap for the embed pipeline's backend calls (vision, topic, embed).
 *  Without it, a stalled Ollama/sidecar request (cold model, VRAM contention)
 *  hangs the whole Smart Assign indefinitely — a single un-embeddable item stalls
 *  the run. On timeout the stage fails gracefully so the pipeline proceeds. */
export const EMBED_STAGE_TIMEOUT_MS = 120_000;
/** How many records writeBatch processes concurrently. Each item is network- and
 *  (for video) ffmpeg-bound, so a small pool overlaps the waits for a big speedup;
 *  kept low to avoid hammering platform CDNs/APIs into rate-limiting. */
export const WRITE_CONCURRENCY = 4;

// ── Ollama ──
export const OLLAMA_URL = "http://localhost:11434";
export const VISION_MODEL = "huihui_ai/qwen2.5-vl-abliterated:latest";
// Context window for vision calls. 4096 keeps KV-cache footprint small while
// fitting a single-frame prompt comfortably (image tokens ≈ 1000–2500).
export const VISION_NUM_CTX = 4096;
export const TOPIC_MODEL = "llama3.2:3b";
export const EVAL_MODEL = "gemma4:e4b";
export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_CONCURRENCY = 3;
export const SCORE_CONCURRENCY = 4;
// Context window for Ollama LLM calls. Our prompts are short (~500 tokens)
// so 2048 is ample — keeps KV cache small for parallel slots.
export const OLLAMA_NUM_CTX = 2048;
// Embed URL is split from OLLAMA_URL so the plugin can point at the v2
// fine-tuned sentence-transformer sidecar (scripts/embed-sidecar.py, default
// port 11435) while still using Ollama for LLM calls. Falls back to Ollama
// if the sidecar isn't running — describe-items.ts handles the retry.
export const EMBED_URL = "http://localhost:11435";

// ── Platform display names ──
export const PLATFORM_DISPLAY: Record<string, string> = { tiktok: "TikTok", twitter: "X", instagram: "Instagram", reddit: "Reddit", other: "Other" };

// ── Card rendering ──
export const CARD_WIDTH = 600;
export const CARD_PADDING = 32;
// ~90 lines × 22px line-height ≈ 2000px max body. Card grows to fit content;
// gallery thumbnails crop via CSS aspect-ratio, digest expanded view scrolls.
export const CARD_MAX_LINES = 90;

// ── Subcategory groupings ──
// Subcategory names treated as "music" by the Media list + pipeline.
// roost_subcategory is the user's curated label; the LLM might pick a
// different `mediaType` for the same item. Includes common variants
// (song, album, soundtrack) so user-curated values match the typed
// "Music" canonical form after lowercasing.
export const MUSIC_SUBCATEGORIES = new Set<string>([
  "music", "song", "songs", "album", "albums", "soundtrack", "playlist",
]);

// ── Weekly digest ──
// Categories the weekly digest aggregates. Order is significant — it drives
// the output section order. "Finances" (with 's') matches the actual vault
// collection name; user-facing copy and the design doc still call it "Finance".
export const WEEKLY_DIGEST_BUCKETS = [
  "Macro",
  "Business",
  "Finances",
  "AI",
  "Technology",
] as const;
export type WeeklyDigestBucket = typeof WEEKLY_DIGEST_BUCKETS[number];

/** Cosine similarity threshold for greedy single-linkage clustering within
 *  a bucket. Matches the existing daily-digest constant. Tunable: lower →
 *  bigger clusters; higher → more singletons. */
export const WEEKLY_DIGEST_CLUSTER_THRESHOLD = 0.78;

/** Dev-only command-palette entries (X cookie export, probe bootstrap) are
 *  registered only when this is set. Off in normal use; set the env var when
 *  developing/running live e2e. */
export const DEV_COMMANDS_ENABLED =
  typeof process !== "undefined" && process.env?.ROOST_DEV_COMMANDS === "1";

// ── Self-improving loop (Spec 2) ──────────────────────────────────────────────
/** Category names that are staging/abstain buckets, never learned classes (lowercased compare). */
export const RESERVED_NON_CATEGORIES = new Set<string>(["other"]);

export const TRAINING_SET_VERSION = 1;
export const EVAL_LOG_VERSION = 1;
/** Min human positives before a category is training-eligible (graduates into the head). */
export const TRAIN_ELIGIBILITY_MIN = 5;
/** Fading-window half-life (in confirm-batches) for prequential accuracy. */
export const EVAL_FADE_HALFLIFE_BATCHES = 5;
/** Flag a class whose wrong predictions have gone uncorrected for this many batches. */
export const CORRECTION_RATE_WINDOW_BATCHES = 8;
/** Flag a class whose human-label share jumps by more than this between halves. */
export const DRIFT_FLAG_DELTA = 0.15;

// ── Retrain engine (Spec 2 Plan 2) ────────────────────────────────────────────
export const OOF_FOLDS = 5;             // StratifiedKFold splits for the sidecar meta head
export const RETRAIN_SIGNAL_FLOOR = 10; // min new human labels since last train before retrain

// ── Retrain gate (Spec 2 amendment) ───────────────────────────────────────────
export const GATE_EPS = 0;               // non-regression tolerance (overall & macro)
export const GATE_CATASTROPHIC_DROP = 0.15; // a well-supported class dropping >this → reject
export const GATE_MIN_SUPPORT = 20;      // min holdout items for the catastrophic guard to apply
export const GATE_KFOLDS = 3;            // CV folds averaged for the gate decision
export const GATE_OOF = 3;              // OOF folds for throwaway gate models (cheaper than OOF_FOLDS)

// ── Training mode confirm cap (Task 2) ────────────────────────────────────────
/** Training mode: confirmed positives for a class are admitted up to this multiple
 *  of that class's correction-source positives. Confirms amplify curated classes but
 *  cannot build or dominate one alone (a class with 0 corrections admits 0 confirms). */
export const CONFIRM_CAP_RATIO = 2.0;

/** Seed timestamp for training-set bootstrap. All corpus labels seeded from existing
 *  frontmatter get this fixed low ts so they sort BEFORE any captured signal — making the
 *  seeded corpus the fair-baseline gate's baseline and ongoing captures the candidate. */
export const SEED_TS = 1;
