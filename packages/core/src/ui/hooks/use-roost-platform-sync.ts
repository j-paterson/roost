import { useState, useRef, useEffect, type RefObject } from "react";
import { App, Notice } from "obsidian";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { Platform, StopSignal, SyncPhaseProgress } from "@/types/sync";
import type { NormalizedRecord } from "@/lib/normalize";
import type { IRoostPlugin } from "@/types/plugin";
import { getPlatform, PLATFORMS } from "@/platforms/registry";
import { resolveSyncMode, type SyncMode } from "@/sync/sync-mode";
import { VaultWriter } from "@/sync/vault-writer";
import { importFromEagle, getEagleLibraryPath } from "@/sync/eagle-import";
import { ensureBasesFiles } from "@/sync/bases-setup";
import { waitForMetadataQuiet } from "@/lib/metadata-cache-quiet";

export interface UseRoostPlatformSyncParams {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  scanLibrary: () => void | Promise<void>;
  /** Slot to dock the platform webview into as a miniature preview during sync
   *  (instead of opening the full site in a new tab). Absent → falls back to the
   *  full webview leaf. */
  miniMountRef?: RefObject<HTMLDivElement | null>;
}

export function useRoostPlatformSync({ app, plugin, log, scanLibrary, miniMountRef }: UseRoostPlatformSyncParams) {
  const [syncingPlatform, setSyncingPlatform] = useState<Platform | null>(null);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [activePlatform, setActivePlatform] = useState<Platform | null>(null);
  const [queuedPlatforms, setQueuedPlatforms] = useState<Platform[]>([]);
  const stopSignalRef = useRef<StopSignal | null>(null);
  // Sync queue: platforms waiting to run. runQueueRef.current holds the pending
  // list; processingQueueRef guards a single serial drainer so two clicks never
  // sync concurrently (concurrent webview scrapes conflict).
  const runQueueRef = useRef<Platform[]>([]);
  const processingQueueRef = useRef(false);
  // Synchronous mirror of the running platform — dedupe can't rely on the async
  // syncingPlatform state (a fast second click would slip through before it commits).
  const runningPlatformRef = useRef<Platform | null>(null);

  const syncing = syncingPlatform != null || importing;

  function showPlatform(platform: Platform) {
    setActivePlatform(platform);
    plugin.openWebview(platform);
  }

  function hidePlatform() {
    plugin.closeWebview();
    setActivePlatform(null);
  }

  async function runSync(platform: Platform) {
    runningPlatformRef.current = platform;
    const wm = plugin.getWebviewManager();
    wm.create(platform);
    const el = wm.getElement(platform);
    if (!el) { runningPlatformRef.current = null; return; }

    setSyncingPlatform(platform);
    // Dock the webview as a miniature preview under the sync pills (like the Hub)
    // rather than opening the full site in a new tab. Wait one frame so React has
    // painted the now-visible slot, then MOUNT BEFORE waiting on webContents — a
    // webview only initializes (fires dom-ready → webContents becomes available)
    // once it's attached to visible DOM. Returned to its hidden container in the
    // finally below.
    await new Promise<void>(r => requestAnimationFrame(() => r()));
    const miniTarget = miniMountRef?.current ?? null;
    if (miniTarget) wm.mount(platform, miniTarget, { mini: true });
    else showPlatform(platform);

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
      wm.unmount(platform);
      setSyncingPlatform(null);
      runningPlatformRef.current = null;
      return;
    }

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
      // Only the TikTok webview belongs here (see run-platform-sync) — VaultIndex
      // reads it for TikTok notes regardless of active sync platform. Strict-parity guard.
      tiktokWebview: platform === "tiktok" ? wc : undefined,
      onLog: log,
    });
    let totalPushed = 0;
    let syncCompleted = false;
    const prevSync = plugin.settings.syncState?.[platform];
    const prevComplete = prevSync?.complete === true;
    const sidebarMode: SyncMode = resolveSyncMode("quick", !!prevSync, prevComplete);
    if (sidebarMode === "full") {
      log(`[${platform}] last run didn't finish (or first sync) — doing a full scan`);
    }

    const existingIds = await writer.getExistingIds();
    // Quick sync never drains the enrichment backlog, so skip the (full-vault)
    // incomplete scan — pure overhead in quick mode (matches the Hub). Full
    // rescan still runs it and refreshes the hub's cached backlog breakdown.
    const incompleteScan = sidebarMode === "full" ? await writer.scanIncompleteIds() : null;
    if (incompleteScan) plugin.lastIncompleteScan = incompleteScan.byCategory;
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
    if (incompleteScan) {
      const bc = incompleteScan.byCategory;
      const breakdownParts: string[] = [];
      if (bc.rawJson.size) breakdownParts.push(`${bc.rawJson.size} raw-json`);
      if (bc.mediaFiles.size) breakdownParts.push(`${bc.mediaFiles.size} media`);
      if (bc.thread.size) breakdownParts.push(`${bc.thread.size} thread`);
      if (bc.articleBody.size) breakdownParts.push(`${bc.articleBody.size} article-body`);
      const breakdown = breakdownParts.length ? `: ${breakdownParts.join(" · ")}` : "";
      log(`${totalCount} existing ${platform} bookmarks (${incompleteScan.all.size} need resync${breakdown})`);
    } else {
      log(`${totalCount} existing ${platform} bookmarks — quick sync`);
    }
    await wc
      .executeJavaScript(
        `window.__ROOST_KNOWN_IDS__=new Set(${JSON.stringify(platformIds)});window.__ROOST_SYNC_MODE__=${JSON.stringify(sidebarMode)};void 0;`,
      )
      .catch(() => {});

    // Suppress the gallery/tree repaint storm while notes stream in — the gallery
    // guards onDataUpdated on bulkWriteInProgress; without this the sidebar sync
    // strobes the gallery (the Hub path already does this in run-platform-sync).
    // Nesting-safe: an outer Smart Assign scope, if any, owns the settle.
    const bulkWasOn = plugin.bulkWriteInProgress;
    if (!bulkWasOn) plugin.bulkWriteInProgress = true;

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
            syncMode: sidebarMode,
          },
          onProgress,
          onRecords,
          log,
        );

        syncCompleted = !signal.stopped;
        log(`Sync complete: ${totalPushed} new, ${totalSkipped} skipped`);
        new Notice(`Sync complete: ${totalPushed} new bookmarks`);
        scanLibrary();
        await ensureBasesFiles(app.vault, plugin.settings.syncFolder);
        // Refresh pending-pipeline counts post-sync and auto-enqueue any work.
        plugin.refreshPendingPipelines();
        void plugin.autoEnqueuePendingPipelines();
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
      setSyncingPlatform(null);
      runningPlatformRef.current = null;
      stopSignalRef.current = null;
      setSyncStatus("");
      setSyncProgress(null);
      if (!bulkWasOn) {
        // Let the final frontmatter writes settle, drop the flag, then trigger
        // exactly one gallery rebuild + tree reconcile.
        await waitForMetadataQuiet(app.metadataCache);
        plugin.bulkWriteInProgress = false;
        plugin.fireDataRefresh();
      }
    }
  }

  // Public entry point. Enqueue a platform sync and kick the serial drainer.
  // Clicking a platform that is already syncing or already queued is a no-op.
  function handleSync(platform: Platform) {
    if (runningPlatformRef.current === platform || runQueueRef.current.includes(platform)) return;
    runQueueRef.current = [...runQueueRef.current, platform];
    setQueuedPlatforms(runQueueRef.current);
    void processSyncQueue();
  }

  // Drains the queue one platform at a time; a second click while a sync runs
  // appends to the queue rather than starting a concurrent (conflicting) scrape.
  async function processSyncQueue() {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    try {
      while (runQueueRef.current.length > 0) {
        const [next, ...rest] = runQueueRef.current;
        runQueueRef.current = rest;
        setQueuedPlatforms(rest);
        try {
          await runSync(next);
        } catch (e: unknown) {
          log(`[ERROR] sync ${next}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      processingQueueRef.current = false;
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
      if (typeof platform === "string" && platform in PLATFORMS) {
        void handleSyncRef.current(platform as import("@/types/sync").Platform);
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
    queuedPlatforms,
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
