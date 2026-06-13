import { useEffect, useRef, useState } from "react";
import { useHubState } from "@/ui/hub/use-hub-state";
import { GlobalActionBar } from "@/ui/hub/global-action-bar";
import { PrereqStrip } from "@/ui/hub/prereq-strip";
import { PlatformCard, type PlatformId } from "@/ui/hub/platform-card";
import { getEnrichmentById, type EnrichmentId } from "@/lib/enrichments";
import { runPlatformSync } from "@/sync/run-platform-sync";
import { IntegrationsPanel } from "@/ui/hub/integrations-panel";
import { buildIntegrationRows } from "@/ui/hub/integration-rows";
import { clearDetectCache, type IntegrationId } from "@/integrations/registry";
import { PipelinesPanel } from "@/ui/hub/pipelines-panel";
import { buildPipelineRows } from "@/ui/hub/pipeline-rows";
import { gateCtxFromPlugin } from "@/lib/pipeline-gate-plugin";
import type { PipelineId } from "@/lib/enrichments";
import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type { Platform, StopSignal, SyncPhaseProgress } from "@/types/sync";
import type { SyncProgress } from "@/ui/components/progress-header";

const HUB_PLATFORMS: readonly PlatformId[] = ["tiktok", "x", "eagle"] as const;

function hubPlatformToSyncId(p: PlatformId): "tiktok" | "twitter" | "eagle" {
  if (p === "x") return "twitter";
  return p;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pt-4 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
      {children}
    </div>
  );
}

export interface LiveSync {
  signal: StopSignal;
  /** Same shape as the sidebar's ProgressHeader uses, so the inline
   *  progress UI matches what the user already knows. Null until the
   *  first onProgress fires. */
  progress: SyncProgress | null;
}

