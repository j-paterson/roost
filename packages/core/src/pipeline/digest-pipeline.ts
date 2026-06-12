/**
 * Weekly Digest pipeline — aggregates the past week's bookmarks from 5
 * curated buckets (Macro, Business, Finances, AI, Technology) into one
 * digest note with topic-clustered LLM summaries per bucket.
 *
 * NOT a category-enrichment pipeline: this file deliberately does NOT
 * implement `CategoryPipelineConfig` / `runCategoryPipeline`. Digest is a
 * synthesis pipeline — time-windowed candidates, cluster-keyed LLM work,
 * a week-keyed cache, and a NEW aggregate note as output — none of which
 * fit the runner's per-item triage→extract→write-in-place contract. It
 * shares only the low-level mechanics in `@/pipeline/shared` (cache I/O,
 * forEachBatch, withLLMRetry). See ARCHITECTURE.md "Category extraction
 * pipelines" for the rationale.
 *
 * Entry point: `runWeeklyDigest(app, syncFolder, weekStart, onLog?)`.
 * Output: `Pipelines/Digest/Weekly/{weekStartId}.md` (Sunday-start date).
 * Cache: `.roost/digest-cache.json`, keyed by week-start date.
 */
import { App, TFile } from "obsidian";
import { createHash } from "crypto";
import { buildFileIndex } from "@/lib/vault-utils";
import { ensureFolder, writeNoteSafe } from "@/lib/vault-helpers";
import {
  loadEmbeddingCache,
  cosineSimilarity,
  computeCentroid,
  ollamaGenerate,
  loadPipelineCache,
  savePipelineCache,
  stripJsonFence,
  forEachBatch,
  withLLMRetry,
} from "@/pipeline/shared";
import { mmrTrim } from "@/pipeline/mmr";
import { WEEKLY_DIGEST_BUCKETS, WEEKLY_DIGEST_CLUSTER_THRESHOLD } from "@/config";
import {
  toIsoDate,
  weekIdFromStart,
  weekEndFor,
  formatWeekHeading,
} from "@/lib/week-boundary";
import { writeClusterToMemory, type WriterCluster, type WriterClaim } from "@/pipeline/memory/writer";
import type { RoostSettings } from "@/settings";

// ── Types ──

interface DigestCandidate {
  roostId: string;
  file: TFile;
  title: string;
  author: string;
  url: string;
  tags: string[];
  vec: number[] | null;
  bucket: string;        // matches one of WEEKLY_DIGEST_BUCKETS
  savedDate: string;     // YYYY-MM-DD, the `saved` frontmatter field
  cover: string;         // vault-relative path to the thumbnail, or "" if none
}

/** A resolved claim ready for the memory writer — claim text + the roostId of
 *  the source item.  Derived from ExtractedClaim by resolving the 1-based `i`
 *  index against the trimmed items list inside summarizeCluster. */
interface DigestClusterClaim {
  text: string;
  sourceItemId: string;
}

interface DigestCluster {
  bucket: string;
  memberIds: string[];   // sorted asc for stable cache key
  headline: string;
  whyItMatters: string;
  openQuestion: string;
  delta: string;
  centroid: number[];
  /** Transient — resolved claims for the memory writer.  NOT persisted to the
   *  cluster cache (DigestClusterCacheEntry does not include this field). */
  claims?: DigestClusterClaim[];
}

interface DigestClusterCacheEntry {
  bucket: string;
  memberIds: string[];   // sorted asc
  headline: string;
  whyItMatters: string;
  openQuestion: string;
  delta: string;
  centroid: number[];
}

interface DigestWeekEntry {
  weekStart: string;     // YYYY-MM-DD (Sunday)
  weekEnd: string;       // YYYY-MM-DD (Saturday, nominal)
  through: string;       // YYYY-MM-DD, last day actually included
  generatedAt: string;   // ISO timestamp
  schemaVersion: number;
  bucketCounts: Record<string, number>;
  processedIds: string[];
  clusters: DigestClusterCacheEntry[];
}

type DigestCache = Record<string, DigestWeekEntry>;

interface DigestPipelineResult {
  weekStart: string;
  weekEnd: string;
  through: string;
  itemCount: number;
  bucketCounts: Record<string, number>;
  clusterCount: number;
  cachedClusterCount: number;
  errors: number;
}

// ── Constants ──

const CACHE_FILE = "digest-cache.json";
const OUTPUT_FOLDER = "Pipelines/Digest/Weekly";

