/**
 * Shared pipeline utilities — math, cache loading.
 */
import { Vault } from "obsidian";
import type { EmbeddingCacheEntry } from "@/types/roost";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir, cachePath } from "@/lib/roost-paths";
import { getActiveProvider } from "@/lib/llm-provider";
import { stripMediaUrls, getTweetMediaUrls } from "@/lib/extract";
import * as fs from "fs";
import * as path from "path";

// ── Text cleanup ──

/** Strip vision-model preambles ("The video features...", "A image depicts...") */
export function stripPreamble(s: string): string {
  const stripped = s.replace(
    /^(?:the |a )?(?:video|image|post|text|clip|photo|picture|content)\s+(?:(?:features|depicts|shows|showcases|discusses|documents|presents|demonstrates|highlights|captures|displays|illustrates|reveals|explores|examines|covers|describes|promotes|encourages)\s+|(?:appears to (?:be|show)\s+)|(?:is (?:about|a)\s+)|(?:(?:of|documenting|showcasing|demonstrating|presenting|showing|featuring|depicting|about)\s+))/i,
    ""
  );
  if (stripped !== s && stripped.length > 0) {
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }
  return s;
}

// ── Math ──

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Blend text-cosine and CLIP-cosine similarities at weight `alpha`.
 *
 * Returns text-only similarity when:
 *   - clipVec is null/undefined, OR
 *   - clipCentroid is null/undefined, OR
 *   - alpha === 0
 *
 * Returns clip-only similarity when alpha === 1.
 *
 * Otherwise: alpha * cosineSim(clipVec, clipCentroid) + (1-alpha) * cosineSim(textVec, textCentroid).
 *
 * Does NOT clamp alpha; settings UI is responsible for input validation.
 * The contract permits any numeric alpha (the producer never emits invalid values).
 */
export function fusedSimilarity(
  textVec: number[],
  textCentroid: number[],
  clipVec: number[] | null | undefined,
  clipCentroid: number[] | null | undefined,
  alpha: number,
): number {
  const textSim = cosineSimilarity(textVec, textCentroid);
  if (clipVec == null || clipCentroid == null || alpha === 0) return textSim;
  const clipSim = cosineSimilarity(clipVec, clipCentroid);
  if (alpha === 1) return clipSim;
  return alpha * clipSim + (1 - alpha) * textSim;
}

export function computeCentroid(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) for (let d = 0; d < dim; d++) avg[d] += v[d];
  for (let d = 0; d < dim; d++) avg[d] /= vectors.length;
  return avg;
}

/** Weight for human-assigned items when computing weighted centroids. */
export const HUMAN_WEIGHT = 3;

/**
 * Weighted centroid — human-assigned items pull the centroid more strongly
 * than auto-assigned ones, so the category center reflects human intent.
 */
export function computeWeightedCentroid(vectors: number[][], weights: number[]): number[] {
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  let totalW = 0;
  for (let i = 0; i < vectors.length; i++) {
    const w = weights[i];
    totalW += w;
    for (let d = 0; d < dim; d++) avg[d] += vectors[i][d] * w;
  }
  for (let d = 0; d < dim; d++) avg[d] /= totalW;
  return avg;
}

export function computeCohesion(vectors: number[][], centroid: number[]): number {
  if (vectors.length === 0) return 1;
  let sum = 0;
  for (const v of vectors) sum += cosineSimilarity(v, centroid);
  return sum / vectors.length;
}

// ── Embedding cache (singleton, loaded once) ──
// On-disk format: vectors in binary, text in JSON (vec: null).
//   .roost/embedding-vectors.bin — key index line + raw Float32Array
//   .roost/embedding-cache.json  — text fields only (backward compat with scripts)

const VEC_DIM = 768;

/** Write to a temp sibling then rename into place — an interrupted or truncated
 *  write leaves the previous good file intact instead of a corrupt one. */
function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

let cachedEmbeddings: Record<string, EmbeddingCacheEntry> | null = null;

/** Test-only hook — clears the in-memory embedding cache so the next loadEmbeddingCache reads from disk. */
export function __resetEmbeddingCache(): void {
  cachedEmbeddings = null;
}

