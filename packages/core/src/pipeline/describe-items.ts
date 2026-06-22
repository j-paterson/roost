/**
 * Embedding pipeline — enrichment stages per item:
 * - Multi-frame vision via Gemma 4 (3 keyframes) for videos, single-cover minicpm-v otherwise
 * - Topic + category extraction via llama3.2:3b
 * - Embedding vector via fine-tuned sentence-transformer sidecar
 */
import { requestUrl, Vault, TFile, App } from "obsidian";
import { getSyncFiles, vaultBasePath } from "@/lib/vault-utils";
import type { EmbeddingCacheEntry } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import type { Embedder } from "@/lib/embedder";
import { loadEmbeddingCache, saveEmbeddingCache } from "@/pipeline/shared";

import { OLLAMA_URL, EMBED_CONCURRENCY, VISION_MODEL, VISION_NUM_CTX, EVAL_MODEL, TOPIC_MODEL, OLLAMA_NUM_CTX } from "@/config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

export interface FfmpegPaths { ffmpeg: string | null; ffprobe: string | null; }

/** Resolve ffmpeg + ffprobe when the flag is on and BOTH binaries are found.
 *  `find` is injected (registry's findBinary in prod) so this is unit-testable. */
export function resolveFfmpeg(flagOn: boolean, find: (name: string) => string | null): FfmpegPaths {
  if (!flagOn) return { ffmpeg: null, ffprobe: null };
  const ffmpeg = find("ffmpeg");
  const ffprobe = find("ffprobe");
  if (ffmpeg && ffprobe) return { ffmpeg, ffprobe };
  return { ffmpeg: null, ffprobe: null };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

interface DescribeOpts {
  vault: Vault;
  app?: App;
  syncFolder: string;
  ollamaUrl?: string;
  topics?: string[];
  /** When provided, only fill embeddings for files whose roost_id is in this set. Omitted = fill globally. */
  itemIds?: string[];
  embedder: Embedder;
  onProgress?: (processed: number, total: number, status: string) => void;
  onLog?: (msg: string) => void;
  stopSignal?: StopSignal;
  /** Resolved ffmpeg/ffprobe paths, or null paths to skip video-frame vision. */
  ffmpeg?: FfmpegPaths;
}

/**
 * Run the embedding pipeline on vault items that lack embeddings.
 * Three stages per item: vision → topic analysis → embedding vector.
 */
export async function describeItems(opts: DescribeOpts): Promise<{ processed: number; skipped: number; errors: number }> {
  const { vault, syncFolder, onProgress, onLog, stopSignal } = opts;
  const ollama = opts.ollamaUrl || OLLAMA_URL;
  const log = onLog || (() => {});
  const cache = loadEmbeddingCache(vault);

  // Fast scan: use metadata cache to find items needing embedding (no file reads)
  // vault.app is a private Obsidian property with no public type — cast is necessary.
  const app: App | undefined = opts.app || (vault as any).app;
  const files = getSyncFiles(vault, syncFolder);
  const needsEmbedding: TFile[] = [];
  let alreadyDone = 0;
  const idFilter = opts.itemIds ? new Set(opts.itemIds) : null;

  for (const file of files) {
    const fm = app?.metadataCache?.getFileCache(file)?.frontmatter;
    if (!fm?.roost_id) continue;
    if (idFilter && !idFilter.has(fm.roost_id)) continue;
    if (cache[fm.roost_id]?.vec) { alreadyDone++; continue; }
    needsEmbedding.push(file);
  }

  log(`${needsEmbedding.length} items need embedding (${alreadyDone} already done)`);
  if (needsEmbedding.length === 0) return { processed: 0, skipped: alreadyDone, errors: 0 };

  // Build items from the files that need work
  const vaultPath = vaultBasePath(vault);
  const items: { id: string; text: string; tags: string[]; file: TFile; coverPath: string | null; subtitle: string; mp4Path: string | null }[] = [];
  for (const file of needsEmbedding) {
    try {
      const fm = app?.metadataCache?.getFileCache(file)?.frontmatter;
      if (!fm?.roost_id) continue;
      const id = fm.roost_id;
      const text = fm.title || "";
      const tags: string[] = Array.isArray(fm.tags) ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
      // Resolve cover image path for vision analysis
      const coverRaw: string = fm.cover || "";
      const coverPath = coverRaw.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/^"/, "").replace(/"$/, "") || null;
      const subtitle = fm.subtitle || "";
      // Check for MP4 in attachment folder
      let mp4Path: string | null = null;
      if (coverPath) {
        const attachDir = path.join(vaultPath, path.dirname(coverPath));
        try {
          const files = fs.readdirSync(attachDir);
          const mp4 = files.find((f: string) => f.endsWith(".mp4"));
          if (mp4) mp4Path = path.join(attachDir, mp4);
        } catch { /* attach folder may not exist yet — mp4Path stays null */ }
      }
      items.push({ id, text, tags, file, coverPath, subtitle, mp4Path });
    } catch { /* skip */ }
  }

  log(`Prepared ${items.length} items for embedding`);
  if (items.length === 0) return { processed: 0, skipped: 0, errors: 0 };

  let processed = 0, errors = 0;
  const failed: typeof items = [];

  // Process in batches of CONCURRENCY
  for (let i = 0; i < items.length; i += EMBED_CONCURRENCY) {
    if (stopSignal?.stopped) break;
    const batch = items.slice(i, i + EMBED_CONCURRENCY);
    const ff = opts.ffmpeg ?? { ffmpeg: null, ffprobe: null };
    const results = await Promise.allSettled(batch.map(item => embedItem(item, cache, ollama, vault, vaultPath, log, opts.topics, opts.embedder, ff)));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled" && (results[j] as PromiseFulfilledResult<boolean>).value) processed++;
      else failed.push(batch[j]);
    }
    onProgress?.(i + batch.length, items.length, `${processed} embedded, ${failed.length} errors`);
    saveEmbeddingCache(vault, cache);
  }

  // Retry failed items once (common cause: Ollama timeout on first attempt)
  if (failed.length > 0 && !stopSignal?.stopped) {
    log(`Retrying ${failed.length} failed items...`);
    let retrySuccess = 0;
    const ff = opts.ffmpeg ?? { ffmpeg: null, ffprobe: null };
    for (let i = 0; i < failed.length; i += EMBED_CONCURRENCY) {
      if (stopSignal?.stopped) break;
      const batch = failed.slice(i, i + EMBED_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(item => embedItem(item, cache, ollama, vault, vaultPath, log, opts.topics, opts.embedder, ff)));
      for (const r of results) {
        if (r.status === "fulfilled" && (r as PromiseFulfilledResult<boolean>).value) retrySuccess++;
      }
    }
    processed += retrySuccess;
    errors = failed.length - retrySuccess;
    if (retrySuccess > 0) log(`Retry recovered ${retrySuccess} items`);
    saveEmbeddingCache(vault, cache);
  } else {
    errors = failed.length;
  }

  log(`Done: ${processed} embedded, ${errors} errors`);
  return { processed, skipped: alreadyDone, errors };
}

