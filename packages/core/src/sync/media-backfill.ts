/**
 * One-shot backfill: walk all bookmark raw.json files, find items with
 * incomplete media (no cover, legacy media.jpg format, or video without
 * poster), and re-run resyncRecord to download what's missing + repair the
 * gallery cover frontmatter.
 *
 * Resumable via .roost/media-fetch-cache.json — successful resyncs are
 * persisted so a re-run skips them. Cache misses re-derive the predicate
 * from the live attachFolder contents on every run; the cache exists to
 * avoid repeating the (cheap) raw.json read + resyncRecord call for items
 * already known to be complete.
 *
 * Mirrors article-backfill / thread-backfill structure: walkDir over
 * Bookmarks/{X,TikTok}, queue construction, per-item write resilience.
 *
 * Triggered from the Obsidian command palette: "Backfill bookmark media".
 */
import * as fs from "fs";
import * as path from "path";
import { Notice, TFolder, TAbstractFile } from "obsidian";
import { VaultWriter } from "@/sync/vault-writer";
import type { NormalizedRecord } from "@/lib/normalize";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import { walkDir } from "@/lib/fs-walk";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";

interface MediaCacheEntry {
  ok: boolean;
  reason?: string;
  fetchedAt: number;   // unix seconds
}
type MediaCache = Record<string, MediaCacheEntry>;

let backfillRunning = false;

