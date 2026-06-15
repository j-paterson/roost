/**
 * One-shot backfill: walk all TikTok bookmark attach folders, find video
 * items that have a downloaded video.mp4 but NO caption track (subtitle.vtt),
 * ask the local embedding sidecar (faster-whisper) to transcribe the speech,
 * and write the result so the recipe (and other) pipelines can read it.
 *
 * The transcript is stored exactly like a native TikTok caption track:
 *   - the WebVTT goes to `tiktok-<id>/subtitle.vtt`
 *   - the plain text goes to the note's `subtitle` frontmatter field
 * which is the same contract resync-runner uses for captioned TikToks
 * (parseWebVTT → subtitle). Pipelines already read `fm.subtitle`.
 *
 * Resumable via .roost/cache/transcript-fetch-cache.json — successful
 * transcriptions (and confirmed no-speech videos) are persisted so a re-run
 * skips them. Notes already stamped with an up-to-date
 * `enrichment_v_transcript` are also skipped.
 *
 * Mirrors media-backfill structure: re-entrancy guard, vaultBasePath, a
 * resumable JSON cache, walkDir, queue construction, per-item write
 * resilience, periodic flush, and a Notice summary.
 *
 * Triggered from the Obsidian command palette: "Backfill video transcripts".
 */
import * as fs from "fs";
import * as path from "path";
import { Notice, requestUrl } from "obsidian";
import { EMBED_URL } from "@/config";
import { vaultBasePath, buildFileIndex } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import { walkDir } from "@/lib/fs-walk";
import { updateNoteFrontmatter } from "@/lib/vault-helpers";
import type { IRoostPlugin } from "@/types/plugin";
import type { TFile } from "obsidian";
// TYPE-only import: a runtime import of @/lib/enrichments would create a
// require cycle (enrichments.ts imports this module for TRANSCRIPT_ENRICHMENT).
import type { EnrichmentDef } from "@/lib/enrichments";

const TRANSCRIPT_SCHEMA_VERSION = 1;

interface TranscriptCacheEntry {
  ok: boolean;
  reason?: string;
  noSpeech?: boolean;
  fetchedAt: number;   // unix seconds
}
type TranscriptCache = Record<string, TranscriptCacheEntry>;

interface QueueItem {
  id: string;
  attachFolder: string;
  videoPath: string;
  note: TFile | undefined;
}

let backfillRunning = false;