async function embedItem(
  item: { id: string; text: string; tags: string[]; file: TFile; coverPath: string | null; subtitle: string; mp4Path: string | null },
  cache: Record<string, EmbeddingCacheEntry>,
  ollama: string,
  vault: Vault,
  vaultPath: string,
  log: (msg: string) => void,
  topics?: string[],
  embedder?: Embedder,
  ff: FfmpegPaths = { ffmpeg: null, ffprobe: null },
): Promise<boolean> {
  const entry: EmbeddingCacheEntry = cache[item.id] || { vision: null, summary: null, category: null, vec: null, vecText: null };

  // Stage 1a: Vision analysis — single qwen call on the cover image
  if (!entry.vision && item.coverPath) {
    try {
      const imageFile = vault.getAbstractFileByPath(item.coverPath);
      if (imageFile instanceof TFile && /^(jpg|jpeg|png|webp)$/i.test(imageFile.extension)) {
        const imageData = await vault.readBinary(imageFile);
        const base64 = arrayBufferToBase64(imageData);
        const res = await requestUrl({
          url: `${ollama}/api/generate`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: VISION_MODEL,
            prompt: "Describe what is happening in this image in two or three sentences.",
            images: [base64],
            stream: false,
            options: { num_ctx: VISION_NUM_CTX },
          }),
        });
        entry.vision = (res.json?.response || "").trim().slice(0, 500) || null;
      }
    } catch {}
  }

  // Stage 1b: Summary — combines vision description + caption + transcript + tags
  if (!entry.summary && (item.text || entry.vision || item.subtitle)) {
    const cleanTags = filterTags(item.tags).join(", ");
    const parts: string[] = [];
    if (entry.vision) parts.push(`Image: ${entry.vision}`);
    if (item.text) parts.push(`Post text: "${item.text.slice(0, 500)}"`);
    if (item.subtitle) parts.push(`Transcript: "${item.subtitle.slice(0, 500)}"`);
    if (cleanTags) parts.push(`Tags: ${cleanTags}`);
    const context = parts.join("\n");
    const categoryInstruction = topics && topics.length > 0
      ? `Category: <pick from [${topics.join(", ")}] if one fits, otherwise use your own one-word category>`
      : `Category: <one word>`;
    const prompt = `${context}\n\nWhat is this about? Focus on the actual subject.\n\nRespond in exactly this format:\nTopic: <one sentence starting with the subject, not "The video/image...">\n${categoryInstruction}`;

    try {
      const res = await requestUrl({
        url: `${ollama}/api/generate`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TOPIC_MODEL, prompt, stream: false, options: { num_ctx: OLLAMA_NUM_CTX } }),
      });
      const raw = (res.json?.response || "").trim();
      const topicMatch = raw.match(/Topic:\s*(.+)/i);
      const categoryMatch = raw.match(/Category:\s*(\S+)/i);
      entry.summary = topicMatch?.[1]?.trim() || null;
      entry.category = categoryMatch?.[1]?.trim().replace(/['"]/g, "") || null;
    } catch (e: unknown) {
      log(`Topic analysis failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Stage 2: Embedding — compute vision-on and text-only vectors in one batch call
  if (!entry.vec || entry.vecText == null) {
    const visionText = [entry.vision, entry.summary, entry.category, item.text, item.subtitle].filter(Boolean).join(" ");
    const plainText = [entry.summary, entry.category, item.text, item.subtitle].filter(Boolean).join(" ");
    if (visionText.length > 10) {
      try {
        const [vVision, vText] = await embedder!.embed([visionText, plainText]);
        entry.vec = vVision ?? null;
        entry.vecText = plainText.length > 10 ? (vText ?? null) : (vVision ? [...vVision] : null);
      } catch (e: unknown) {
        log(`Embedding failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }
  }

  cache[item.id] = entry;
  return !!entry.vec;
}