const DIGEST_CACHE_SCHEMA_VERSION = 2;
const MMR_TARGET = 5;
const MMR_LAMBDA = 0.7;

// ── Cross-week delta lookup ──

export const PRIOR_LOOKBACK_WEEKS = 3;
export const PRIOR_CLUSTER_SIMILARITY_THRESHOLD = 0.65;

// ── Candidate gathering ──

function gatherCandidatesForWeek(
  app: App,
  syncFolder: string,
  weekStart: Date,
  weekEnd: Date,
): DigestCandidate[] {
  const embeddingCache = loadEmbeddingCache(app.vault);
  const fileIndex = buildFileIndex(app, syncFolder);
  const buckets = new Set<string>(WEEKLY_DIGEST_BUCKETS);
  const startStr = toIsoDate(weekStart);
  const endStr = toIsoDate(weekEnd);
  const candidates: DigestCandidate[] = [];

  for (const [roostId, file] of fileIndex) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const category = typeof fm.roost_category === "string" ? fm.roost_category : "";
    if (!buckets.has(category)) continue;

    const saved = typeof fm.saved === "string" ? fm.saved : null;
    if (!saved) continue;
    const savedDate = saved.slice(0, 10); // YYYY-MM-DD
    if (savedDate < startStr || savedDate > endStr) continue;

    const embedded = embeddingCache[roostId];
    const rawTags = Array.isArray(fm.tags) ? fm.tags : [];
    const tags: string[] = rawTags.map((t) =>
      String(t).toLowerCase().replace(/^#/, ""),
    );

    // Cover is stored as a wikilink string in frontmatter, e.g.
    //   "[[Bookmarks/TikTok/tiktok-XXX/cover.jpg]]"
    // Strip the wikilink syntax to a bare vault-relative path.
    let cover = typeof fm.cover === "string" ? fm.cover : "";
    const coverMatch = cover.match(/^\[\[(.+?)\]\]$/);
    if (coverMatch) cover = coverMatch[1];

    candidates.push({
      roostId,
      file,
      title: typeof fm.title === "string" ? fm.title : file.basename,
      author: typeof fm.author === "string" ? fm.author : "",
      url: typeof fm.url === "string" ? fm.url : "",
      tags,
      vec: embedded?.vec || null,
      bucket: category,
      savedDate,
      cover,
    });
  }

  return candidates;
}

// ── Greedy clustering by embedding similarity ──

function clusterByEmbedding(
  items: DigestCandidate[],
  threshold: number,
): DigestCandidate[][] {
  const withVec = items.filter(i => i.vec && i.vec.length > 0);
  const noVec = items.filter(i => !i.vec || i.vec.length === 0);

  const used = new Set<number>();
  const clusters: DigestCandidate[][] = [];

  for (let i = 0; i < withVec.length; i++) {
    if (used.has(i)) continue;
    const cluster: DigestCandidate[] = [withVec[i]];
    used.add(i);

    for (let j = i + 1; j < withVec.length; j++) {
      if (used.has(j)) continue;
      const sim = cosineSimilarity(withVec[i].vec!, withVec[j].vec!);
      if (sim >= threshold) {
        cluster.push(withVec[j]);
        used.add(j);
      }
    }

    clusters.push(cluster);
  }

  // Items without embeddings go into singleton clusters
  for (const item of noVec) {
    clusters.push([item]);
  }

  return clusters.sort((a, b) => b.length - a.length);
}

// ── Cross-week delta lookup ──

/**
 * Find the cluster in the prior 3 weeks (same bucket only) whose centroid
 * is most similar to `currentCentroid`, provided similarity ≥ threshold.
 * Returns null when no match exists or when the current centroid is empty.
 */
export function findRelatedPriorCluster(
  bucket: string,
  currentCentroid: number[],
  cache: DigestCache,
  currentWeekStartId: string,
): { weekStart: string; cluster: DigestClusterCacheEntry } | null {
  if (currentCentroid.length === 0) return null;

  const recentEntries = Object.values(cache)
    .filter((e) => e.weekStart < currentWeekStartId)
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    .slice(0, PRIOR_LOOKBACK_WEEKS);

  let best: { weekStart: string; cluster: DigestClusterCacheEntry; sim: number } | null = null;
  for (const entry of recentEntries) {
    for (const cluster of entry.clusters) {
      if (cluster.bucket !== bucket) continue;
      if (!cluster.centroid || cluster.centroid.length === 0) continue;
      if (cluster.centroid.length !== currentCentroid.length) continue;
      if (cluster.centroid.some((v) => !Number.isFinite(v))) continue;
      const sim = cosineSimilarity(currentCentroid, cluster.centroid);
      if (sim < PRIOR_CLUSTER_SIMILARITY_THRESHOLD) continue;
      if (!best || sim > best.sim) {
        best = { weekStart: entry.weekStart, cluster, sim };
      }
    }
  }
  return best ? { weekStart: best.weekStart, cluster: best.cluster } : null;
}