/** Read vectors from the binary file. Format: first line = JSON array of keys, then raw Float32 data. */
function loadVectorsBin(binPath: string): Map<string, number[]> | null {
  try {
    const buf = fs.readFileSync(binPath);
    const nlIdx = buf.indexOf(10); // first newline
    if (nlIdx < 0) return null;
    const keys: string[] = JSON.parse(buf.slice(0, nlIdx).toString("utf8"));
    const dataStart = nlIdx + 1;
    const availBytes = buf.length - dataStart;
    const completeVecs = Math.floor(availBytes / (VEC_DIM * 4));
    const n = Math.min(keys.length, completeVecs);   // salvage the complete prefix
    if (n <= 0) return null;
    const usableBytes = n * VEC_DIM * 4;
    const aligned = Buffer.alloc(usableBytes);
    buf.copy(aligned, 0, dataStart, dataStart + usableBytes);
    const floats = new Float32Array(aligned.buffer, aligned.byteOffset, n * VEC_DIM);
    const result = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      result.set(keys[i], Array.from(floats.subarray(i * VEC_DIM, (i + 1) * VEC_DIM)));
    }
    return result;
  } catch {
    return null;
  }
}

/** Read CLIP vectors from a binary file. Same format as loadVectorsBin:
 *  first line = JSON array of keys, then raw Float32 data, VEC_DIM floats per key.
 *  Returns null on any failure (missing file, truncation, parse error, dim mismatch). */
function loadClipVectorsBin(binPath: string): Map<string, number[]> | null {
  try {
    const buf = fs.readFileSync(binPath);
    const nlIdx = buf.indexOf(10);
    if (nlIdx < 0) return null;
    const keys: string[] = JSON.parse(buf.slice(0, nlIdx).toString("utf8"));
    const dataStart = nlIdx + 1;
    const availBytes = buf.length - dataStart;
    const completeVecs = Math.floor(availBytes / (VEC_DIM * 4));
    const n = Math.min(keys.length, completeVecs);   // salvage the complete prefix
    if (n <= 0) return null;
    const usableBytes = n * VEC_DIM * 4;
    const aligned = Buffer.alloc(usableBytes);
    buf.copy(aligned, 0, dataStart, dataStart + usableBytes);
    const floats = new Float32Array(aligned.buffer, aligned.byteOffset, n * VEC_DIM);
    const result = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      result.set(keys[i], Array.from(floats.subarray(i * VEC_DIM, (i + 1) * VEC_DIM)));
    }
    return result;
  } catch {
    return null;
  }
}

/** Write vectors to binary file. */
function saveVectorsBin(binPath: string, cache: Record<string, EmbeddingCacheEntry>): void {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(cache)) {
    if (v.vec && v.vec.length === VEC_DIM) keys.push(k);
  }
  const headerBuf = Buffer.from(JSON.stringify(keys) + "\n", "utf8");
  const floatBuf = Buffer.alloc(keys.length * VEC_DIM * 4);
  const view = new Float32Array(floatBuf.buffer, floatBuf.byteOffset, keys.length * VEC_DIM);
  for (let i = 0; i < keys.length; i++) {
    view.set(cache[keys[i]].vec!, i * VEC_DIM);
  }
  writeFileAtomic(binPath, Buffer.concat([headerBuf, floatBuf]));
}

/** Write JSON with vec stripped to null (text fields only — backward compatible with scripts). */
function saveTextJson(jsonPath: string, cache: Record<string, EmbeddingCacheEntry>): void {
  const stripped: Record<string, { vision: string | null; summary: string | null; category: string | null; vec: null }> = {};
  for (const [k, v] of Object.entries(cache)) {
    stripped[k] = { vision: v.vision, summary: v.summary, category: v.category, vec: null };
  }
  writeFileAtomic(jsonPath, JSON.stringify(stripped));
}

