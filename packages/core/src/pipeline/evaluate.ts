/**
 * Score-first classification pipeline.
 *
 * Phase 1: Score items against known collections (user-defined categories).
 * Phase 2: Discover new categories from unmatched items, then score against those.
 *
 * Each item gets scored against its top-K nearest category centroids (1-10 scale).
 * Best score ≥ threshold → assigned. Below → unmatched/misc.
 */
import { requestUrl, Vault } from "obsidian";
import { vaultBasePath } from "@/lib/vault-utils";
import { cachePath } from "@/lib/roost-paths";
import type { EmbeddingCacheEntry, MatchDetail } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import { OLLAMA_URL, EVAL_MODEL, MIN_DISCOVERY_COHESION, SCORE_CONCURRENCY, OLLAMA_NUM_CTX } from "@/config";
import { cosineSimilarity, computeCentroid, computeWeightedCentroid, computeCohesion, stripPreamble, HUMAN_WEIGHT, fusedSimilarity } from "@/pipeline/shared";
import type { AssignedBy } from "@/lib/vault-utils";
import { resolveTaxonomy, type CategoryTaxonomy } from "@/pipeline/taxonomy";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Ensemble rerank (Phase 3): T1_letter on top-5 + T2_json on top-7, fused
// by an embedding-rank tiebreak. Sweep on v2 cache reproduces 85/119 (71.4%).
//   T1_letter K=5 → 84/119
//   T2_json   K=7 → 84/119
//   ensemble      → 85/119   (+1 item; 97 agree, 22 disagree, 17 A-wins, 5 B-wins)
const K_RERANK_SMALL = 5;
const K_RERANK_LARGE = 7;
// Minimum cosine similarity between item and the FINAL picked category
// centroid for the ensemble's choice to count as a match. 0 disables rejection
// (pure argmax over the top-7 candidates).
const SIM_THRESHOLD = 0;
// Phase 5 conditional rejection: when T1 and T2 DISAGREE (an uncertainty
// signal) AND the picked sim is below this value, reject the item as
// unmatched. Flat picked_sim thresholds gave no lift after Phase F v2
// collapsed the margin distribution, but disagree is a real signal:
// negatives disagreed 32% of the time vs 11% for pos-correct (sweep in
// .roost/phase5-threshold-results.json). Threshold 0.87 delivers F1 0.714
// on the 119-pos + 50-neg test set (+0.029 over T=0 baseline of 0.685).
const CONDITIONAL_REJECT_THRESHOLD = 0.87;
// Letters for up to K=10 candidates. K_RERANK_LARGE uses the first K letters.
const LETTERS = "ABCDEFGHIJ";
// Version bump any time a prompt template or parser changes. Mixed into
// catHash so swapping prompts invalidates stale score-cache entries.
const PROMPT_VERSION = "v5-ensemble-t1k5-t2k7-not-desc";
const PROMPT_VERSION_NONE = "v1-none";

/** Default α for CLIP-text fusion in Smart Assign top-K candidate selection.
 *  Matches the +4pp top-1 lift measured in the 119-item LOO eval (clip-eval-results.json). */
export const DEFAULT_CLIP_FUSION_ALPHA = 0.5;

/**
 * Score-cache key digest. Includes:
 *   - eval model name
 *   - prompt version
 *   - per-category: name, description, notDescription, AND centroid bytes
 *
 * Centroid bytes matter: today's bug is that adding items to a collection
 * moves the centroid but doesn't invalidate the cache, so we serve stale
 * scores. Hashing the first 32 bytes of each category's centroid (8 floats)
 * fixes that with negligible cost. Categories are sorted by name so order
 * doesn't change the hash.
 */
export function hashCategoryDefs(
  categories: { name: string; centroid: number[]; description: string; notDescription?: string; clipCentroid?: number[] }[],
  evalModel: string,
  promptVersion: string,
  alpha: number = DEFAULT_CLIP_FUSION_ALPHA,
): string {
  const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name));
  const parts = [evalModel, promptVersion, alpha.toFixed(3)];
  for (const c of sorted) {
    const buf = Buffer.alloc(64);  // 32 for text centroid + 32 for clip centroid
    for (let i = 0; i < Math.min(8, c.centroid.length); i++) {
      buf.writeFloatLE(c.centroid[i], i * 4);
    }
    if (c.clipCentroid) {
      for (let i = 0; i < Math.min(8, c.clipCentroid.length); i++) {
        buf.writeFloatLE(c.clipCentroid[i], 32 + i * 4);
      }
    }
    parts.push(`${c.name}|${c.description}|${c.notDescription || ""}|${buf.toString("hex")}`);
  }
  return crypto.createHash("md5").update(parts.join("||")).digest("hex").slice(0, 12);
}

// ── Score cache (persisted to .roost/score-cache.json) ────────

let scoreCache: Record<string, { cat: string; score: number; sim?: number; reason?: string } | null> = {};
let scoreCachePath: string | null = null;
let scoreCacheDirty = false;

/** Test-only: clear the in-memory score cache. */
export function __resetScoreCacheForTests(): void {
  scoreCache = {};
  scoreCacheDirty = false;
}

function loadScoreCache(vault: Vault): void {
  const vaultPath = vaultBasePath(vault);
  scoreCachePath = cachePath(vaultPath, "score-cache.json");
  try {
    if (fs.existsSync(scoreCachePath)) {
      scoreCache = JSON.parse(fs.readFileSync(scoreCachePath, "utf8"));
    }
  } catch { scoreCache = {}; }
}

