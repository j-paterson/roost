/**
 * Shared sync runner — extracted from RoostView.handleSync so both the
 * legacy sidebar UI and the new Hub cards can drive a sync without
 * duplicating logic. Caller provides the mount target (where the webview
 * should be visible during sync) and callbacks for progress / logging.
 *
 * The runner does NOT touch React state. Callers translate progress
 * events into whatever UI updates make sense in their context.
 */
import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type {
  Platform,
  StopSignal,
  SyncPhaseProgress,
} from "@/types/sync";
import type { NormalizedRecord } from "@/lib/normalize";
import { getPlatform } from "@/platforms/registry";
import { VaultWriter } from "@/sync/vault-writer";
import { findBinary } from "@/integrations/detect";
import { ensureBasesFiles } from "@/sync/bases-setup";
import { waitForMetadataQuiet } from "@/lib/metadata-cache-quiet";

export interface RunPlatformSyncOpts {
  /** Plugin + app handles. */
  plugin: IRoostPlugin;
  app: App;
  /** Which platform to sync. */
  platform: Platform;
  /** DOM element to mount the webview into during sync. After the sync
   *  completes (success or failure), the webview is returned to the
   *  manager's hidden container automatically. */
  mountTarget: HTMLElement;
  /** Stop signal observers can set to cancel the sync. */
  signal: StopSignal;
  /** Progress callback — fires during scrolling phases. */
  onProgress?: (p: SyncPhaseProgress) => void;
  /** Batch-written callback — fires each time a batch of records is
   *  persisted to disk. */
  onBatchWritten?: (counts: { pushed: number; resynced: number; totalPushed: number; totalSkipped: number }) => void;
  /** Log line callback — receives status strings. */
  onLog?: (msg: string) => void;
  /** Suppress the "Sync complete" Notice (e.g. when the caller wants to
   *  combine multiple platforms into one summary). */
  suppressNotice?: boolean;
  /** Override settings.fastSyncMode for this sync. When true, skip in-line
   *  thread + article enrichment (X only — no effect on TikTok). When
   *  undefined, the call falls back to the persisted setting. */
  fastMode?: boolean;
}

export interface RunPlatformSyncResult {
  /** Whether the sync ran to completion without being stopped. */
  completed: boolean;
  /** Items written to vault during this run. */
  pushed: number;
  /** Items skipped (already synced). */
  skipped: number;
  /** Items re-synced (existing, but updated). */
  resynced: number;
}

/**
 * Run a single platform sync end-to-end. Mounts the platform webview into
 * `mountTarget`, awaits the sync, persists settings, unmounts on completion.
 * Safe to call concurrently for different platforms (they have separate
 * webviews and writers).
 */
