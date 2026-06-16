import { useState, useRef, useEffect } from "react";
import { App, Notice } from "obsidian";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { Platform, StopSignal, SyncPhaseProgress } from "@/types/sync";
import type { NormalizedRecord } from "@/lib/normalize";
import type { IRoostPlugin } from "@/types/plugin";
import { syncTikTok } from "@/sync/tiktok-sync";
import { syncTwitter } from "@/sync/twitter-sync";
import { VaultWriter } from "@/sync/vault-writer";
import { importFromEagle, getEagleLibraryPath } from "@/sync/eagle-import";
import { ensureBasesFiles } from "@/sync/bases-setup";

export interface UseRoostPlatformSyncParams {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  scanLibrary: () => void | Promise<void>;
}

export function useRoostPlatformSync({ app, plugin, log, scanLibrary }: UseRoostPlatformSyncParams) {
  const [syncingPlatform, setSyncingPlatform] = useState<Platform | null>(null);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [activePlatform, setActivePlatform] = useState<Platform | null>(null);
  const stopSignalRef = useRef<StopSignal | null>(null);

  const syncing = syncingPlatform != null || importing;

  function showPlatform(platform: Platform) {
    setActivePlatform(platform);
    plugin.openWebview(platform);
  }

  function hidePlatform() {
    plugin.closeWebview();
    setActivePlatform(null);
  }

  async function handleSync(platform: Platform) {
    if (syncing) return;
    const wm = plugin.getWebviewManager();
    showPlatform(platform);
    const el = wm.getElement(platform);
    if (!el) return;

    let wc = wm.getWebContents(platform);
    if (!wc) {
      log(`Waiting for ${platform} webview...`);
      await new Promise<void>(r => {
        const c = () => {
          wc = wm.getWebContents(platform);
          if (wc) r();
          else setTimeout(c, 500);
        };
        setTimeout(c, 500);
        setTimeout(r, 15000);
      });
      wc = wm.getWebContents(platform);
    }
    if (!wc) {
      log(`[FAIL] Webview for ${platform} not ready`);
      return;
    }

    setSyncingPlatform(platform);
    await ensureBasesFiles(app.vault, plugin.settings.syncFolder);
    const signal: StopSignal = {
      stopped: false,
      stop() {
        this.stopped = true;
        log("Stop requested...");
      },
    };
    stopSignalRef.current = signal;

    const writer = new VaultWriter({
      vault: app.vault,
      syncFolder: plugin.settings.syncFolder,
      metadataCache: app.metadataCache,
      tiktokWebview: platform === "tiktok" ? wc : undefined,
      onLog: log,
    });
    let totalPushed = 0;
    let syncCompleted = false;
    const prevSync = plugin.settings.syncState?.[platform];
    const prevComplete = prevSync?.complete === true;

    const existingIds = await writer.getExistingIds();
    const incompleteScan = await writer.scanIncompleteIds();
    const incompleteIds = incompleteScan.all;
    // Cache the breakdown on the plugin so the hub can render per-platform
    // backlog rows without re-running the (full-vault) scan.
    plugin.lastIncompleteScan = incompleteScan.byCategory;
    // Treat all existing items as "known" for the scroll early-out. Items that
    // need enrichment (thread-probe, missing media) are scattered throughout
    // the timeline; if we disqualified them from "known", the consecutive-
    // known-batches counter resets every time the scroll hits one, and early-
    // out never triggers — sync grinds through the entire 11K-item timeline
    // every time. Enrichment runs on pendingAll regardless (post-scroll Step 5)
    // so disqualifying-because-incomplete didn't actually help enrich them; it
    // just made sync slower. Items needing enrichment that aren't in pendingAll
    // are picked up via dedicated backfill commands (article backfill) or the
    // next sync that happens to scroll over them.
    //
    // Items missing raw.json entirely are still tracked separately if a future
    // backfill needs them — but they don't disqualify early-out either.
    const platformIds = [...existingIds].filter(id => id.startsWith(platform + ":"));
    const totalCount = platformIds.length;
    // Per-enrichment breakdown of what `need resync` actually covers, so the
    // user can tell at a glance which backfill (thread, media, article-body)
    // is on the hook this run. Empty buckets are omitted; if everything is
    // already enriched the suffix shrinks to "(0 need resync)".
    const bc = incompleteScan.byCategory;
    const breakdownParts: string[] = [];
    if (bc.rawJson.size) breakdownParts.push(`${bc.rawJson.size} raw-json`);
    if (bc.mediaFiles.size) breakdownParts.push(`${bc.mediaFiles.size} media`);
    if (bc.thread.size) breakdownParts.push(`${bc.thread.size} thread`);
    if (bc.articleBody.size) breakdownParts.push(`${bc.articleBody.size} article-body`);
    const breakdown = breakdownParts.length ? `: ${breakdownParts.join(" · ")}` : "";
    log(`${totalCount} existing ${platform} bookmarks (${incompleteIds.size} need resync${breakdown})`);
    await wc
      .executeJavaScript(
        `window.__ROOST_KNOWN_IDS__=new Set(${JSON.stringify(platformIds)});window.__ROOST_PREV_SYNC_COMPLETE__=${JSON.stringify(prevComplete)};void 0;`,
      )
      .catch(() => {});

    try {
      const onProgress = (p: SyncPhaseProgress) => {
        setSyncStatus(`${p.phase}`);
        setSyncProgress({ phase: p.phase, count: p.count, total: p.total, written: totalPushed, skipped: 0, resynced: 0 });
      };
      let totalSkipped = 0;
      let totalResynced = 0;
      const onRecords = async (records: NormalizedRecord[]) => {
        if (signal.stopped) return;
        const { pushed, skipped, resynced } = await writer.writeBatch(records, signal);
        totalPushed += pushed;
        totalSkipped += skipped;
        totalResynced += resynced;
        setSyncProgress(prev =>
          prev
            ? { ...prev, written: totalPushed, skipped: totalSkipped - totalResynced, resynced: totalResynced }
            : null,
        );
        if (pushed > 0 || resynced > 0) {
          log(`Wrote ${pushed} new, ${resynced} resynced (${totalPushed} total, ${totalSkipped} skipped)`);
        } else if (skipped > 0) {
          log(`Batch: ${skipped} already synced`);
        }
      };

      if (platform === "tiktok") {
        await syncTikTok(wc, el, { stopSignal: signal }, onProgress, onRecords, log);
      } else {
        await syncTwitter(
          wc,
          el,
          {
            stopSignal: signal,
            hydrateCachedThread: r => writer.hydrateThreadFromCache(r),
            fastSyncMode: plugin.settings.fastSyncMode,
          },
          onProgress,
          onRecords,
          log,
        );
      }

      syncCompleted = !signal.stopped;
      log(`Sync complete: ${totalPushed} new, ${totalSkipped} skipped`);
      new Notice(`Sync complete: ${totalPushed} new bookmarks`);
      scanLibrary();
      await ensureBasesFiles(app.vault, plugin.settings.syncFolder);
      // Refresh pending-pipeline counts post-sync and auto-enqueue any work.
      plugin.refreshPendingPipelines();
      void plugin.autoEnqueuePendingPipelines();
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
      setSyncingPlatform(null);
      stopSignalRef.current = null;
      setSyncStatus("");
      setSyncProgress(null);
    }
  }

  async function handleImportFromEagle() {
    let libPath = plugin.settings.eagleLibraryPath;
    if (!libPath && plugin.settings.eagleToken) libPath = (await getEagleLibraryPath(plugin.settings.eagleToken)) || "";
    if (!libPath) {
      new Notice("Set Eagle library path in plugin settings");
      return;
    }
    setImporting(true);
    setSyncStatus("Importing from Eagle...");
    await ensureBasesFiles(app.vault, plugin.settings.syncFolder);
    try {
      const result = await importFromEagle({
        vault: app.vault,
        syncFolder: plugin.settings.syncFolder,
        eagleLibraryPath: libPath,
        onProgress: (c, t, n) => setSyncStatus(`${c}/${t}: ${n}`),
        onLog: log,
      });
      log(`Import: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`);
      new Notice(`Eagle import: ${result.imported} imported`);
      await ensureBasesFiles(app.vault, plugin.settings.syncFolder);
    } catch (e: unknown) {
      log(`[ERROR] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
      setSyncStatus("");
    }
  }

  // Subscribe to workspace events dispatched by the hub (runSync / runEagleImport).
  // Handlers are stashed in refs so the effect deps stay stable — handleSync
  // and handleImportFromEagle are redeclared every render, but we want the
  // workspace listener registered exactly once. The `as never` cast is
  // required because Obsidian's typed .on() overloads don't accept arbitrary
  // event names.
  const handleSyncRef = useRef(handleSync);
  const handleImportFromEagleRef = useRef(handleImportFromEagle);
  handleSyncRef.current = handleSync;
  handleImportFromEagleRef.current = handleImportFromEagle;
  useEffect(() => {
    const syncHandler = (platform: unknown) => {
      if (platform === "tiktok" || platform === "twitter") {
        void handleSyncRef.current(platform);
      }
    };
    const eagleHandler = () => {
      void handleImportFromEagleRef.current();
    };
    const syncRef = app.workspace.on("roost:request-sync" as never, syncHandler);
    const eagleRef = app.workspace.on("roost:request-eagle-import" as never, eagleHandler);
    return () => {
      app.workspace.offref(syncRef);
      app.workspace.offref(eagleRef);
    };
  }, [app]);

  return {
    syncingPlatform,
    importing,
    activePlatform,
    syncStatus,
    syncProgress,
    setSyncProgress,
    stopSignalRef,
    syncing,
    showPlatform,
    hidePlatform,
    handleSync,
    handleImportFromEagle,
  };
}
