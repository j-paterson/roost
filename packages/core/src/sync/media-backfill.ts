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
import { Notice } from "obsidian";
import type { NormalizedRecord } from "@/lib/normalize";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import { walkDir } from "@/lib/fs-walk";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";
import type { Platform } from "@/types/sync";
import { getPlatform, platformFolders, folderToPlatform } from "@/platforms/registry";

interface MediaCacheEntry {
  ok: boolean;
  reason?: string;
  fetchedAt: number;   // unix seconds
  attempts?: number;   // consecutive failed backfill attempts (for dead-skip)
}
type MediaCache = Record<string, MediaCacheEntry>;

let backfillRunning = false;

/** After this many consecutive failed backfill attempts, an item is treated as
 *  permanently dead (expired CDN URLs) and skipped — until a re-sync rewrites
 *  its raw.json (newer mtime than the last attempt), which clears the skip. */
const MAX_BACKFILL_ATTEMPTS = 3;

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
    platform: Platform;
    outerItemId: string;
    raw: Record<string, unknown>;
  }
  const queue: QueueItem[] = [];
  let cacheHits = 0, alreadyComplete = 0, deadSkipped = 0;

  const tiktokWcAvailable = !!plugin.getWebviewManager().getWebContents("tiktok");

  for (const folder of platformFolders()) {
    const platformRoot = path.join(vaultRoot, plugin.settings.syncFolder, folder);
    if (!fs.existsSync(platformRoot)) continue;
    const platformId = folderToPlatform(folder)!;
    const prefix = `${getPlatform(platformId).vault!.attachPrefix}-`;

    walkDir(platformRoot, (filePath) => {
      if (!filePath.endsWith("raw.json")) return;
      const attachFolder = path.dirname(filePath);
      const outerDirName = path.basename(attachFolder);
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
      } else if (platformId === "twitter" && !childNames.has("1.jpg") && !childNames.has("1.png") && !childNames.has("video.mp4") && childNames.has("media.jpg")) {
        needs = true;
      } else if (platformId === "twitter" && childNames.has("video.mp4") && !childNames.has("video-poster.jpg")) {
        needs = true;
      }
      if (!needs) { alreadyComplete++; return; }

      // Dead-URL skip: this item has failed MAX_BACKFILL_ATTEMPTS times and its
      // raw.json has NOT been rewritten since the last attempt — retrying the
      // same (expired) URLs would just grind. A later re-sync that refreshes
      // raw.json makes its mtime newer than fetchedAt, which auto-clears the skip.
      const prev = cache[cacheKey];
      if (prev && !prev.ok && (prev.attempts ?? 0) >= MAX_BACKFILL_ATTEMPTS) {
        let rawMtime = 0;
        try { rawMtime = Math.floor(fs.statSync(filePath).mtimeMs / 1000); } catch { /* */ }
        if (isDeadSkip(prev, rawMtime)) { deadSkipped++; return; }
      }

      let raw: Record<string, unknown>;
      try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
      queue.push({ rawPath: filePath, attachFolder, platform: platformId, outerItemId, raw });
    });
  }

  if (queue.length === 0) {
    new Notice(`No media to backfill (${alreadyComplete} already complete, ${cacheHits} cache hits, ${deadSkipped} dead-skipped)`);
    return;
  }

  log(`Queue: ${queue.length} items (skipped ${alreadyComplete} complete, ${cacheHits} cache hits, ${deadSkipped} dead)`);
  new Notice(`Backfilling ${queue.length} items with missing media…`);

  // 3. Set up VaultWriter with TikTok webview (needed for video downloads).
  //    Wires up tiktokWebview so resyncRecord's TikTok branch can pull videos
  //    via the probe.
  const wm = plugin.getWebviewManager();
  const tiktokWebview = wm.getElement("tiktok") ?? undefined;
  const { VaultWriter } = await import("@/sync/vault-writer");
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
  const failReasons: Record<string, number> = {};
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
      if (q.platform === "twitter") migrateLegacyTwitterMedia(q.attachFolder);
      await writer.resyncRecord(record);
      // Verify against the FILESYSTEM — the same source the queue scan uses.
      const reason = fsIncompleteReason(q.attachFolder, q.platform);
      if (reason) {
        const prevAttempts = cache[cacheKey]?.attempts ?? 0;
        cache[cacheKey] = { ok: false, reason, fetchedAt: now, attempts: prevAttempts + 1 };
        failReasons[reason] = (failReasons[reason] ?? 0) + 1;
        failed++;
        if (failed <= 5) log(`still incomplete after resync: ${cacheKey} — ${reason}`);
      } else {
        cache[cacheKey] = { ok: true, fetchedAt: now };
        await writer.stampEnrichmentVersion(record.id, "mediaFiles", MEDIA_ENRICHMENT.schemaVersion);
        succeeded++;
      }
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message.slice(0, 80) : "error";
      const prevAttempts = cache[cacheKey]?.attempts ?? 0;
      cache[cacheKey] = { ok: false, reason, fetchedAt: now, attempts: prevAttempts + 1 };
      failReasons["exception"] = (failReasons["exception"] ?? 0) + 1;
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

  const breakdown = Object.entries(failReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  const summary = `Media backfill: ${succeeded} succeeded, ${failed} failed${breakdown ? ` — ${breakdown}` : ""}`;
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

/** Re-read the attach folder from the FILESYSTEM (same source as the queue
 *  scan) and return a short reason if it still trips the media predicate, or
 *  null if it now looks complete. Using fs avoids the lag in Obsidian's
 *  in-memory folder index right after a createBinary write. */
export function fsIncompleteReason(attachFolder: string, platform: Platform): string | null {
  let names: Set<string>;
  try {
    names = new Set(
      fs.readdirSync(attachFolder, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => e.name),
    );
  } catch {
    return "folder-missing";
  }
  const hasMedia = [...names].some(n => n.endsWith(".jpg") || n.endsWith(".mp4") || n.endsWith(".png"));
  if (!hasMedia) return "no-media";
  if (platform === "twitter" && !names.has("1.jpg") && !names.has("1.png") && !names.has("video.mp4") && names.has("media.jpg")) return "legacy-no-1jpg";
  if (platform === "twitter" && names.has("video.mp4") && !names.has("video-poster.jpg")) return "video-no-poster";
  return null;
}

/** Genuine legacy single: a twitter item whose image exists only as the old
 *  media.jpg (no canonical 1.jpg, no carousel, no video, and — per raw.json —
 *  no re-fetchable URL). Copy media.jpg -> 1.jpg locally so the cover logic and
 *  the incomplete predicate recognize it. No network. Returns true if it copied. */
export function migrateLegacyTwitterMedia(attachFolder: string): boolean {
  let names: Set<string>;
  try { names = new Set(fs.readdirSync(attachFolder, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)); }
  catch { return false; }
  if (names.has("1.jpg") || names.has("1.png") || names.has("video.mp4") || !names.has("media.jpg")) return false;
  try {
    fs.copyFileSync(path.join(attachFolder, "media.jpg"), path.join(attachFolder, "1.jpg"));
    return true;
  } catch { return false; }
}

/** Pure decision for the dead-URL skip — shared by the queue scan and tests.
 *  An item is dead-skipped when it has failed at least `maxAttempts` times and
 *  its raw.json mtime is not newer than the last attempt (no fresh URLs). */
export function isDeadSkip(
  entry: { ok: boolean; attempts?: number; fetchedAt: number } | undefined,
  rawMtimeSec: number,
  maxAttempts = MAX_BACKFILL_ATTEMPTS,
): boolean {
  if (!entry || entry.ok) return false;
  if ((entry.attempts ?? 0) < maxAttempts) return false;
  return rawMtimeSec <= entry.fetchedAt;
}