function saveScoreCache(): void {
  if (!scoreCachePath || !scoreCacheDirty) return;
  try {
    fs.writeFileSync(scoreCachePath, JSON.stringify(scoreCache));
    scoreCacheDirty = false;
  } catch (e: unknown) {
    console.warn("[roost] Failed to save score cache:", e instanceof Error ? e.message : String(e));
  }
}

// ── Scoring against a set of categories ───────────────────────

export interface CategoryDef {
  name: string;
  centroid: number[];
  description: string;
  notDescription?: string;
  /** CLIP visual centroid built from member items' `clipVec`. Undefined when
   *  no members have CLIP coverage. Used by fusedSimilarity for the visual
   *  signal in candidate ranking. */
  clipCentroid?: number[];
}

interface ScoreOpts {
  itemIds: string[];
  cache: Record<string, EmbeddingCacheEntry>;
  categories: CategoryDef[];
  vault?: Vault;
  topK?: number;
  threshold?: number;
  ollamaUrl?: string;
  /** Short tag for log lines, e.g. "Step 1" */
  phaseTag?: string;
  /** One-line description logged at phase start */
  phaseDesc?: string;
  onProgress?: (done: number, total: number) => void;
  onLog?: (msg: string) => void;
  stopSignal?: StopSignal;
  /** Max concurrent LLM scoring requests. Defaults to SCORE_CONCURRENCY (4). */
  concurrency?: number;
  /**
   * When true, skip the T2_json LLM call entirely. T1's pick is used directly
   * and the only rejection condition is the per-item similarity floor (`threshold`).
   * Used by the eval suite's T1-only method. Defaults to false (full ensemble).
   */
  disableT2Rerank?: boolean;
  /** When true, use the T1-NONE prompt (single LLM call, lets the LLM refuse with
   *  "N: none of these fit"). On N, the item lands in `unmatched`. The score-cache
   *  key uses PROMPT_VERSION_NONE so NONE entries don't collide with T1+T2 entries.
   *  Defaults to false (full ensemble). */
  noneRefusal?: boolean;
  /** CLIP fusion strength. 0 = text only, 1 = CLIP only. Defaults to
   *  DEFAULT_CLIP_FUSION_ALPHA (0.5). Items without CLIP coverage transparently
   *  fall back to text-only via fusedSimilarity's null guards. */
  clipFusionAlpha?: number;
}

interface ScoreResult {
  /** itemId → category name */
  assignments: Map<string, string>;
  /** Items that didn't fit any category */
  unmatched: string[];
  /** Per-item match details (score + reason) for assigned items */
  matchDetails: Map<string, MatchDetail>;
}

/**
 * Parse the T1_letter response: a single letter A..E (up to K candidates).
 * Matches the first standalone letter in the valid range. Mirrors
 * scripts/llm-rerank-sweep.py::make_parse_t1. Returns the 0-indexed candidate
 * slot, or null if no letter is parseable.
 *
 * No "none" path — the LLM picks among the top-K candidates. Rejection of
 * poor matches is handled downstream via a centroid-similarity gate (SIM_THRESHOLD).
 */
function parsePickedLetter(raw: string, numCandidates: number): number | null {
  if (!raw) return null;
  const letters = LETTERS.slice(0, numCandidates);
  const re = new RegExp(`\\b([${letters}])\\b`);
  const m = raw.match(re);
  if (!m) return null;
  return letters.indexOf(m[1]);
}

/**
 * Parse the T2_json response: a JSON object mapping letter keys to numeric
 * scores, picking the letter with the highest score. Mirrors
 * scripts/llm-rerank-sweep.py::make_parse_t2. Returns the 0-indexed candidate
 * slot, or null if nothing parseable.
 *
 * Tries strict JSON first (handles `{"A": 7, "B": 3, ...}`), then falls back
 * to a regex scan for `A: 7` / `"A": 7` patterns so partial/noisy responses
 * still score something instead of exploding the parse_fail counter.
 */
function parseT2JsonPick(raw: string, numCandidates: number): number | null {
  if (!raw) return null;
  const letters = LETTERS.slice(0, numCandidates).split("");
  const letterSet = new Set(letters);

  const pickBest = (scores: Record<string, number>): number | null => {
    let bestLetter: string | null = null;
    let bestScore = -Infinity;
    for (const [L, s] of Object.entries(scores)) {
      if (s > bestScore) { bestScore = s; bestLetter = L; }
    }
    return bestLetter ? letters.indexOf(bestLetter) : null;
  };

  // Step 1: strict JSON. `{[\s\S]*}` is greedy so we grab the outermost braces,
  // which handles nested reasoning-model artifacts like `{thought: {...}, ...}`.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const scores: Record<string, number> = {};
        for (const [k, v] of Object.entries(obj)) {
          const kk = String(k).trim().toUpperCase();
          if (letterSet.has(kk)) {
            const n = Number(v);
            if (!Number.isNaN(n)) scores[kk] = n;
          }
        }
        if (Object.keys(scores).length > 0) return pickBest(scores);
      }
    } catch { /* fall through */ }
  }

  // Step 2: regex fallback. Matches `A: 7`, `"A": 7`, `'A': 7.5` etc.
  const scores: Record<string, number> = {};
  for (const L of letters) {
    const re = new RegExp(`["']?${L}["']?\\s*:\\s*(\\d+(?:\\.\\d+)?)`);
    const m = raw.match(re);
    if (m) scores[L] = parseFloat(m[1]);
  }
  if (Object.keys(scores).length > 0) return pickBest(scores);
  return null;
}