export async function runTranscriptBackfill(
  plugin: IRoostPlugin,
  opts?: { onLog?: (m: string) => void; signal?: { stopped: boolean } },
): Promise<void> {
  if (backfillRunning) {
    new Notice("Transcript backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
    const log = opts?.onLog ?? ((m: string) => plugin.fireLog("[transcript-backfill] " + m));

    // Probe ASR availability before doing any work.
    let asrAvailable = false;
    try {
      const res = await requestUrl({ url: `${EMBED_URL}/api/tags`, method: "GET" });
      asrAvailable = res.json?.asr_available === true;
    } catch {
      asrAvailable = false;
    }
    if (!asrAvailable) {
      new Notice("Transcription needs the embedding sidecar with faster-whisper — run Roost setup to install it.");
      return;
    }

    const vaultRoot = vaultBasePath(plugin.app.vault);
    if (!vaultRoot) { new Notice("Transcript backfill failed: cannot locate vault path."); return; }
    const roostDir = cacheDir(vaultRoot);
    fs.mkdirSync(roostDir, { recursive: true });
    const cachePath = path.join(roostDir, "transcript-fetch-cache.json");

    const cache: TranscriptCache = (() => {
      try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
    })();
    const now = () => Math.floor(Date.now() / 1000);

    const index = buildFileIndex(plugin.app, plugin.settings.syncFolder);

    const queue: QueueItem[] = [];
    let cacheHits = 0, alreadyStamped = 0;

    const tiktokRoot = path.join(vaultRoot, plugin.settings.syncFolder, "TikTok");
    if (fs.existsSync(tiktokRoot)) {
      walkDir(tiktokRoot, (filePath) => {
        if (!filePath.endsWith("raw.json")) return;
        const attachFolder = path.dirname(filePath);
        const dirName = path.basename(attachFolder);
        if (!dirName.startsWith("tiktok-")) return;
        const id = dirName.replace(/^tiktok-/, "");
        const cacheKey = `tiktok:${id}`;

        // Candidate iff the attach folder has the video but no caption track.
        let childNames: Set<string>;
        try {
          childNames = new Set(fs.readdirSync(attachFolder));
        } catch { return; }
        if (!isTranscriptCandidate(childNames)) return;

        // Resumable: already transcribed (or confirmed no-speech) on a prior run.
        if (cache[cacheKey]?.ok) { cacheHits++; return; }

        // Already stamped at an up-to-date schema version → skip.
        const note = index.get(cacheKey);
        if (note) {
          const fm = plugin.app.metadataCache.getFileCache(note)?.frontmatter;
          if (typeof fm?.enrichment_v_transcript === "number" && fm.enrichment_v_transcript >= TRANSCRIPT_SCHEMA_VERSION) {
            alreadyStamped++;
            return;
          }
        }

        queue.push({ id, attachFolder, videoPath: path.join(attachFolder, "video.mp4"), note });
      });
    }

    if (queue.length === 0) {
      new Notice(`No transcripts to backfill (${alreadyStamped} already stamped, ${cacheHits} cache hits)`);
      return;
    }

    log(`Queue: ${queue.length} TikTok videos (skipped ${alreadyStamped} stamped, ${cacheHits} cache hits)`);
    new Notice(`Transcribing ${queue.length} TikTok videos…`);

    let written = 0, noSpeech = 0, failed = 0;
    for (let i = 0; i < queue.length; i++) {
      if (opts?.signal?.stopped) { log("stopped by signal"); break; }
      const q = queue[i];
      const key = `tiktok:${q.id}`;

      let resp: { text?: string; vtt?: string; no_speech?: boolean };
      try {
        const res = await requestUrl({
          url: `${EMBED_URL}/transcribe`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: q.videoPath }),
        });
        if (res.status >= 300) {
          cache[key] = { ok: false, reason: `http-${res.status}`, fetchedAt: now() };
          failed++;
          log(`transcribe failed for ${key}: http ${res.status}`);
          continue;
        }
        resp = res.json as { text?: string; vtt?: string; no_speech?: boolean };
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message.slice(0, 80) : "error";
        cache[key] = { ok: false, reason, fetchedAt: now() };
        failed++;
        log(`transcribe failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      const decision = decideTranscript(resp);
      if (decision === "skip-nospeech") {
        // No real speech — stamp the note (if any) so it isn't re-scanned, but
        // write no transcript.
        if (q.note) {
          try {
            const content = await plugin.app.vault.read(q.note);
            const updated = updateNoteFrontmatter(content, { enrichment_v_transcript: TRANSCRIPT_SCHEMA_VERSION });
            if (updated) await plugin.app.vault.modify(q.note, updated);
          } catch (e: unknown) {
            log(`stamp failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        cache[key] = { ok: true, noSpeech: true, fetchedAt: now() };
        noSpeech++;
      } else {
        // Write the VTT sidecar (vault-relative path) + set subtitle frontmatter.
        try {
          const relVttPath = `${plugin.settings.syncFolder}/TikTok/tiktok-${q.id}/subtitle.vtt`;
          await plugin.app.vault.adapter.write(relVttPath, resp.vtt!);
          if (q.note) {
            const content = await plugin.app.vault.read(q.note);
            const updated = updateNoteFrontmatter(content, {
              subtitle: resp.text!,
              enrichment_v_transcript: TRANSCRIPT_SCHEMA_VERSION,
            });
            if (updated) await plugin.app.vault.modify(q.note, updated);
          }
          cache[key] = { ok: true, fetchedAt: now() };
          written++;
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message.slice(0, 80) : "error";
          cache[key] = { ok: false, reason, fetchedAt: now() };
          failed++;
          log(`write failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Periodic cache flush + progress log.
      if ((i + 1) % 10 === 0 || i + 1 === queue.length) {
        log(`Progress: ${i + 1}/${queue.length} (${written} written, ${noSpeech} no-speech, ${failed} failed)`);
        try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); }
        catch { /* best-effort */ }
      }
    }
    try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); }
    catch { /* best-effort */ }

    const summary = `Transcripts: ${written} written, ${noSpeech} no-speech, ${failed} failed`;
    log(summary);
    new Notice(summary);
  } finally {
    backfillRunning = false;
  }
}

export const TRANSCRIPT_ENRICHMENT: EnrichmentDef = {
  id: "transcript",
  displayName: "Video transcripts",
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  commandId: "backfill-transcripts",
  commandName: "Backfill video transcripts",
  // The registry invokes runBackfill(plugin) with no opts (see
  // register-roost-commands.ts), so the opts shape never actually flows in at
  // runtime. The cast bridges this driver's plan-specified opts type
  // ({ signal?: { stopped: boolean } }) to EnrichmentDef's BackfillOpts
  // (signal?: AbortSignal); the two signal shapes are structurally distinct.
  runBackfill: runTranscriptBackfill as EnrichmentDef["runBackfill"],
  panelDetail: "TikTok videos with no caption track. Transcribe them locally (faster-whisper) so the recipe and other pipelines can read the speech.",
};

// ── pure helpers (unit-testable without fs/HTTP, shared with the driver) ──────

/** A TikTok attach folder needs a transcript iff it has the video but no caption track. */
export function isTranscriptCandidate(fileNames: Set<string>): boolean {
  return fileNames.has("video.mp4") && !fileNames.has("subtitle.vtt");
}

/** Decide what to do with a /transcribe response. */
export function decideTranscript(resp: { text?: string; vtt?: string; no_speech?: boolean }): "write" | "skip-nospeech" {
  const text = (resp.text ?? "").trim();
  if (resp.no_speech === true || text.length === 0 || !resp.vtt) return "skip-nospeech";
  return "write";
}