// ── Video frame extraction helpers ────────────────────────────

function getVideoDuration(ffprobe: string, mp4Path: string): number | null {
  try {
    const out = execFileSync(ffprobe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "csv=p=0", mp4Path,
    ], { encoding: "utf8", timeout: 10000 });
    return parseFloat(out.trim());
  } catch { return null; }
}

function extractKeyframes(ffmpeg: string, mp4Path: string, duration: number): { tmpDir: string; framePaths: string[] } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-frames-"));
  const framePaths: string[] = [];
  for (const [i, pos] of [0.25, 0.5, 0.75].entries()) {
    const time = (duration * pos).toFixed(2);
    const framePath = path.join(tmpDir, `frame_${i}.jpg`);
    try {
      execFileSync(ffmpeg, [
        "-ss", time, "-i", mp4Path,
        "-frames:v", "1", "-q:v", "2",
        "-y", "-loglevel", "error", framePath,
      ], { timeout: 15000 });
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 100) {
        framePaths.push(framePath);
      }
    } catch {}
  }
  return { tmpDir, framePaths };
}

function filterTags(tags: string[]): string[] {
  return tags.filter(t => {
    if (t.startsWith("@") || t.startsWith("collection:") || t.startsWith("_")) return false;
    const lower = t.toLowerCase();
    if (["tiktok", "twitter", "farcaster", "fyp", "foryou", "viral", "trending"].includes(lower)) return false;
    return true;
  });
}