export async function runPlatformSync(opts: RunPlatformSyncOpts): Promise<RunPlatformSyncResult> {
  const { plugin, app, platform, mountTarget, signal, onProgress, onBatchWritten, onLog, suppressNotice, fastMode } = opts;
  const effectiveFastMode = fastMode ?? plugin.settings.fastSyncMode;
  const log = (m: string) => { onLog?.(m); };

  const wm = plugin.getWebviewManager();
  // Mount before the dom-ready wait so the webview's first render happens
  // in the visible target rather than the hidden manager container.
  wm.mount(platform, mountTarget);
  const el = wm.getElement(platform);
  if (!el) {
    log(`[FAIL] No webview element for ${platform}`);
    return { completed: false, pushed: 0, skipped: 0, resynced: 0 };
  }

  let wc = wm.getWebContents(platform);
  if (!wc) {
    log(`Waiting for ${platform} webview...`);
    await new Promise<void>((r) => {
      const check = () => {
        wc = wm.getWebContents(platform);
        if (wc) r();
        else setTimeout(check, 500);
      };
      setTimeout(check, 500);
      setTimeout(r, 15000);
    });
    wc = wm.getWebContents(platform);
  }
  if (!wc) {
    log(`[FAIL] Webview for ${platform} not ready`);
    wm.unmount(platform);
    return { completed: false, pushed: 0, skipped: 0, resynced: 0 };
  }

  await ensureBasesFiles(app.vault, plugin.settings.syncFolder);

  const redditFfmpegPath = findBinary("ffmpeg") ?? undefined;

  const writer = new VaultWriter({
    vault: app.vault,
    syncFolder: plugin.settings.syncFolder,
    metadataCache: app.metadataCache,
    // Only the TikTok webview belongs here — VaultIndex.scanIncompleteIds reads this
    // for TikTok notes regardless of the active sync platform, so a Twitter webview
    // here would mis-classify TikTok media-missing items. Strict-parity guard.
    tiktokWebview: platform === "tiktok" ? wc : undefined,
    instagramWebview: platform === "instagram" ? wc : undefined,
    redditFfmpegPath,
    onLog: log,
  });

  let totalPushed = 0;
  let totalSkipped = 0;
  let totalResynced = 0;
  let syncCompleted = false;
  const prevSync = plugin.settings.syncState?.[platform];
  const prevComplete = prevSync?.complete === true;

  const existingIds = await writer.getExistingIds();
  const incompleteScan = await writer.scanIncompleteIds();
  const incompleteIds = incompleteScan.all;
  plugin.lastIncompleteScan = incompleteScan.byCategory;

  const platformIds = [...existingIds].filter((id) => id.startsWith(platform + ":"));
  const totalCount = platformIds.length;
  const bc = incompleteScan.byCategory;
  const breakdownParts: string[] = [];
  if (bc.rawJson.size) breakdownParts.push(`${bc.rawJson.size} raw-json`);
  if (bc.mediaFiles.size) breakdownParts.push(`${bc.mediaFiles.size} media`);
  if (bc.thread.size) breakdownParts.push(`${bc.thread.size} thread`);
  if (bc.articleBody.size) breakdownParts.push(`${bc.articleBody.size} article-body`);
  const breakdown = breakdownParts.length ? `: ${breakdownParts.join(" · ")}` : "";
  log(`${totalCount} existing ${platform} bookmarks (${incompleteIds.size} need resync${breakdown})`);
  await wc.executeJavaScript(
    `window.__ROOST_KNOWN_IDS__=new Set(${JSON.stringify(platformIds)});window.__ROOST_PREV_SYNC_COMPLETE__=${JSON.stringify(prevComplete)};void 0;`,
  ).catch(() => {});

  // Suppress per-write gallery + folder-tree rebuilds for the duration of the
  // sync (the tree re-scans all notes off the metadata cache on every "resolved"
  // — thrashing the UI when bulk-writing into a large vault). Mirrors
  // runJobWithBulkWriteFlag: the finally settles + drops the flag once, so the
  // tree/gallery reconcile a single time when the sync ends. Nesting-safe via
  // bulkWasOn (an outer Smart Assign scope, if any, owns the settle).
  const bulkWasOn = plugin.bulkWriteInProgress;
  if (!bulkWasOn) plugin.bulkWriteInProgress = true;

  try {
    const onRecords = async (records: NormalizedRecord[]) => {
      if (signal.stopped) return;
      const { pushed, skipped, resynced } = await writer.writeBatch(records, signal);
      totalPushed += pushed;
      totalSkipped += skipped;
      totalResynced += resynced;
      onBatchWritten?.({ pushed, resynced, totalPushed, totalSkipped });
      if (pushed > 0 || resynced > 0) log(`Wrote ${pushed} new, ${resynced} resynced (${totalPushed} total, ${totalSkipped} skipped)`);
      else if (skipped > 0) log(`Batch: ${skipped} already synced`);
    };

    const desc = getPlatform(platform);
    if (!desc.sync) {
      log(`[${platform}] no sync function — skipping`);
    } else {
      await desc.sync(
        wc,
        el,
        {
          stopSignal: signal,
          hydrateCachedThread: (r) => writer.hydrateThreadFromCache(r),
          fastSyncMode: effectiveFastMode,
        },
        onProgress,
        onRecords,
        log,
      );

      syncCompleted = !signal.stopped;
      log(`Sync complete: ${totalPushed} new, ${totalSkipped} skipped`);
      if (!suppressNotice) {
        new Notice(`${platform} sync complete: ${totalPushed} new bookmarks`);
      }
    }
  } catch (e: unknown) {
    log(`[ERROR] ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (!plugin.settings.syncState) plugin.settings.syncState = {};
    plugin.settings.syncState[platform] = {
      complete: syncCompleted,
      count: totalPushed + (prevSync?.count || 0),
      timestamp: Date.now(),
    };
    await plugin.saveSettings();
    wm.unmount(platform);
    if (!bulkWasOn) {
      // Let the final batch of frontmatter writes settle, then drop the flag
      // and trigger exactly one gallery rebuild + tree reconcile.
      await waitForMetadataQuiet(app.metadataCache);
      plugin.bulkWriteInProgress = false;
      plugin.fireDataRefresh();
    }
  }

  return {
    completed: syncCompleted,
    pushed: totalPushed,
    skipped: totalSkipped - totalResynced,
    resynced: totalResynced,
  };
}