// ── Cluster summarization ──

/** Cache key for a cluster: bucket + sorted member ids. Exported as
 *  __clusterCacheKey for unit tests; not part of the module's public API. */
export function __clusterCacheKey(bucket: string, memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  return createHash("md5").update(`${bucket}|${sorted.join(",")}`).digest("hex");
}

/**
 * Synthesize a digest cluster. Singletons bypass all LLM calls. Multi-item
 * clusters go through MMR diversity trim → claim extraction → prior-cluster
 * lookup → synthesis with optional prior context.
 *
 * Cache hits short-circuit both LLM calls. v1 cache entries (entries lacking
 * the v2-required fields) are treated as misses so the new pipeline rewrites
 * them.
 *
 * `cache` and `weekStartId` are required so the prior-cluster lookup can
 * search across the last 3 weeks of cached clusters. The lookup is still
 * skipped when the current cluster has no centroid (empty array).
 */
export async function summarizeCluster(
  items: DigestCandidate[],
  priorCache: DigestClusterCacheEntry[],
  cache: DigestCache,
  weekStartId: string,
): Promise<DigestCluster> {
  if (items.length === 0) {
    throw new Error("summarizeCluster: empty cluster");
  }

  const bucket = items[0].bucket;

  if (items.length === 1) {
    const onlyVec = items[0].vec ?? null;
    return {
      bucket,
      memberIds: [items[0].roostId],
      headline: items[0].title.slice(0, 80),
      whyItMatters: "",
      openQuestion: "",
      delta: "",
      centroid: onlyVec && onlyVec.length > 0 ? onlyVec : [],
    };
  }

  // 1. Diversity trim. Clusters ≤ MMR_TARGET pass through unchanged.
  const trimmed = mmrTrim(items, MMR_TARGET, MMR_LAMBDA);
  const memberIds = trimmed.map((i) => i.roostId).sort();

  // 2. Compute centroid from trimmed vectors (empty if none have embeddings).
  const trimmedVecs = trimmed
    .map((i) => i.vec)
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
  const centroid = trimmedVecs.length > 0 ? computeCentroid(trimmedVecs) : [];

  // 3. Cache hit? V2 requires populated headline + whyItMatters; v1 entries
  //    lack these so they fall through to regenerate.
  //
  //    Also skip entries that hold a fallback "(summary unavailable)" body
  //    from a prior failed synthesis run — those shouldn't be cached as
  //    successful results. Persisted because we still want them in
  //    processedIds for accounting; treated as miss on read so the next
  //    run retries the LLM.
  const cached = priorCache.find(
    (c) =>
      c.bucket === bucket &&
      c.memberIds.length === memberIds.length &&
      c.memberIds.every((id, idx) => id === memberIds[idx]) &&
      c.whyItMatters !== FALLBACK_SYNTHESIS.whyItMatters,
  );
  if (cached) {
    return {
      bucket,
      memberIds,
      headline: cached.headline,
      whyItMatters: cached.whyItMatters,
      openQuestion: cached.openQuestion,
      delta: cached.delta,
      centroid: cached.centroid.length > 0 ? cached.centroid : centroid,
      // Cache hits don't re-extract claims; leave claims undefined so the
      // memory writer treats them as an empty list (safe — no double-writes
      // on re-runs because the memory writer's own idempotency guard fires).
    };
  }

  // 4. Extract claims (LLM call #1).
  let rawClaims: ExtractedClaim[] = [];
  try {
    rawClaims = await extractClaims(trimmed);
  } catch {
    rawClaims = [];
  }

  // Resolve 1-based `i` index to actual roostId for downstream consumers.
  const resolvedClaims: DigestClusterClaim[] = rawClaims
    .map((c) => {
      const item = trimmed[c.i - 1];
      if (!item) return null;
      return { text: c.claim, sourceItemId: item.roostId };
    })
    .filter((c): c is DigestClusterClaim => c !== null);

  // 5. Prior cluster lookup (cosine ≥ 0.65, same bucket, last 3 weeks).
  //    Skipped when the current cluster has no centroid (items lacked embeddings).
  const prior = centroid.length > 0
    ? findRelatedPriorCluster(bucket, centroid, cache, weekStartId)
    : null;

  // 6. Synthesize (LLM call #2).
  const synth = await synthesizeStep(rawClaims, prior);

  return {
    bucket,
    memberIds,
    headline: synth.headline || trimmed[0].title.slice(0, 80),
    whyItMatters: synth.whyItMatters,
    openQuestion: synth.openQuestion,
    delta: synth.delta,
    centroid,
    claims: resolvedClaims,
  };
}

