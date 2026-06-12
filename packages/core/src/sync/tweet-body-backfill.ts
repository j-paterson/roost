/**
 * One-shot backfill: walk all X tweet raw.json files and re-render every note
 * body as formatted markdown via the `tweetBody` renderer (links, quotes,
 * thread structure). This is the user's "reimport" for tweet text fidelity.
 *
 * No network: it only re-renders the existing raw.json into the note body via
 * `rewriteNoteBody` (idempotent — `newContent === existing` → no write) and
 * stamps `enrichment_v_tweetBody`. The `card.png` gallery cover is untouched.
 *
 * X Articles are skipped entirely (Decision 4 — articles already render real
 * markdown and must stay byte-identical).
 *
 * Mirrors media-backfill.ts structure: walkDir over Bookmarks/X, queue
 * construction, VaultWriter acquisition, per-item write resilience.
 *
 * Triggered from the Obsidian command palette: "Render X tweet bodies".
 */
import * as fs from "fs";
import * as path from "path";
import { Notice } from "obsidian";
import { VaultWriter } from "@/sync/vault-writer";
import type { NormalizedRecord } from "@/lib/normalize";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import { walkDir } from "@/lib/fs-walk";
import { isDirectArticle } from "@/lib/tweet-render";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";

interface TweetBodyCacheEntry {
  ok: boolean;
  reason?: string;
  fetchedAt: number; // unix seconds
}
type TweetBodyCache = Record<string, TweetBodyCacheEntry>;

let backfillRunning = false;

export async function runTweetBodyBackfill(plugin: IRoostPlugin): Promise<void> {
  if (backfillRunning) {
    new Notice("Tweet body backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
    const log = (msg: string) => { plugin.fireLog("[tweet-body-backfill] " + msg); };

    const vaultRoot = vaultBasePath(plugin.app.vault);
    if (!vaultRoot) { new Notice("Tweet body backfill failed: cannot locate vault path."); return; }
    const roostDir = cacheDir(vaultRoot);
    fs.mkdirSync(roostDir, { recursive: true });
    const cachePath = path.join(roostDir, "tweet-body-cache.json");

    const cache: TweetBodyCache = (() => {
      try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
    })();
    const now = Math.floor(Date.now() / 1000);

    interface QueueItem {
      attachFolder: string;
      outerItemId: string;
      raw: Record<string, unknown>;
    }
    const queue: QueueItem[] = [];
    let cacheHits = 0, skippedArticles = 0;

    // X only — TikTok / Other notes don't use the tweet renderer.
    for (const platform of ["X"] as const) {
      const platformRoot = path.join(vaultRoot, plugin.settings.syncFolder, platform);
      if (!fs.existsSync(platformRoot)) continue;

      walkDir(platformRoot, (filePath) => {
        if (!filePath.endsWith("raw.json")) return;
        const attachFolder = path.dirname(filePath);
        const outerItemId = path.basename(attachFolder).replace(/^twitter-/, "");
        const cacheKey = `twitter:${outerItemId}`;
        if (cache[cacheKey]?.ok) { cacheHits++; return; }

        let raw: Record<string, unknown>;
        try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }

        // Decision 4 — leave X Articles untouched (they already render real
        // markdown; renderTweetBody delegates to extractBookmarkText, but we
        // skip the rewrite entirely so the note stays byte-identical).
        if (isDirectArticle({ platform: "twitter", itemId: outerItemId, rawData: raw })) {
          skippedArticles++;
          return;
        }

        queue.push({ attachFolder, outerItemId, raw });
      });
    }

    if (queue.length === 0) {
      new Notice(`No tweet bodies to render (${cacheHits} cache hits, ${skippedArticles} articles skipped)`);
      return;
    }

    log(`Queue: ${queue.length} items (skipped ${skippedArticles} articles, ${cacheHits} cache hits)`);
    new Notice(`Rendering ${queue.length} tweet bodies…`);

    const writer = new VaultWriter({
      vault: plugin.app.vault,
      syncFolder: plugin.settings.syncFolder,
      metadataCache: plugin.app.metadataCache,
      onLog: log,
    });
    // Populates notePathMap, which rewriteNoteBody / stampEnrichmentVersion need.
    await writer.scanIncompleteIds().catch(() => {});

    let succeeded = 0, failed = 0;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      const cacheKey = `twitter:${q.outerItemId}`;
      const record: NormalizedRecord = {
        id: cacheKey,
        platform: "twitter",
        itemId: q.outerItemId,
        rawData: q.raw,
        saved_at: new Date().toISOString(),
        published_at: null,
        captured_via: "backfill",
      };
      try {
        await writer.rewriteNoteBody(record);
        await writer.stampEnrichmentVersion(record.id, "tweetBody", RENDERED_TWEET_ENRICHMENT.schemaVersion);
        cache[cacheKey] = { ok: true, fetchedAt: now };
        succeeded++;
      } catch (e: unknown) {
        cache[cacheKey] = { ok: false, reason: e instanceof Error ? e.message.slice(0, 80) : "error", fetchedAt: now };
        failed++;
        log(`rewriteNoteBody failed for ${cacheKey}: ${e instanceof Error ? e.message : String(e)}`);
      }

      if ((i + 1) % 25 === 0 || i + 1 === queue.length) {
        log(`Progress: ${i + 1}/${queue.length} (${succeeded} ok, ${failed} failed)`);
        try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); }
        catch { /* best-effort */ }
      }
    }
    try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); } catch { /* best-effort */ }

    const summary = `Tweet body backfill: ${succeeded} rendered, ${failed} failed`;
    log(summary);
    new Notice(summary);
  } finally {
    backfillRunning = false;
  }
}

export const RENDERED_TWEET_ENRICHMENT: EnrichmentDef = {
  id: "tweetBody",
  displayName: "Tweet body",
  schemaVersion: 1,
  commandId: "backfill-tweet-bodies",
  commandName: "Render X tweet bodies",
  runBackfill: runTweetBodyBackfill,
  panelDetail: "X tweets whose note body is still image-only. Backfill renders the tweet text as formatted markdown (links, quotes, thread structure) into the note body.",
};