/**
 * Build the T1_letter prompt for a candidate list. Mirrors
 * scripts/llm-rerank-sweep.py::build_t1_template verbatim.
 */
function buildT1Prompt(summary: string, candidates: { name: string; description: string; notDescription?: string }[]): string {
  const k = candidates.length;
  const letters = LETTERS.slice(0, k);
  const catLines = candidates.map((c, j) => {
    const short = (c.description || c.name).slice(0, 300);
    const not = c.notDescription ? ` (NOT: ${c.notDescription.slice(0, 100)})` : "";
    return `${letters[j]}) ${c.name}: ${short}${not}`;
  }).join("\n");
  const tail = k === 1
    ? letters[0]
    : k === 2
      ? `${letters[0]} or ${letters[1]}`
      : `${letters.slice(0, -1).split("").join(", ")}, or ${letters[k - 1]}`;
  return `You are categorizing a short video bookmark. Pick which collection best fits.

Video summary: ${summary}

Options:
${catLines}

Respond with only a single letter: ${tail}.`;
}

/**
 * Build the T1-NONE prompt: same as T1 but with an explicit "N: none of these fit"
 * option. The LLM returns A-E or N. On N, callers route the item to parent.
 */
function buildT1NonePrompt(
  summary: string,
  candidates: { name: string; description: string }[],
): string {
  const letters = "ABCDE".slice(0, candidates.length).split("");
  const catLines = candidates.map((c, j) => {
    const short = (c.description || c.name).slice(0, 300);
    return `${letters[j]}) ${c.name}: ${short}`;
  }).join("\n");
  const tail = candidates.length === 1
    ? `${letters[0]} or N`
    : candidates.length === 2
      ? `${letters[0]}, ${letters[1]}, or N`
      : `${letters.slice(0, -1).join(", ")}, ${letters[letters.length - 1]}, or N`;
  return `You are categorizing a short video bookmark. Pick which collection best fits, or N if none of them fit well.

Video summary: ${summary}

Options:
${catLines}
N) None of these fit

Respond with only a single letter: ${tail}.`;
}

/**
 * Parse the T1-NONE response: a single letter A..E or N.
 * Returns the 0-indexed slot, "N", or null if unparseable.
 */
function parseT1NoneLetter(raw: string, numCandidates: number): number | "N" | null {
  if (!raw) return null;
  const letters = "ABCDE".slice(0, numCandidates) + "N";
  const re = new RegExp(`\\b([${letters}])\\b`);
  const m = raw.match(re);
  if (!m) return null;
  const letter = m[1];
  if (letter === "N") return "N";
  return "ABCDE".indexOf(letter);
}

/**
 * Build the T2_json prompt for a candidate list. Mirrors
 * scripts/llm-rerank-sweep.py::build_t2_template verbatim, including the
 * synthetic example scores (5 + i%5) so the LLM sees a valid-looking target.
 */
function buildT2Prompt(summary: string, candidates: { name: string; description: string; notDescription?: string }[]): string {
  const k = candidates.length;
  const letters = LETTERS.slice(0, k).split("");
  const catLines = candidates.map((c, j) => {
    const short = (c.description || c.name).slice(0, 300);
    const not = c.notDescription ? ` (NOT: ${c.notDescription.slice(0, 100)})` : "";
    return `${letters[j]}) ${c.name}: ${short}${not}`;
  }).join("\n");
  const exampleBody = letters.map((L, i) => `"${L}": ${5 + (i % 5)}`).join(", ");
  const example = `{${exampleBody}}`;
  return `Score how well this short video matches each collection on a scale of 1-10.

Video summary: ${summary}

${catLines}

Respond with JSON only, like: ${example}`;
}

/**
 * Score items against category centroids using the Phase 3 ensemble reranker.
 *
 * Pipeline per item:
 *   1. Rank the top-7 categories by centroid cosine similarity. (K=5 is just
 *      the first 5 of this list, so both templates share one ranking.)
 *   2. Call gemma4:e4b twice in parallel:
 *      • T1_letter on the top-5  → picks a single letter A..E
 *      • T2_json   on the top-7  → picks the max-score letter A..G
 *   3. Fuse with an embedding-rank tiebreak: if the two picks agree, use it;
 *      otherwise pick whichever candidate has the lower index in the top-7
 *      (i.e. the more similar-by-centroid one). Matches the audit dashboard's
 *      definition byte-for-byte.
 *   4. Reject items where the final picked category's centroid similarity is
 *      below SIM_THRESHOLD. With threshold=0 this is pure ensemble argmax.
 *
 * Sweep on v2 hardneg cache (gemma4:e4b, 119-item positive test set):
 *   T1_letter  K=5   / v2 cache: 84/119
 *   T2_json    K=7   / v2 cache: 84/119
 *   ensemble (t1+t2) / v2 cache: 85/119
 */