export function HubBody({ app, plugin }: { app: App; plugin: IRoostPlugin }) {
  const state = useHubState(app, plugin);
  const [globalRunning, setGlobalRunning] = useState(false);
  const [liveSyncs, setLiveSyncs] = useState<Record<Platform, LiveSync | null>>({
    tiktok: null,
    twitter: null,
  });
  // True while a platform's login webview is mounted inline in its card. We
  // keep the embedded site visible (it shows the login screen when logged out)
  // until the auth-cookie probe flips the platform to connected.
  const [loginActive, setLoginActive] = useState<Record<Platform, boolean>>({
    tiktok: false,
    twitter: false,
  });
  const loginPollRef = useRef<Record<Platform, number | null>>({ tiktok: null, twitter: null });

  // Refs hold the DOM mount targets for each platform's webview during sync.
  // PlatformCard renders an empty div with this ref attached when syncing.
  const tiktokMountRef = useRef<HTMLDivElement | null>(null);
  const xMountRef = useRef<HTMLDivElement | null>(null);
  const mountRefs: Record<Platform, React.RefObject<HTMLDivElement | null>> = {
    tiktok: tiktokMountRef,
    twitter: xMountRef,
  };

  // Whenever a sync starts/stops, force a re-render so PlatformCard
  // mounts/unmounts its expansion area.
  const isPlatformSyncing = (p: Platform): boolean => liveSyncs[p] !== null;

  const log = (m: string) => {
    plugin.fireLog?.(m);
  };

  const runOne = async (platform: Platform, fastMode?: boolean): Promise<void> => {
    if (liveSyncs[platform]) return;
    // Wait one frame so the platform card renders its mount div before we
    // try to attach the webview to it.
    const signal: StopSignal = { stopped: false, stop() { this.stopped = true; log(`Stop requested for ${platform}…`); } };
    setLiveSyncs((prev) => ({ ...prev, [platform]: { signal, progress: null } }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const target = mountRefs[platform].current;
    if (!target) {
      setLiveSyncs((prev) => ({ ...prev, [platform]: null }));
      log(`[${platform}] mount target missing — abort`);
      return;
    }
    try {
      await plugin.runJob(`Sync ${platform}`, () => runPlatformSync({
        plugin,
        app,
        platform,
        mountTarget: target,
        signal,
        fastMode,
        onLog: log,
        onProgress: (p: SyncPhaseProgress) => {
          // Match the sidebar's setSyncProgress logic: overwrite phase/count
          // from this event, preserve cumulative written/skipped/resynced
          // (those come from onBatchWritten).
          setLiveSyncs((prev) => {
            const live = prev[platform];
            if (!live) return prev;
            const prior = live.progress;
            return {
              ...prev,
              [platform]: {
                ...live,
                progress: {
                  phase: p.phase,
                  count: p.count,
                  total: p.total,
                  written: prior?.written ?? 0,
                  skipped: prior?.skipped ?? 0,
                  resynced: prior?.resynced ?? 0,
                },
              },
            };
          });
        },
        onBatchWritten: (b) => {
          setLiveSyncs((prev) => {
            const live = prev[platform];
            if (!live) return prev;
            const prior = live.progress;
            if (!prior) return prev;
            return {
              ...prev,
              [platform]: {
                ...live,
                progress: {
                  ...prior,
                  written: b.totalPushed,
                  // Match RoostView: skipped excludes resynced
                  skipped: b.totalSkipped - (prior.resynced + b.resynced),
                  resynced: prior.resynced + b.resynced,
                },
              },
            };
          });
        },
        suppressNotice: true,
      }));
    } finally {
      setLiveSyncs((prev) => ({ ...prev, [platform]: null }));
      plugin.triggerHubStateChange();
    }
  };

  const cancelOne = (platform: Platform) => {
    const live = liveSyncs[platform];
    if (live) live.signal.stop();
  };

  const updateAll = async (fastMode: boolean) => {
    const targets: Platform[] = [];
    if (state.platforms.tiktok.kind === "connected-idle") targets.push("tiktok");
    if (state.platforms.x.kind === "connected-idle") targets.push("twitter");
    // Defensive: the action bar already disables the buttons when nothing is
    // connected, but never let a click silently do nothing.
    if (targets.length === 0) {
      new Notice("Connect TikTok or X/Twitter first, then sync.");
      return;
    }
    setGlobalRunning(true);
    try {
      // Run in parallel — each platform has its own webview, writer, and
      // mount target. fastMode is X-only (TikTok ignores it).
      await Promise.all(targets.map((p) => runOne(p, fastMode)));
    } finally {
      setGlobalRunning(false);
    }
  };

  const syncOne = async (id: "tiktok" | "twitter" | "eagle") => {
    if (id === "eagle") {
      await plugin.runEagleImport();
      plugin.triggerHubStateChange();
      return;
    }
    await runOne(id);
  };

  const PLATFORM_LABEL: Record<"tiktok" | "twitter", string> = { tiktok: "TikTok", twitter: "X/Twitter" };

  // Connect/reconnect: mount the SAME embedded webview used for syncing directly
  // into the platform card. The page shows the platform's login screen while
  // logged out; once the auth cookie appears we collapse the pane and the card
  // flips to Connected. No separate webview leaf is opened.
  const connect = async (id: Platform): Promise<void> => {
    if (liveSyncs[id]) return; // a sync owns the webview right now
    setLoginActive((prev) => ({ ...prev, [id]: true }));
    // Wait one frame so the card renders its mount div before we attach.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const target = mountRefs[id].current;
    const wm = plugin.getWebviewManager();
    if (target) wm.mount(id, target);
    new Notice(`Log in to ${PLATFORM_LABEL[id]} below — Roost detects it automatically.`);
    // No login event exists, so poll the auth probe (~5 min cap).
    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      void plugin.refreshAuthStatus().then(() => {
        if (plugin.authStatus[id] === "connected") {
          stopLogin(id);
          new Notice(`${PLATFORM_LABEL[id]} connected ✓ — you can sync now.`);
        } else if (tries >= 150) {
          stopLogin(id);
        }
      });
    }, 2000);
    loginPollRef.current[id] = poll;
  };

  const stopLogin = (id: Platform): void => {
    const poll = loginPollRef.current[id];
    if (poll != null) {
      window.clearInterval(poll);
      loginPollRef.current[id] = null;
    }
    // Return the webview to the hidden container unless a sync is using it.
    if (!liveSyncs[id]) plugin.getWebviewManager().unmount(id);
    setLoginActive((prev) => ({ ...prev, [id]: false }));
  };

  const disconnect = (id: "tiktok" | "twitter") => {
    void plugin.disconnectPlatform(id).then(() => {
      new Notice(`${PLATFORM_LABEL[id]} disconnected.`);
    });
  };

  const backfill = (bucket: string) => {
    const def = getEnrichmentById(bucket as EnrichmentId);
    if (!def) return;
    (app as unknown as { commands: { executeCommandById: (id: string) => void } })
      .commands?.executeCommandById?.(`roost:${def.commandId}`);
  };

  const pickFolder = () => {
    (app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } })
      .setting?.open?.();
  };

  const recheckOllama = () => {
    void plugin.refreshIntegrations();
  };

  const toggleIntegration = (id: IntegrationId, next: boolean) => {
    const key = { ollama: "ollama", sidecar: "sidecar", ffmpeg: "ffmpeg", "vault-search": "vaultSearch" }[id] as keyof typeof plugin.settings.integrations;
    plugin.settings.integrations[key] = next;
    void plugin.saveSettings().then(() => {
      clearDetectCache();
      return plugin.refreshIntegrations();
    });
  };

  const pipelineGate = gateCtxFromPlugin(plugin);
  const togglePipeline = (id: PipelineId, next: boolean) => {
    plugin.settings.pipelines[id] = next;
    void plugin.saveSettings().then(() => plugin.triggerHubStateChange());
  };

  // On unmount, stop any login polls and return in-flight webview-mounts to the
  // hidden container so a future open of the hub doesn't show stale state.
  useEffect(() => {
    return () => {
      for (const p of ["tiktok", "twitter"] as const) {
        const poll = loginPollRef.current[p];
        if (poll != null) window.clearInterval(poll);
      }
      const wm = plugin.getWebviewManager?.();
      if (!wm) return;
      wm.unmount("tiktok");
      wm.unmount("twitter");
    };
  }, [plugin]);

  return (
    <div className="roost-hub-body mx-auto max-w-3xl py-2">
      <header className="px-4 pt-3 pb-3 border-b border-border">
        <h1 className="text-base font-semibold tracking-tight">Roost Hub</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Connect, sync, and manage your platforms — all in one place.</p>
      </header>

      {/* Platforms + sync are the primary surface, so they lead. The global
          Fast/Deep sync controls sit at the top of this section. */}
      <SectionHeader>Platforms &amp; sync</SectionHeader>
      <GlobalActionBar
        state={state}
        isRunning={globalRunning || isPlatformSyncing("tiktok") || isPlatformSyncing("twitter")}
        onFastSync={() => void updateAll(true)}
        onDeepSync={() => void updateAll(false)}
        onCancel={() => {
          cancelOne("tiktok");
          cancelOne("twitter");
        }}
      />
      <div className="border-b border-border pb-2">
        {HUB_PLATFORMS.map((p) => {
          const syncId = hubPlatformToSyncId(p);
          const live = syncId === "eagle" ? null : liveSyncs[syncId as Platform];
          const mountRef = syncId === "eagle" ? null : mountRefs[syncId as Platform];
          const isLoggingIn = syncId === "eagle" ? false : loginActive[syncId as Platform];
          return (
            <PlatformCard
              key={p}
              platform={p}
              state={state.platforms[p]}
              live={live}
              loginActive={isLoggingIn}
              webviewMountRef={mountRef}
              onConnect={() => { if (syncId !== "eagle") void connect(syncId); }}
              onSync={() => void syncOne(syncId)}
              onReconnect={() => { if (syncId !== "eagle") void connect(syncId); }}
              onCancelLogin={() => { if (syncId !== "eagle") stopLogin(syncId as Platform); }}
              onDisconnect={syncId === "eagle" ? undefined : () => disconnect(syncId)}
              onBackfill={backfill}
              onCancel={() => { if (syncId !== "eagle") cancelOne(syncId as Platform); }}
            />
          );
        })}
      </div>

      <SectionHeader>Prerequisites</SectionHeader>
      <div className="border-b border-border pb-2">
        <PrereqStrip
          prereqs={state.prereqs}
          folderPath={plugin.settings.syncFolder ?? ""}
          onPickFolder={pickFolder}
          onRecheckOllama={recheckOllama}
        />
      </div>

      <SectionHeader>Integrations</SectionHeader>
      <div className="border-b border-border pb-2">
        <IntegrationsPanel
          rows={buildIntegrationRows(plugin.settings.integrations, plugin.integrationStatus)}
          onToggle={toggleIntegration}
        />
        <PipelinesPanel
          rows={buildPipelineRows(plugin.settings.pipelines, pipelineGate.llm)}
          llm={pipelineGate.llm}
          onToggle={togglePipeline}
        />
      </div>
    </div>
  );
}