// ── Claim extraction (LLM call #1) ──

export interface ExtractedClaim {
  i: number;
  claim: string;
}

function buildExtractClaimsPrompt(items: DigestCandidate[]): string {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tags = it.tags.slice(0, 5).join(", ");
    lines.push(
      `${i + 1}. ${it.author} · ${it.title.slice(0, 200)}${tags ? ` [${tags}]` : ""}`,
    );
  }

  return `You are extracting concrete claims from a cluster of social media bookmarks that appear to discuss the same topic.

For each item below, extract 1 or 2 short factual claims it makes (or the position/opinion it advances). Each claim must be a single declarative sentence that stands on its own — readable without the original item.

Skip pure jokes, reactions, or items with no clear claim.

Items:
${lines.join("\n")}

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "claims": [
    { "i": 1, "claim": "..." }
  ]
}`;
}

function tryParseClaimsOutput(raw: string): ExtractedClaim[] | null {
  try {
    const obj = JSON.parse(stripJsonFence(raw));
    if (!obj || !Array.isArray(obj.claims)) return null;
    const out: ExtractedClaim[] = [];
    for (const entry of obj.claims) {
      if (typeof entry?.i !== "number") continue;
      if (typeof entry?.claim !== "string") continue;
      const claim = entry.claim.trim();
      if (!claim) continue;
      out.push({ i: entry.i, claim });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Extract self-contained factual claims from a list of bookmark items.
 * On malformed-JSON response, retries once. Returns [] after second failure
 * so the synthesize step can still proceed with item-title-only context.
 */
export async function extractClaims(
  items: DigestCandidate[],
): Promise<ExtractedClaim[]> {
  return withLLMRetry(async () => {
    const raw = await ollamaGenerate(buildExtractClaimsPrompt(items), {
      numPredict: 400,
      numCtx: 3072,
    });
    return tryParseClaimsOutput(raw);
  }, []);
}

// ── Synthesis (LLM call #2) ──

export interface SynthesisResult {
  headline: string;
  whyItMatters: string;
  openQuestion: string;
  delta: string;
}

interface PriorClusterContext {
  weekStart: string;
  cluster: DigestClusterCacheEntry;
}

function buildSynthesizePrompt(
  claims: ExtractedClaim[],
  prior: PriorClusterContext | null,
): string {
  const claimsBlock = claims.length > 0
    ? claims.map((c) => `- ${c.claim}`).join("\n")
    : "(no specific claims extracted; synthesize from the topic at a high level)";

  if (prior) {
    const priorHeadline = prior.cluster.headline;
    const priorBody = prior.cluster.whyItMatters;
    return `You are writing the weekly digest section for a cluster of related bookmarks.
Below are this week's claims and the related discussion from a recent week.

This week's claims:
${claimsBlock}

Related prior-week discussion (from week of ${prior.weekStart}):
  Headline: "${priorHeadline}"
  Why it mattered: "${priorBody}"

Respond with ONLY valid JSON (no markdown, no commentary):
{
  "headline": "4-8 word phrase capturing the cluster (becomes a section title)",
  "why_it_matters": "1-2 sentences that SYNTHESIZE — surface the through-line connecting these claims, not just describe them",
  "open_question": "1 sentence: a tension, unresolved point, or thing-to-watch that the claims don't yet answer",
  "delta": "1 sentence on how this week DIFFERS from or builds on the prior-week discussion"
}`;
  }

  return `You are writing the weekly digest section for a cluster of related bookmarks.
Below are the factual claims extracted from the cluster.

Claims:
${claimsBlock}

Respond with ONLY valid JSON (no markdown, no commentary):
{
  "headline": "4-8 word phrase capturing the cluster (becomes a section title)",
  "why_it_matters": "1-2 sentences that SYNTHESIZE — surface the through-line connecting these claims, not just describe them",
  "open_question": "1 sentence: a tension, unresolved point, or thing-to-watch that the claims don't yet answer",
  "delta": ""
}`;
}

function tryParseSynthesisOutput(raw: string): SynthesisResult | null {
  try {
    const obj = JSON.parse(stripJsonFence(raw));
    if (
      typeof obj?.headline !== "string" ||
      typeof obj?.why_it_matters !== "string" ||
      typeof obj?.open_question !== "string" ||
      typeof obj?.delta !== "string"
    ) {
      return null;
    }
    return {
      headline: obj.headline.trim(),
      whyItMatters: obj.why_it_matters.trim(),
      openQuestion: obj.open_question.trim().replace(/\s*\n\s*/g, " "),
      delta: obj.delta.trim().replace(/\s*\n\s*/g, " "),
    };
  } catch {
    return null;
  }
}

const FALLBACK_SYNTHESIS: SynthesisResult = {
  headline: "",
  whyItMatters: "(summary unavailable)",
  openQuestion: "",
  delta: "",
};

/**
 * Synthesize a cluster section from extracted claims + optional prior-week
 * context. One retry on parse failure; falls back to a degraded but
 * well-typed result so the digest run continues.
 */
export async function synthesizeStep(
  claims: ExtractedClaim[],
  prior: PriorClusterContext | null,
): Promise<SynthesisResult> {
  return withLLMRetry(async () => {
    const raw = await ollamaGenerate(buildSynthesizePrompt(claims, prior), {
      numPredict: 350,
      numCtx: 2048,
    });
    return tryParseSynthesisOutput(raw);
  }, FALLBACK_SYNTHESIS);
}

// ── Note emission ──

export interface DigestWeekContext {
  weekStart: Date;
  weekEnd: Date;
  through: Date;
  generatedAt: string; // ISO timestamp
  bucketCounts: Record<string, number>;
  itemCount: number;
  clusters: DigestCluster[]; // already ordered by bucket then by size desc
  /** Lookup table: roostId → the candidate (used for wikilink display text). */
  candidatesByRoostId: Map<string, DigestCandidate>;
}

/** Strip ".md" suffix so the path can be used as the `roost-card` block body. */
function noteRefPath(path: string): string {
  return path.replace(/\.md$/i, "");
}

/** Render one item as a `roost-card` code block — picked up by the plugin's
 *  markdown post-processor and rendered as a full BasesView-style expanded
 *  card (image, title, identity, tags, click-to-open). */
function renderItemCallout(c: DigestCandidate): string[] {
  return ["```roost-card", noteRefPath(c.file.path), "```"];
}

export function buildWeeklyDigestNote(ctx: DigestWeekContext): string {
  const lines: string[] = [];

  // Frontmatter.
  lines.push("---");
  lines.push("roost_digest: weekly");
  lines.push(`digest_schema_version: ${DIGEST_CACHE_SCHEMA_VERSION}`);
  lines.push(`digest_week_start: ${toIsoDate(ctx.weekStart)}`);
  lines.push(`digest_week_end: ${toIsoDate(ctx.weekEnd)}`);
  lines.push(`digest_through: ${toIsoDate(ctx.through)}`);
  lines.push(`generated: ${ctx.generatedAt}`);
  lines.push(`item_count: ${ctx.itemCount}`);
  lines.push("bucket_counts:");
  for (const bucket of WEEKLY_DIGEST_BUCKETS) {
    lines.push(`  ${bucket}: ${ctx.bucketCounts[bucket] ?? 0}`);
  }
  lines.push("---");
  lines.push("");

  // H1 + one-line summary.
  lines.push(`# ${formatWeekHeading(ctx.weekStart, ctx.weekEnd)}`);
  lines.push("");
  lines.push(`${ctx.itemCount} items across ${WEEKLY_DIGEST_BUCKETS.length} buckets.`);
  lines.push("");

  // One H2 per bucket, fixed order.
  for (const bucket of WEEKLY_DIGEST_BUCKETS) {
    lines.push(`## ${bucket}`);
    const bucketClusters = ctx.clusters.filter((c) => c.bucket === bucket);
    const bucketItemCount = ctx.bucketCounts[bucket] ?? 0;

    if (bucketItemCount === 0) {
      lines.push("*(no items this week)*");
      lines.push("");
      continue;
    }

    const clusterCount = bucketClusters.length;
    const plural = clusterCount === 1 ? "cluster" : "clusters";
    lines.push(`${bucketItemCount} items in ${clusterCount} topic ${plural}.`);
    lines.push("");

    for (const cluster of bucketClusters) {
      lines.push(`### ${cluster.headline}`);

      // Body paragraph (only when present — singletons have empty whyItMatters).
      if (cluster.whyItMatters) {
        lines.push("");
        lines.push(cluster.whyItMatters);
      }

      // Δ callout (omit when empty).
      if (cluster.delta) {
        lines.push("");
        lines.push("> [!info] Δ from prior weeks");
        lines.push(`> ${cluster.delta}`);
      }

      // Open-question callout (omit when empty).
      if (cluster.openQuestion) {
        lines.push("");
        lines.push("> [!question] Open question");
        lines.push(`> ${cluster.openQuestion}`);
      }

      // One collapsed callout per item — collapsed shows thumbnail + wikilink,
      // expanded reveals the BasesView-style detail card (image, metadata, source).
      lines.push("");
      for (const id of cluster.memberIds) {
        const cand = ctx.candidatesByRoostId.get(id);
        if (!cand) continue;
        for (const ln of renderItemCallout(cand)) lines.push(ln);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ── Main entry ──

/** Subset of RoostSettings consumed by runWeeklyDigest.  The full type is used
 *  at call sites; this minimal interface keeps the function testable without
 *  constructing a complete settings object. */
interface DigestPipelineSettings {
  memoryEnabled: boolean;
  memoryJudgeModel: string;
  memoryConceptMatchThreshold: number;
  memoryConceptCreateThreshold: number;
  memoryClaimRedundantThreshold: number;
  memoryClaimRefineThreshold: number;
  memoryIndexTier1MaxConcepts: number;
  memoryIndexTier1MaxAgeDays: number;
}

// Satisfies DigestPipelineSettings AND RoostSettings (structural subtyping).
const _: DigestPipelineSettings = null as unknown as RoostSettings;
void _;

const DEFAULT_DIGEST_PIPELINE_SETTINGS: DigestPipelineSettings = {
  memoryEnabled: false,
  memoryJudgeModel: "default",
  memoryConceptMatchThreshold: 0.75,
  memoryConceptCreateThreshold: 0.55,
  memoryClaimRedundantThreshold: 0.92,
  memoryClaimRefineThreshold: 0.75,
  memoryIndexTier1MaxConcepts: 20,
  memoryIndexTier1MaxAgeDays: 90,
};

/**
 * Generate the weekly digest for the week containing `weekStart` (Sunday).
 * Partial weeks are clamped to today via `weekEndFor`. Output is written to
 * `Pipelines/Digest/Weekly/{weekStartId}.md` and the cluster cache at
 * `.roost/digest-cache.json` is updated.
 *
 * Pass `settings` to enable agent-memory integration (settings-gated by
 * `memoryEnabled`; defaults to off so existing callers are unaffected).
 */
export async function runWeeklyDigest(
  app: App,
  syncFolder: string,
  weekStart: Date,
  onLog?: (msg: string) => void,
  settings: DigestPipelineSettings = DEFAULT_DIGEST_PIPELINE_SETTINGS,
): Promise<DigestPipelineResult> {
  const log = onLog ?? (() => {});
  const today = new Date();
  const through = weekEndFor(weekStart, today);
  // Nominal end of the week is always weekStart + 6 (Saturday), even on
  // partial-week generation. Reflects "what the complete week would have
  // been" so the frontmatter + heading stay stable across mid-week reruns.
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
  const weekStartId = weekIdFromStart(weekStart);

  log(
    `Scanning vault for items saved ${toIsoDate(weekStart)} → ${toIsoDate(through)}...`,
  );
  const candidates = gatherCandidatesForWeek(app, syncFolder, weekStart, through);

  const bucketCounts: Record<string, number> = {};
  for (const b of WEEKLY_DIGEST_BUCKETS) bucketCounts[b] = 0;
  for (const c of candidates) bucketCounts[c.bucket] = (bucketCounts[c.bucket] ?? 0) + 1;

  log(
    `Found ${candidates.length} items across ${WEEKLY_DIGEST_BUCKETS.length} buckets (` +
      WEEKLY_DIGEST_BUCKETS.map((b) => `${b}: ${bucketCounts[b]}`).join(", ") +
      `).`,
  );

  if (candidates.length === 0) {
    return {
      weekStart: toIsoDate(weekStart),
      weekEnd: toIsoDate(weekEnd),
      through: toIsoDate(through),
      itemCount: 0,
      bucketCounts,
      clusterCount: 0,
      cachedClusterCount: 0,
      errors: 0,
    };
  }

  // Load prior week's cluster cache so we can reuse summaries on re-run.
  const cache = loadPipelineCache<DigestWeekEntry>(app.vault, CACHE_FILE);
  const priorEntry = cache[weekStartId];
  const priorEntryIsV2 = priorEntry?.schemaVersion === DIGEST_CACHE_SCHEMA_VERSION;
  const priorClusterCache: DigestClusterCacheEntry[] = priorEntryIsV2
    ? priorEntry.clusters
    : [];

  // Per-bucket: cluster + summarize (sequential between buckets, parallel within).
  const candidatesByRoostId = new Map<string, DigestCandidate>(
    candidates.map((c) => [c.roostId, c]),
  );
  const allClusters: DigestCluster[] = [];
  let cachedClusterCount = 0;
  let errors = 0;

  for (const bucket of WEEKLY_DIGEST_BUCKETS) {
    const bucketItems = candidates.filter((c) => c.bucket === bucket);
    if (bucketItems.length === 0) continue;

    // Split: items with vectors cluster normally; items without vectors get
    // a single trailing "Uncategorized" cluster (chronological order, no LLM).
    const withVec = bucketItems.filter((c) => c.vec && c.vec.length > 0);
    const noVec = bucketItems.filter((c) => !c.vec || c.vec.length === 0);

    log(`Clustering ${bucket}...`);
    const groups = withVec.length > 0
      ? clusterByEmbedding(withVec, WEEKLY_DIGEST_CLUSTER_THRESHOLD)
      : [];
    log(`  ${groups.length} cluster(s) found${noVec.length > 0 ? ` (+${noVec.length} uncategorized)` : ""}`);

    const CONCURRENCY = 3;
    const bucketClusters: DigestCluster[] = [];
    await forEachBatch(groups, CONCURRENCY, async batch => {
      const summarized = await Promise.all(
        batch.map(async (group) => {
          try {
            const cluster = await summarizeCluster(group, priorClusterCache, cache, weekStartId);
            const key = __clusterCacheKey(cluster.bucket, cluster.memberIds);
            const wasCached = priorClusterCache.some(
              (c) =>
                c.bucket === cluster.bucket &&
                __clusterCacheKey(c.bucket, c.memberIds) === key,
            );
            // Singletons bypass the LLM via summarizeCluster's early return; they
            // don't benefit from the cache, so don't count them in cachedClusterCount.
            if (wasCached && cluster.memberIds.length > 1) cachedClusterCount++;
            return cluster;
          } catch (err) {
            errors++;
            const firstTitle = group[0]?.title?.slice(0, 80) ?? "Cluster";
            log(`  cluster summary error in ${bucket}: ${err instanceof Error ? err.message : String(err)}`);
            return {
              bucket,
              memberIds: group.map((g) => g.roostId).sort(),
              headline: firstTitle,
              whyItMatters: "(summary unavailable)",
              openQuestion: "",
              delta: "",
              centroid: [],
            };
          }
        }),
      );
      bucketClusters.push(...summarized);
    });

    // Order clusters within bucket: size desc, then most-recent savedDate desc.
    bucketClusters.sort((a, b) => {
      if (b.memberIds.length !== a.memberIds.length) {
        return b.memberIds.length - a.memberIds.length;
      }
      const aRecent = Math.max(
        ...a.memberIds
          .map((id) => candidatesByRoostId.get(id)?.savedDate ?? "")
          .map((s) => (s ? Date.parse(s) : 0)),
      );
      const bRecent = Math.max(
        ...b.memberIds
          .map((id) => candidatesByRoostId.get(id)?.savedDate ?? "")
          .map((s) => (s ? Date.parse(s) : 0)),
      );
      return bRecent - aRecent;
    });

    // After sorting, append an Uncategorized cluster if there are no-vec items.
    // It bypasses summarizeCluster and lives at the bottom of the bucket
    // regardless of size.
    if (noVec.length > 0) {
      const noVecSorted = [...noVec].sort((a, b) =>
        a.savedDate < b.savedDate ? 1 : a.savedDate > b.savedDate ? -1 : 0,
      );
      bucketClusters.push({
        bucket,
        memberIds: noVecSorted.map((c) => c.roostId).sort(),
        headline: "Uncategorized",
        whyItMatters: "",
        openQuestion: "",
        delta: "",
        centroid: [],
      });
    }

    allClusters.push(...bucketClusters);
  }

  // Persist updated cluster cache for this week.
  const generatedAt = new Date().toISOString();
  cache[weekStartId] = {
    weekStart: toIsoDate(weekStart),
    weekEnd: toIsoDate(weekEnd),
    through: toIsoDate(through),
    generatedAt,
    schemaVersion: DIGEST_CACHE_SCHEMA_VERSION,
    bucketCounts,
    processedIds: candidates.map((c) => c.roostId),
    clusters: allClusters.map((c) => ({
      bucket: c.bucket,
      memberIds: c.memberIds,
      headline: c.headline,
      whyItMatters: c.whyItMatters,
      openQuestion: c.openQuestion,
      delta: c.delta,
      centroid: c.centroid,
    })),
  };
  savePipelineCache(app.vault, CACHE_FILE, cache);

  // ── Agent-memory hook (settings-gated) ──
  // Runs after the cluster cache is persisted so a memory write failure cannot
  // corrupt the digest cache.  Per-cluster try/catch isolates failures so a
  // bad cluster never blocks digest publication.
  if (settings.memoryEnabled) {
    for (const cluster of allClusters) {
      try {
        const clusterClaims = cluster.claims ?? [];
        const writerClaims: WriterClaim[] = clusterClaims.map((c) => {
          const cand = candidatesByRoostId.get(c.sourceItemId);
          // Build a display label "@handle — title (first 60 chars)" so the
          // memory file renders sources as [[path|@handle — title]] in
          // Obsidian — keeps the wikilink target intact while showing a
          // human-readable name regardless of the file's actual basename.
          const handle = cand?.author?.replace(/^\[\[People\/|\]\]$/g, "") ?? "";
          const title = cand?.title ?? "";
          const titleShort = title.length > 60 ? title.slice(0, 57) + "…" : title;
          const labelParts: string[] = [];
          if (handle) labelParts.push(handle);
          if (titleShort) labelParts.push(titleShort);
          const sourceLabel = labelParts.length > 0 ? labelParts.join(" — ") : undefined;
          return {
            text: c.text,
            sourceItemId: c.sourceItemId,
            sourcePath: cand?.file.path ?? c.sourceItemId,
            sourceLabel,
            embedding: cand?.vec ?? [],
          };
        });
        const writerCluster: WriterCluster = {
          bucket: cluster.bucket,
          headline: cluster.headline,
          whyItMatters: cluster.whyItMatters,
          centroid: cluster.centroid,
          claims: writerClaims,
        };
        const judgeModel =
          settings.memoryJudgeModel === "default" ? undefined : settings.memoryJudgeModel;
        await writeClusterToMemory(app, writerCluster, weekStartId, log, {
          thresholds: {
            conceptMatch: settings.memoryConceptMatchThreshold,
            conceptCreate: settings.memoryConceptCreateThreshold,
            claimRedundant: settings.memoryClaimRedundantThreshold,
            claimRefine: settings.memoryClaimRefineThreshold,
          },
          indexOpts: {
            maxConcepts: settings.memoryIndexTier1MaxConcepts,
            maxAgeDays: settings.memoryIndexTier1MaxAgeDays,
          },
          judgeModel,
        });
      } catch (err) {
        log(
          `memory write failed for cluster "${cluster.headline}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Build and write the note.
  const md = buildWeeklyDigestNote({
    weekStart,
    weekEnd,
    through,
    generatedAt,
    bucketCounts,
    itemCount: candidates.length,
    clusters: allClusters,
    candidatesByRoostId,
  });

  const folderMemo = new Set<string>();
  await ensureFolder(app.vault, OUTPUT_FOLDER, folderMemo);
  const outPath = `${OUTPUT_FOLDER}/${weekStartId}.md`;
  await writeNoteSafe(app.vault, outPath, md);
  log(
    `Wrote ${outPath} (${candidates.length} items, ${allClusters.length} clusters, ${cachedClusterCount} reused).`,
  );

  return {
    weekStart: toIsoDate(weekStart),
    weekEnd: toIsoDate(weekEnd),
    through: toIsoDate(through),
    itemCount: candidates.length,
    bucketCounts,
    clusterCount: allClusters.length,
    cachedClusterCount,
    errors,
  };
}

export type { DigestCandidate, DigestCluster, DigestClusterCacheEntry, DigestWeekEntry, DigestCache, DigestPipelineResult };