export async function runMediaBackfill(plugin: IRoostPlugin): Promise<void> {
  if (backfillRunning) {
    new Notice("Media backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
  const log = (msg: string) => { plugin.fireLog("[media-backfill] " + msg); };

  const vaultRoot = vaultBasePath(plugin.app.vault);
  if (!vaultRoot) { new Notice("Media backfill failed: cannot locate vault path."); return; }
  const roostDir = cacheDir(vaultRoot);
  fs.mkdirSync(roostDir, { recursive: true });
  const cachePath = path.join(roostDir, "media-fetch-cache.json");

  const cache: MediaCache = (() => {
    try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
  })();
  const now = Math.floor(Date.now() / 1000);

  // Walk Bookmarks/X and Bookmarks/TikTok and find items needing media.
  // Predicate mirrors scanIncompleteIds: no media at all, legacy media.jpg
  // format, or video tweet missing its poster.
  interface QueueItem {
    rawPath: string;
    attachFolder: string;
    platform: "twitter" | "tiktok";
    outerItemId: string;
    raw: Record<string, unknown>;
  }
  const queue: QueueItem[] = [];
  let cacheHits = 0, alreadyComplete = 0;

  const tiktokWcAvailable = !!plugin.getWebviewManager().getWebContents("tiktok");

  for (const platform of ["X", "TikTok"] as const) {
    const platformRoot = path.join(vaultRoot, plugin.settings.syncFolder, platform);
    if (!fs.existsSync(platformRoot)) continue;

    walkDir(platformRoot, (filePath) => {
      if (!filePath.endsWith("raw.json")) return;
      const attachFolder = path.dirname(filePath);
      const outerDirName = path.basename(attachFolder);
      const platformId: "twitter" | "tiktok" = platform === "X" ? "twitter" : "tiktok";
      const prefix = platformId === "twitter" ? "twitter-" : "tiktok-";
      const outerItemId = outerDirName.replace(new RegExp("^" + prefix), "");
      const cacheKey = `${platformId}:${outerItemId}`;
      if (cache[cacheKey]?.ok) { cacheHits++; return; }

      // Inspect attachFolder contents to apply the same predicate as
      // scanIncompleteIds.
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(attachFolder, { withFileTypes: true }); } catch { return; }
      const childNames = new Set(entries.filter(e => e.isFile()).map(e => e.name));
      const hasMedia = [...childNames].some(n => n.endsWith(".jpg") || n.endsWith(".mp4") || n.endsWith(".png"));

      let needs = false;
      if (!hasMedia) {
        // TikTok video items only flag when the live webview is available;
        // otherwise the video re-download would just fail.
        if (platformId === "twitter" || tiktokWcAvailable) needs = true;
      } else if (platformId === "twitter" && !childNames.has("1.jpg") && (childNames.has("media.jpg") || childNames.has("thumb.png"))) {
        needs = true;
      } else if (platformId === "twitter" && childNames.has("video.mp4") && !childNames.has("video-poster.jpg")) {
        needs = true;
      }
      if (!needs) { alreadyComplete++; return; }

      let raw: Record<string, unknown>;
      try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
      queue.push({ rawPath: filePath, attachFolder, platform: platformId, outerItemId, raw });
    });
  }

  if (queue.length === 0) {
    new Notice(`No media to backfill (${alreadyComplete} already complete, ${cacheHits} cache hits)`);
    return;
  }

  log(`Queue: ${queue.length} items (skipped ${alreadyComplete} complete, ${cacheHits} cache hits)`);
  new Notice(`Backfilling ${queue.length} items with missing media…`);

  // 3. Set up VaultWriter with TikTok webview (needed for video downloads).
  //    Wires up tiktokWebview so resyncRecord's TikTok branch can pull videos
  //    via the probe.
  const wm = plugin.getWebviewManager();
  const tiktokWebview = wm.getElement("tiktok") ?? undefined;
  const writer = new VaultWriter({
    vault: plugin.app.vault,
    syncFolder: plugin.settings.syncFolder,
    metadataCache: plugin.app.metadataCache,
    tiktokWebview,
    onLog: log,
  });
  await writer.scanIncompleteIds().catch(() => {});

  // 4. Per-item resyncRecord. resyncRecord owns the full media + note re-render
  //    pipeline; downloadAndSave skips files that already exist on disk so
  //    items whose problem was just a missing poster don't re-fetch the video.
  let succeeded = 0, failed = 0;
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    const cacheKey = `${q.platform}:${q.outerItemId}`;
    const record: NormalizedRecord = {
      id: cacheKey,
      platform: q.platform,
      itemId: q.outerItemId,
      rawData: q.raw,
      saved_at: new Date().toISOString(),
      published_at: null,
      captured_via: "backfill",
    };
    try {
      await writer.resyncRecord(record);
      // Verify the resync actually filled the gap. Re-read the folder and
      // check the predicate; if still incomplete, mark as failed so the next
      // run retries.
      const folder = plugin.app.vault.getAbstractFileByPath(`${plugin.settings.syncFolder}/${q.platform === "twitter" ? "X" : "TikTok"}/${q.platform}-${q.outerItemId}`);
      const stillNeeds = folder instanceof TFolder ? checkStillIncomplete(folder, q.platform) : true;
      if (stillNeeds) {
        cache[cacheKey] = { ok: false, reason: "incomplete_after_resync", fetchedAt: now };
        failed++;
      } else {
        cache[cacheKey] = { ok: true, fetchedAt: now };
        await writer.stampEnrichmentVersion(record.id, "mediaFiles", MEDIA_ENRICHMENT.schemaVersion);
        succeeded++;
      }
    } catch (e: unknown) {
      cache[cacheKey] = { ok: false, reason: e instanceof Error ? e.message.slice(0, 80) : "error", fetchedAt: now };
      failed++;
      log(`resyncRecord failed for ${cacheKey}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Periodic cache flush + log.
    if ((i + 1) % 10 === 0 || i + 1 === queue.length) {
      log(`Progress: ${i + 1}/${queue.length} (${succeeded} ok, ${failed} failed)`);
      try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); }
      catch { /* best-effort */ }
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  const summary = `Media backfill: ${succeeded} succeeded, ${failed} failed`;
  log(summary);
  new Notice(summary);
  } finally {
    backfillRunning = false;
  }
}

export const MEDIA_ENRICHMENT: EnrichmentDef = {
  id: "mediaFiles",
  displayName: "Media files",
  schemaVersion: 1,
  commandId: "backfill-media",
  commandName: "Backfill bookmark media",
  runBackfill: runMediaBackfill,
  panelDetail: "Cover images, videos, or video posters not yet downloaded. Backfill re-fetches what's missing.",
  legacyAliases: ["enrichment_v_media"],
};

// ── helpers ───────────────────────────────────────────────────────────────────

/** True if the folder still trips the scanIncompleteIds media predicate. */
function checkStillIncomplete(folder: TFolder, platform: "twitter" | "tiktok"): boolean {
  const children: TAbstractFile[] = folder.children;
  const names = new Set(children.map(c => c.name));
  const hasMedia = children.some(c =>
    c.name.endsWith(".jpg") || c.name.endsWith(".mp4") || c.name.endsWith(".png"),
  );
  if (!hasMedia) return true;
  if (platform === "twitter" && !names.has("1.jpg") && (names.has("media.jpg") || names.has("thumb.png"))) return true;
  if (platform === "twitter" && names.has("video.mp4") && !names.has("video-poster.jpg")) return true;
  return false;
}