export function loadEmbeddingCache(vault: Vault): Record<string, EmbeddingCacheEntry> {
  if (cachedEmbeddings) return cachedEmbeddings;

  const vaultPath = vaultBasePath(vault);
  const jsonPath = cachePath(vaultPath, "embedding-cache.json");
  const binPath = cachePath(vaultPath, "embedding-vectors.bin");

  // Text fields (vision/summary/category) are the expensive LLM work — load them
  // even if the vectors are missing/corrupt, so a bad .bin only costs re-embedding
  // (cheap) and never re-running vision/topic analysis.
  let textCache: Record<string, EmbeddingCacheEntry> = {};
  try { textCache = JSON.parse(fs.readFileSync(jsonPath, "utf8")) || {}; } catch { textCache = {}; }

  // Merge in whatever vectors load. A truncated bin yields its complete prefix
  // (Fix 3); a missing/empty bin leaves vecs null → those items re-embed.
  const vecMap = loadVectorsBin(binPath);
  if (vecMap && vecMap.size > 0) {
    for (const [key, vec] of vecMap) {
      if (textCache[key]) textCache[key].vec = vec;
      else textCache[key] = { vision: null, summary: null, category: null, vec };
    }
    const clipMap = loadClipVectorsBin(cachePath(vaultPath, "clip-vectors.bin"));
    if (clipMap && clipMap.size > 0) {
      for (const [key, clipVec] of clipMap) { if (textCache[key]) textCache[key].clipVec = clipVec; }
    }
  }

  // Dim guard (Fix 4): warn loudly on a model/dim change instead of silently
  // serving mismatched vectors.
  try {
    const meta = JSON.parse(fs.readFileSync(cachePath(vaultPath, "embedding-meta.json"), "utf8"));
    if (typeof meta?.dim === "number" && meta.dim !== VEC_DIM) {
      console.warn(`[roost] embedding cache dim ${meta.dim} != expected ${VEC_DIM} — vectors of the wrong dim are ignored`);
    }
  } catch { /* no meta file — fine */ }

  cachedEmbeddings = textCache;
  return cachedEmbeddings;
}

export function saveEmbeddingCache(vault: Vault, cache: Record<string, EmbeddingCacheEntry>): void {
  cachedEmbeddings = cache;
  const vaultPath = vaultBasePath(vault);
  const dir = cacheDir(vaultPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    saveVectorsBin(cachePath(vaultPath, "embedding-vectors.bin"), cache);
    saveTextJson(cachePath(vaultPath, "embedding-cache.json"), cache);
    writeFileAtomic(cachePath(vaultPath, "embedding-meta.json"), JSON.stringify({ dim: VEC_DIM }));
  } catch (e: unknown) {
    console.warn("[roost] Failed to save embedding cache:", e instanceof Error ? e.message : String(e));
  }
}

// ── LLM call ──

export interface OllamaGenerateOpts {
  model?: string;
  numPredict?: number;
  numCtx?: number;
  temperature?: number;
  signal?: AbortSignal;
  ollamaUrl?: string;
}

/**
 * Run a prompt through the currently-active LLM provider (Ollama, Anthropic,
 * or skip). Kept under the historical `ollamaGenerate` name to avoid churning
 * every call site, but the underlying call is now provider-agnostic.
 *
 * Returns trimmed response text. Throws on non-OK status or abort.
 */
export async function ollamaGenerate(prompt: string, opts: OllamaGenerateOpts = {}): Promise<string> {
  return getActiveProvider().generate(prompt, opts);
}

// ── Raw sync JSON access ──

function platformAndId(roostId: string): { platform: "twitter" | "tiktok"; id: string } | null {
  const i = roostId.indexOf(":");
  if (i < 0) return null;
  const p = roostId.slice(0, i);
  const id = roostId.slice(i + 1);
  if (!id) return null;
  if (p === "twitter" || p === "tiktok") return { platform: p, id };
  return null;
}

/**
 * Read the raw sync sidecar JSON for a roostId. Returns null if missing,
 * unreadable, malformed, or the platform isn't twitter/tiktok.
 */