export async function scoreAgainstCategories(opts: ScoreOpts): Promise<ScoreResult> {
  const { itemIds, cache, categories, onProgress, onLog, stopSignal } = opts;
  const ollama = opts.ollamaUrl || OLLAMA_URL;
  const kLarge = Math.min(opts.topK ?? K_RERANK_LARGE, categories.length);
  const kSmall = Math.min(K_RERANK_SMALL, kLarge);
  const simThreshold = opts.threshold ?? SIM_THRESHOLD;
  const log = onLog || (() => {});
  const tag = opts.phaseTag || "Score";
  const desc = opts.phaseDesc || "";
  const concurrency = opts.concurrency ?? SCORE_CONCURRENCY;
  const disableT2 = opts.disableT2Rerank === true;
  const noneRefusal = opts.noneRefusal === true;
  const alpha = opts.clipFusionAlpha ?? DEFAULT_CLIP_FUSION_ALPHA;

  if (desc) log(`[${tag}] ${desc} (concurrency=${concurrency})`);

  if (categories.length === 0) {
    log(`[${tag}] 0 categories with centroids — skipping LLM scoring, all items unmatched`);
    return {
      assignments: new Map(),
      unmatched: [...itemIds],
      matchDetails: new Map(),
    };
  }

  if (opts.vault && !scoreCachePath) loadScoreCache(opts.vault);

  const catHash = hashCategoryDefs(categories, EVAL_MODEL, noneRefusal ? PROMPT_VERSION_NONE : PROMPT_VERSION, alpha);

  const assignments = new Map<string, string>();
  const matchDetails = new Map<string, MatchDetail>();
  const unmatched: string[] = [];
  let cacheHits = 0;
  let parseFailures = 0;
  let agreeCount = 0;
  let aWinCount = 0;
  let bWinCount = 0;
  const scoreDist: Record<number, number> = {};

  const T1_NUM_PREDICT = 10;
  const T2_NUM_PREDICT = Math.max(80, 30 + kLarge * 20);

  const startMs = Date.now();
  let llmWorkMs = 0;
  let llmItems = 0;
  const cachedScoreCutoff = Math.round(simThreshold * 10);

  // ── Per-item LLM scoring (called concurrently) ──
  async function scoreItem(id: string, idx: number) {
    const entry = cache[id];
    if (!entry?.vec) { unmatched.push(id); return; }

    const cKey = `${id}|${catHash}`;
    if (scoreCache[cKey] !== undefined) {
      const cached = scoreCache[cKey];
      if (cached && cached.cat === "__none__") {
        unmatched.push(id);
        cacheHits++;
        return;
      }
      if (cached && cached.cat && cached.score >= cachedScoreCutoff) {
        assignments.set(id, cached.cat);
        const effectiveSim = cached.sim ?? cached.score / 10;
        const summary = stripPreamble((entry.summary || entry.vision?.slice(0, 100) || id)).slice(0, 120);
        matchDetails.set(id, {
          collection: cached.cat, score: cached.score, sim: effectiveSim,
          reason: cached.reason || "",
          ollamaCategory: entry.category || undefined,
          summarySnippet: summary,
          cached: true,
        });
        scoreDist[cached.score] = (scoreDist[cached.score] || 0) + 1;
      } else {
        unmatched.push(id);
        scoreDist[cached?.score ?? 0] = (scoreDist[cached?.score ?? 0] || 0) + 1;
      }
      cacheHits++;
      return;
    }

    const top7 = categories
      .map(cat => ({
        ...cat,
        sim: fusedSimilarity(entry.vec!, cat.centroid, entry.clipVec, cat.clipCentroid, alpha),
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, kLarge);
    const top5 = top7.slice(0, kSmall);
    const summary = stripPreamble((entry.summary || entry.vision?.slice(0, 100) || id)).slice(0, 500);

    const llmStart = Date.now();
    try {
      if (noneRefusal) {
        // NONE mode: single LLM call with the T1-NONE prompt. On "N" → unmatched.
        const noneRes = await requestUrl({
          url: `${ollama}/api/generate`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: EVAL_MODEL, prompt: buildT1NonePrompt(summary, top5),
            stream: false, think: false,
            options: { temperature: 0, num_predict: T1_NUM_PREDICT, num_ctx: OLLAMA_NUM_CTX },
          }),
        });
        const noneRaw = (noneRes.json?.response || "").trim();
        const noneParsed = parseT1NoneLetter(noneRaw, top5.length);
        if (noneParsed === null) {
          parseFailures++;
          unmatched.push(id);
          llmWorkMs += Date.now() - llmStart;
          llmItems++;
          return;
        }
        if (noneParsed === "N") {
          unmatched.push(id);
          // Cache the refusal so subsequent runs skip the LLM call.
          scoreCache[cKey] = { cat: "__none__", score: 0, sim: 0, reason: "NONE-refusal" };
          scoreCacheDirty = true;
          llmWorkMs += Date.now() - llmStart;
          llmItems++;
          return;
        }
        const picked = top7[noneParsed];
        const pickedSim = picked.sim;
        const accepted = pickedSim >= simThreshold;
        if (accepted) {
          assignments.set(id, picked.name);
          matchDetails.set(id, {
            collection: picked.name,
            score: Math.max(0, Math.min(10, Math.round(pickedSim * 10))),
            sim: pickedSim,
            reason: `NONE-pick sim=${pickedSim.toFixed(3)}`,
            t1Pick: picked.name, t2Pick: null, decision: "a_only",
            topCentroids: top7.slice(0, 5).map(c => ({ name: c.name, sim: c.sim })),
            ollamaCategory: entry.category || undefined,
            summarySnippet: summary.slice(0, 120),
            cached: false,
          });
        } else {
          unmatched.push(id);
        }
        scoreCache[cKey] = { cat: picked.name, score: Math.max(0, Math.min(10, Math.round(pickedSim * 10))), sim: pickedSim, reason: "NONE-pick" };
        scoreCacheDirty = true;
        llmWorkMs += Date.now() - llmStart;
        llmItems++;
        return;
      }
      // Full ensemble path (T1 + T2) below — unchanged.
      const t1Promise = requestUrl({
        url: `${ollama}/api/generate`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: EVAL_MODEL, prompt: buildT1Prompt(summary, top5),
          stream: false, think: false,
          options: { temperature: 0, num_predict: T1_NUM_PREDICT, num_ctx: OLLAMA_NUM_CTX },
        }),
      });
      const t2Promise = disableT2 ? Promise.resolve(null) : requestUrl({
        url: `${ollama}/api/generate`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: EVAL_MODEL, prompt: buildT2Prompt(summary, top7),
          stream: false, think: false,
          options: { temperature: 0, num_predict: T2_NUM_PREDICT, num_ctx: OLLAMA_NUM_CTX },
        }),
      });
      const [t1Res, t2Res] = await Promise.all([t1Promise, t2Promise]);
      const t1Raw = (t1Res.json?.response || "").trim();
      const t2Raw = t2Res ? (t2Res.json?.response || "").trim() : "";
      const aIdx = parsePickedLetter(t1Raw, top5.length);
      const bIdx = t2Res ? parseT2JsonPick(t2Raw, top7.length) : null;

      let finalIdx: number | null = null;
      let decisionKind: "agree" | "a_wins" | "b_wins" | "a_only" | "b_only" | "fail" = "fail";
      if (aIdx !== null && bIdx !== null) {
        if (aIdx === bIdx) { finalIdx = aIdx; decisionKind = "agree"; agreeCount++; }
        else if (aIdx < bIdx) { finalIdx = aIdx; decisionKind = "a_wins"; aWinCount++; }
        else { finalIdx = bIdx; decisionKind = "b_wins"; bWinCount++; }
      } else if (aIdx !== null) { finalIdx = aIdx; decisionKind = "a_only"; }
      else if (bIdx !== null) { finalIdx = bIdx; decisionKind = "b_only"; }

      if (finalIdx === null) {
        parseFailures++;
        unmatched.push(id);
        if (idx < 10 || idx % 100 === 0) {
          log(`  [${tag}:${idx}] "${summary}" | PARSE FAIL | t1: "${t1Raw.replace(/\n/g, "\\n")}" | t2: "${t2Raw.replace(/\n/g, "\\n")}"`);
        }
        return;
      }

      const picked = top7[finalIdx];
      const pickedSim = picked.sim;
      const scoreInt = Math.max(0, Math.min(10, Math.round(pickedSim * 10)));
      scoreDist[scoreInt] = (scoreDist[scoreInt] || 0) + 1;

      const disagreed = decisionKind !== "agree";
      // When T2 is disabled there's no second source to disagree with, so skip
      // the conditional disagree-reject path. The simThreshold floor still applies.
      const conditionalReject = !disableT2 && disagreed && pickedSim < CONDITIONAL_REJECT_THRESHOLD;
      const accepted = pickedSim >= simThreshold && !conditionalReject;

      const aName = aIdx !== null ? top7[aIdx].name : null;
      const bName = bIdx !== null ? top7[bIdx].name : null;
      const topCentroids = top7.slice(0, 5).map(c => ({ name: c.name, sim: c.sim }));
      const rejReason = !accepted ? (conditionalReject ? "DISAGREE-REJECT" : "SIM-REJECT") : "";

      if (idx < 10 || idx % 100 === 0) {
        const gateState = accepted ? `→ ${picked.name}` : `→ UNMATCHED (${picked.name}) ${rejReason}`;
        log(`  [${tag}:${idx}] "${summary}" | a=${aName ?? "∅"} b=${bName ?? "∅"} ${decisionKind} ${gateState} (sim ${pickedSim.toFixed(3)})`);
      }
      const reasonStr = `${decisionKind} t1=${aName ?? "∅"} t2=${bName ?? "∅"} sim=${pickedSim.toFixed(3)}${rejReason ? " " + rejReason : ""}`;
      const detail: MatchDetail = {
        collection: picked.name, score: scoreInt, sim: pickedSim,
        reason: reasonStr,
        t1Pick: aName, t2Pick: bName, decision: decisionKind,
        topCentroids,
        ollamaCategory: entry.category || undefined,
        summarySnippet: summary.slice(0, 120),
        cached: false,
      };

      if (accepted) {
        assignments.set(id, picked.name);
        matchDetails.set(id, detail);
      } else {
        unmatched.push(id);
      }
      scoreCache[cKey] = { cat: picked.name, score: scoreInt, sim: pickedSim, reason: reasonStr };
      scoreCacheDirty = true;
    } catch (e: unknown) {
      unmatched.push(id);
      if (idx < 5) log(`  [${tag}:${idx}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    llmWorkMs += Date.now() - llmStart;
    llmItems++;
  }

  // ── Concurrent scoring with a sliding window ──
  let completed = 0;
  let lastFlush = 0;

  // Track in-flight promises by a monotonic ticket. When a promise settles,
  // it removes itself from the map. This avoids the unreliable
  // "race against Promise.resolve(false)" pattern.
  const inflight = new Map<number, Promise<void>>();
  let ticket = 0;

  function onItemDone() {
    completed++;
    if (completed % 10 === 0 || completed === itemIds.length) {
      onProgress?.(completed, itemIds.length);
    }
    if (completed - lastFlush >= 50 || completed === itemIds.length) {
      lastFlush = completed;
      saveScoreCache();
      if (llmItems > 0) {
        const avgLlmSec = llmWorkMs / llmItems / 1000;
        const effectiveSec = avgLlmSec / concurrency;
        const cacheHitRatio = cacheHits / completed;
        const remainingLlm = (itemIds.length - completed) * (1 - cacheHitRatio);
        const etaMin = Math.round(remainingLlm * effectiveSec / 60);
        const elapsedMin = ((Date.now() - startMs) / 60000).toFixed(1);
        log(`  [${tag}] ${completed}/${itemIds.length} · ${effectiveSec.toFixed(2)}s/item (×${concurrency}) · elapsed ${elapsedMin}m · ETA ~${etaMin}m`);
      }
    }
  }

  for (let i = 0; i < itemIds.length; i++) {
    if (stopSignal?.stopped) break;

    const t = ticket++;
    const p = scoreItem(itemIds[i], i).then(() => {
      inflight.delete(t);
      onItemDone();
    }, () => {
      inflight.delete(t);
      onItemDone();
    });
    inflight.set(t, p);

    // When pool is full, wait for any one to finish before adding more
    if (inflight.size >= concurrency) {
      await Promise.race(inflight.values());
    }
  }
  // Wait for remaining items
  await Promise.all(inflight.values());

  saveScoreCache();
  if (cacheHits > 0) log(`[${tag}] Score cache: ${cacheHits} hits`);
  const distLine = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    .filter(s => scoreDist[s])
    .map(s => `${s}:${scoreDist[s]}`)
    .join("  ");
  log(`[${tag}] Sim distribution (×10): ${distLine}  parse-fail:${parseFailures} (sim_threshold=${simThreshold.toFixed(2)})`);
  log(`[${tag}] Ensemble: ${agreeCount} agree, ${aWinCount} a-wins (T1), ${bWinCount} b-wins (T2)`);
  log(`[${tag}] ${itemIds.length} items scored: ${assignments.size} assigned, ${unmatched.length} unmatched`);
  return { assignments, unmatched, matchDetails };
}

// ── Contrastive description generation ────────────────────────

interface DescribeClusterOpts {
  clusters: { name: string; memberIds: string[] }[];
  cache: Record<string, EmbeddingCacheEntry>;
  ollamaUrl?: string;
  onLog?: (msg: string) => void;
  stopSignal?: StopSignal;
}

/** Pick the N member IDs closest to a centroid (filters out items without embeddings). */
function pickNearestIds(
  memberIds: string[],
  centroid: number[],
  n: number,
  cache: Record<string, EmbeddingCacheEntry>,
): string[] {
  return memberIds
    .filter(id => cache[id]?.vec)
    .map(id => ({ id, sim: cosineSimilarity(cache[id].vec!, centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, n)
    .map(x => x.id);
}

interface ClusterDescriptions {
  descriptions: Map<string, string>;
  notDescriptions: Map<string, string>;
}

/**
 * Generate contrastive descriptions AND "not about" boundaries for clusters.
 * Uses bidirectional neighbors: if B lists A as a top neighbor, A also sees B.
 * Single LLM call per cluster produces both outputs.
 */
export async function generateClusterDescriptions(opts: DescribeClusterOpts): Promise<ClusterDescriptions> {
  const { clusters, cache, onLog, stopSignal } = opts;
  const ollama = opts.ollamaUrl || OLLAMA_URL;
  const log = onLog || (() => {});
  const descriptions = new Map<string, string>();
  const notDescriptions = new Map<string, string>();

  // Compute centroids for all clusters
  const centroids = new Map<string, number[]>();
  for (const cluster of clusters) {
    const vecs = cluster.memberIds.filter(id => cache[id]?.vec).map(id => cache[id].vec!);
    if (vecs.length > 0) centroids.set(cluster.name, computeCentroid(vecs));
  }

  // Build bidirectional neighbor sets: top-5 by similarity + any cluster that lists us in its top-5
  const TOP_N = 5;
  const forwardNeighbors = new Map<string, { name: string; sim: number }[]>();
  for (const cluster of clusters) {
    const centroid = centroids.get(cluster.name);
    if (!centroid) continue;
    const ranked = clusters
      .filter(c => c.name !== cluster.name && centroids.has(c.name))
      .map(c => ({ name: c.name, sim: cosineSimilarity(centroid, centroids.get(c.name)!) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, TOP_N);
    forwardNeighbors.set(cluster.name, ranked);
  }

  // Merge: for each cluster, union its forward neighbors with any cluster that has it as a forward neighbor
  const biNeighbors = new Map<string, Map<string, number>>();
  for (const [name, fwd] of forwardNeighbors) {
    if (!biNeighbors.has(name)) biNeighbors.set(name, new Map());
    const map = biNeighbors.get(name)!;
    for (const nb of fwd) {
      map.set(nb.name, Math.max(map.get(nb.name) || 0, nb.sim));
    }
  }
  // Reverse pass: if A lists B, B also gets A
  for (const [name, fwd] of forwardNeighbors) {
    const centroid = centroids.get(name)!;
    for (const nb of fwd) {
      if (!biNeighbors.has(nb.name)) biNeighbors.set(nb.name, new Map());
      const map = biNeighbors.get(nb.name)!;
      if (!map.has(name)) {
        map.set(name, cosineSimilarity(centroids.get(nb.name)!, centroid));
      }
    }
  }

  // Index clusters by name for O(1) lookup in neighbor loop
  const clusterByName = new Map(clusters.map(c => [c.name, c]));

  for (const cluster of clusters) {
    if (stopSignal?.stopped) break;
    const centroid = centroids.get(cluster.name);
    if (!centroid) { descriptions.set(cluster.name, cluster.name); continue; }

    // Get bidirectional neighbors sorted by similarity, take top 5
    const nbMap = biNeighbors.get(cluster.name);
    if (!nbMap || nbMap.size === 0) { descriptions.set(cluster.name, cluster.name); continue; }
    const neighbors = [...nbMap.entries()]
      .map(([name, sim]) => ({ name, sim }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, TOP_N);

    // Sample items closest to this cluster's centroid (avoids misclassified outliers)
    const sampleIds = pickNearestIds(cluster.memberIds, centroid, 8, cache);
    const sampleTopics = sampleIds.map(id => stripPreamble((cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id)).slice(0, 120));

    // Counter-examples from neighbors (also centroid-nearest)
    const counterLines: string[] = [];
    for (const nb of neighbors) {
      const nbCluster = clusterByName.get(nb.name);
      const nbCentroid = nbCluster ? centroids.get(nb.name) : undefined;
      if (!nbCluster || !nbCentroid) continue;
      const nbSampleIds = pickNearestIds(nbCluster.memberIds, nbCentroid, 3, cache);
      const nbSamples = nbSampleIds
        .map(id => stripPreamble(cache[id]?.summary || "").slice(0, 80))
        .filter(Boolean);
      if (nbSamples.length > 0) {
        counterLines.push(`  [${nb.name}]: ${nbSamples.join(" | ")}`);
      }
    }

    const neighborNames = neighbors.map(n => `"${n.name}"`).join(", ");
    let prompt = `A bookmark collection called "${cluster.name}" with ${cluster.memberIds.length} items.\n\nItems IN "${cluster.name}":\n${sampleTopics.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}\n`;
    if (counterLines.length > 0) {
      prompt += `\nItems NOT in "${cluster.name}" but in similar collections:\n${counterLines.join("\n")}\n`;
    }
    prompt += `\nAnswer two questions about "${cluster.name}" vs ${neighborNames}:

1. DESCRIPTION: What specifically distinguishes "${cluster.name}"? Write one sentence.
2. NOT: What kinds of items from ${neighborNames} would be wrongly placed in "${cluster.name}"? Write one short phrase.

Reply in exactly this format:
DESCRIPTION: <one sentence>
NOT: <short phrase>`;

    try {
      const res = await requestUrl({
        url: `${ollama}/api/generate`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false, options: { num_ctx: OLLAMA_NUM_CTX } }),
      });
      const raw = (res.json?.response || "").trim();

      const descMatch = raw.match(/DESCRIPTION:\s*(.+)/i);
      const notMatch = raw.match(/NOT:\s*(.+)/i);

      const desc = descMatch ? descMatch[1].trim().slice(0, 250) : cluster.name;
      descriptions.set(cluster.name, desc);

      if (notMatch) {
        const notDesc = notMatch[1].trim().slice(0, 150);
        notDescriptions.set(cluster.name, notDesc);
        log(`  ${cluster.name}: ${desc}  |  NOT: ${notDesc}`);
      } else {
        log(`  ${cluster.name}: ${desc}`);
      }
    } catch {
      descriptions.set(cluster.name, cluster.name);
    }
  }

  return { descriptions, notDescriptions };
}

// ── Build CategoryDef from collection items ───────────────────

export function buildCategoryDefs(
  collections: Record<string, string[]>,
  descriptions: Map<string, string>,
  cache: Record<string, EmbeddingCacheEntry>,
  notDescriptions?: Map<string, string>,
  provenance?: Map<string, AssignedBy>,
  nameEmbeddings?: Map<string, number[]>,
): CategoryDef[] {
  const defs: CategoryDef[] = [];
  for (const [name, ids] of Object.entries(collections)) {
    const validIds = ids.filter(id => cache[id]?.vec);
    const vecs = validIds.map(id => cache[id].vec!);
    const nameVec = nameEmbeddings?.get(name.toLowerCase()) ?? null;

    // Skip collections with no items AND no name vector — nothing to score against.
    if (vecs.length === 0 && !nameVec) continue;

    let itemCentroid: number[] | null = null;
    if (vecs.length > 0) {
      if (provenance && validIds.some(id => provenance.get(id) === "human")) {
        const weights = validIds.map(id => provenance.get(id) === "human" ? HUMAN_WEIGHT : 1);
        itemCentroid = computeWeightedCentroid(vecs, weights);
      } else {
        itemCentroid = computeCentroid(vecs);
      }
    }

    let centroid: number[];
    if (nameVec && itemCentroid) {
      const n = vecs.length;
      const wItems = Math.sqrt(n) / (Math.sqrt(n) + Math.sqrt(50));
      const wName = 1 - wItems;
      const normalizedName = l2Normalize(nameVec);
      centroid = blend(itemCentroid, wItems, normalizedName, wName);
      centroid = l2Normalize(centroid);
    } else if (nameVec) {
      centroid = l2Normalize(nameVec);
    } else {
      // No name vector — use pure-item centroid (legacy behavior). Not normalized
      // to preserve scoring semantics on existing collections.
      centroid = itemCentroid!;
    }

    // Compute clipCentroid from member items that have a clipVec. Undefined
    // when no items in this category have CLIP coverage.
    const clipVecs = validIds
      .map(id => cache[id].clipVec)
      .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
    const clipCentroid = clipVecs.length > 0 ? computeCentroid(clipVecs) : undefined;

    defs.push({
      name,
      centroid,
      description: descriptions.get(name) || name,
      notDescription: notDescriptions?.get(name),
      clipCentroid,
    });
  }
  return defs;
}

function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map(x => x / norm);
}

function blend(a: number[], wA: number, b: number[], wB: number): number[] {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * wA + b[i] * wB;
  return out;
}

// ── Category discovery from Ollama-generated categories ───────

const MIN_CATEGORY_SIZE = 5;

interface DiscoveredCategory {
  name: string;
  itemIds: string[];
  description: string;
}

// Generic medium-labels the topic LLM (llama3.2:3b) emits when it can't
// identify the actual content. These would form huge, meaningless proposals
// that match nearly every item in the vault.
const META_LABELS = new Set([
  "video", "videos", "tiktok", "clip", "clips", "footage",
  "post", "posts", "reel", "reels", "content", "creator", "media",
]);

/**
 * Discover candidate categories from unmatched items by grouping on
 * their Ollama-generated categories. Groups with ≥ MIN_CATEGORY_SIZE
 * items become candidates. Much faster than UMAP+HDBSCAN.
 */
export function discoverCategories(
  unmatchedIds: string[],
  cache: Record<string, EmbeddingCacheEntry>,
  existingNames: Set<string>,
  log: (msg: string) => void,
  taxonomy: CategoryTaxonomy | null = null,
): DiscoveredCategory[] {
  // Group by Ollama category
  const catGroups = new Map<string, string[]>();
  let noCat = 0;
  for (const id of unmatchedIds) {
    const rawCat = cache[id]?.category;
    if (!rawCat) { noCat++; continue; }
    // Resolve through taxonomy to merge synonyms (Fitness/Exercise/Workout → canonical)
    const key = taxonomy
      ? resolveTaxonomy(taxonomy, rawCat)
      : rawCat.replace(/[^a-zA-Z\s]/g, "").trim().replace(/^(.)/, (_, c: string) => c.toUpperCase());
    if (key.length < 2) { noCat++; continue; }
    if (!catGroups.has(key)) catGroups.set(key, []);
    catGroups.get(key)!.push(id);
  }

  // Filter: must have enough items, must not duplicate an existing collection
  const candidates: DiscoveredCategory[] = [];
  const existingLower = new Set([...existingNames].map(n => n.toLowerCase()));

  const sorted = [...catGroups.entries()].sort((a, b) => b[1].length - a[1].length);
  log(`Category groups from unmatched items (${unmatchedIds.length} items, ${catGroups.size} categories, ${noCat} without category):`);
  for (const [name, ids] of sorted.slice(0, 30)) {
    const marker = ids.length >= MIN_CATEGORY_SIZE && !existingLower.has(name.toLowerCase()) ? "→ CANDIDATE" : "";
    log(`  ${String(ids.length).padStart(5)}  ${name} ${marker}`);
  }
  if (sorted.length > 30) log(`  ... and ${sorted.length - 30} more`);

  for (const [name, ids] of sorted) {
    if (ids.length < MIN_CATEGORY_SIZE) continue;
    if (existingLower.has(name.toLowerCase())) continue;
    if (META_LABELS.has(name.toLowerCase())) {
      log(`  skipped meta-label  ${name} (${ids.length} items)`);
      continue;
    }
    candidates.push({ name, itemIds: ids, description: name });
  }

  // Cohesion gate: drop incoherent over-generic groups (e.g. "Entertainment")
  const cohesionFiltered: DiscoveredCategory[] = [];
  for (const candidate of candidates) {
    const vecs = candidate.itemIds.filter(id => cache[id]?.vec).map(id => cache[id].vec!);
    if (vecs.length < 2) { cohesionFiltered.push(candidate); continue; }
    const centroid = computeCentroid(vecs);
    const cohesion = computeCohesion(vecs, centroid);
    if (cohesion >= MIN_DISCOVERY_COHESION) {
      log(`  cohesion ${cohesion.toFixed(4).padStart(7)}  ${candidate.name} (${candidate.itemIds.length} items) — kept`);
      cohesionFiltered.push(candidate);
    } else {
      log(`  cohesion ${cohesion.toFixed(4).padStart(7)}  ${candidate.name} (${candidate.itemIds.length} items) — dropped`);
    }
  }

  log(`\nDiscovered ${cohesionFiltered.length} candidate categories (≥${MIN_CATEGORY_SIZE} items, cohesion ≥${MIN_DISCOVERY_COHESION})`);
  return cohesionFiltered;
}