export function readRawJson(
  vault: Vault,
  syncFolder: string,
  roostId: string
): Record<string, unknown> | null {
  const pid = platformAndId(roostId);
  if (!pid) return null;
  const folder = pid.platform === "twitter" ? "X" : "TikTok";
  const attachFolder = `${pid.platform}-${pid.id}`;
  const full = path.join(vaultBasePath(vault), syncFolder, folder, attachFolder, "raw.json");
  try {
    const text = fs.readFileSync(full, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Pull a single description blob out of a raw sync post.
 * Priority: TikTok structured contents > TikTok desc > Twitter legacy.full_text
 * > Twitter top-level full_text/text. Appends quoted tweet text when present
 * (X stores it at `quoted_status_result.result.legacy.full_text`).
 * Returns "" when nothing usable is present (including null input).
 */
export function extractDescription(raw: Record<string, unknown> | null): string {
  if (!raw) return "";

  const contents = raw.contents;
  if (Array.isArray(contents)) {
    const lines: string[] = [];
    for (const c of contents) {
      if (c && typeof c === "object" && typeof (c as { desc?: unknown }).desc === "string") {
        lines.push((c as { desc: string }).desc);
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }

  if (typeof raw.desc === "string" && raw.desc.length > 0) return raw.desc;

  // Twitter: the current GraphQL response nests v1.1-compatible fields under
  // `legacy`. Fall back to top-level for older captures and other platforms.
  const legacy = raw.legacy as Record<string, unknown> | undefined;
  let main = "";
  if (legacy && typeof legacy.full_text === "string" && legacy.full_text.length > 0) {
    main = legacy.full_text;
  } else if (typeof raw.full_text === "string" && raw.full_text.length > 0) {
    main = raw.full_text;
  } else if (typeof raw.text === "string" && raw.text.length > 0) {
    main = raw.text;
  }
  // Drop the trailing t.co media URLs Twitter appends to every image/video
  // post — they're noise for downstream LLM prompts and gallery captions.
  if (main) {
    main = stripMediaUrls(main, getTweetMediaUrls(raw));
  }

  // Quoted tweet: raw.quoted_status_result.result.legacy.full_text
  const quotedTweet = (raw.quoted_status_result as Record<string, unknown> | undefined)
    ?.result as Record<string, unknown> | undefined;
  const quoted = (quotedTweet?.legacy as Record<string, unknown> | undefined)?.full_text;
  if (typeof quoted === "string" && quoted.length > 0) {
    const cleanedQuoted = stripMediaUrls(quoted, getTweetMediaUrls(quotedTweet ?? null));
    return main ? `${main}\n\n[quoted] ${cleanedQuoted}` : `[quoted] ${cleanedQuoted}`;
  }

  return main;
}

// ── Pipeline caches ──

export function loadPipelineCache<T>(vault: Vault, filename: string): Record<string, T> {
  const root = vaultBasePath(vault);
  const canonical = cachePath(root, filename);
  const legacy = path.join(root, ".roost", filename);
  const full = fs.existsSync(canonical) ? canonical : legacy;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return {};
  }
}

export function savePipelineCache<T>(
  vault: Vault,
  filename: string,
  cache: Record<string, T>
): void {
  const dir = cacheDir(vaultBasePath(vault));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(vaultBasePath(vault), filename), JSON.stringify(cache));
  } catch (e: unknown) {
    console.warn(`[roost] Failed to save pipeline cache ${filename}:`, e instanceof Error ? e.message : String(e));
  }
}

/** Strip a leading ```json (or plain ```) fence and matching trailing fence
 *  from an LLM response, returning just the JSON body. Used by every judge
 *  prompt that asks for "JSON only" — the models sometimes wrap anyway. */
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:json)?\n?([\s\S]*?)\n?```$/);
  return m ? m[1] : trimmed;
}

/**
 * Visit `items` in sequential chunks of `size`, awaiting `fn` per chunk.
 * The body owns its own intra-batch concurrency (Promise.all/allSettled) and
 * post-batch work (cache saves, progress logs) — this helper only owns the
 * chunking iteration shared by every pipeline's triage/extract/resolve loops.
 * A rejection from `fn` propagates (no batches after it run).
 *
 * If `signal` is provided and becomes aborted, iteration stops before the
 * next batch starts. The current in-flight batch completes normally (so
 * per-batch cache saves remain consistent and the run is resumable via
 * cache-presence). Does NOT throw on abort — callers check signal.aborted
 * after the loop if they need to log a cancellation note.
 */
export async function forEachBatch<T>(
  items: readonly T[],
  size: number,
  fn: (batch: readonly T[], startIndex: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    if (signal?.aborted) return;
    await fn(items.slice(i, i + size), i);
  }
}

/**
 * Run an LLM produce-and-parse step up to `attempts` times, returning the
 * first non-null result, or `fallback` if every attempt parses to null.
 * Throws are NOT caught — a transport error propagates immediately, matching
 * the bespoke retry loops this replaces (retry is for malformed output, not
 * for a down backend).
 */
export async function withLLMRetry<T>(
  produce: () => Promise<T | null>,
  fallback: T,
  attempts = 2,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const parsed = await produce();
    if (parsed !== null) return parsed;
  }
  return fallback;
}
