import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useHubState } from "@/ui/hub/use-hub-state";
import { GlobalActionBar } from "@/ui/hub/global-action-bar";
import { RunningJobBar } from "@/ui/hub/running-job-bar";
import { PrereqStrip } from "@/ui/hub/prereq-strip";
import { PlatformCard, type PlatformId } from "@/ui/hub/platform-card";
import { ENRICHMENTS, PIPELINE_ENRICHMENTS, isPipelineEnrichmentId } from "@/lib/enrichments";
import { runPlatformSync } from "@/sync/run-platform-sync";
import { IntegrationsPanel } from "@/ui/hub/integrations-panel";
import { buildIntegrationRows } from "@/ui/hub/integration-rows";
import { clearDetectCache, type IntegrationId } from "@/integrations/registry";
import { PipelinesPanel } from "@/ui/hub/pipelines-panel";
import { buildPipelineRows } from "@/ui/hub/pipeline-rows";
import { OnboardingPanel } from "@/ui/hub/onboarding-panel";
import { gateCtxFromPlugin, isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";
import { Button } from "@/ui/components/ui/button";
import type { PipelineId } from "@/lib/enrichments";
import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type { Platform, StopSignal, SyncPhaseProgress } from "@/types/sync";
import type { SyncProgress } from "@/ui/components/progress-header";
import { enabledPlatforms } from "@/platforms/registry";

/** The 6 content backfills (everything that isn't a category pipeline). */
const DATA_BACKFILLS = ENRICHMENTS.filter(e => !isPipelineEnrichmentId(e.id));

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
  const [backfilling, setBackfilling] = useState(false);
  const [pipelinesRunning, setPipelinesRunning] = useState(false);
  const [liveSyncs, setLiveSyncs] = useState<Record<Platform, LiveSync | null>>(
    () => Object.fromEntries(enabledPlatforms().map(d => [d.id, null])) as Record<Platform, LiveSync | null>,
  );
  // True while a platform's login webview is mounted inline in its card. We
  // keep the embedded site visible (it shows the login screen when logged out)
  // until the auth-cookie probe flips the platform to connected.
  const [loginActive, setLoginActive] = useState<Record<Platform, boolean>>(
    () => Object.fromEntries(enabledPlatforms().map(d => [d.id, false])) as Record<Platform, boolean>,
  );
  // Single ref holding poll-timer IDs for all sync platforms; lazily initialized
  // from the registry so no platform key is ever missing.
  const loginPollRef = useRef<Record<Platform, number | null>>(undefined as any);
  if (!loginPollRef.current) {
    loginPollRef.current = Object.fromEntries(
      enabledPlatforms().map(d => [d.id, null]),
    ) as Record<Platform, number | null>;
  }

  // Refs hold the DOM mount targets for each platform's webview during sync.
  // PlatformCard renders an empty div with this ref attached when syncing.
  // Single ref holding the whole map — hooks-safe (one unconditional useRef call).
  const mountRefs = useRef<Record<Platform, RefObject<HTMLDivElement | null>>>(undefined as any);
  if (!mountRefs.current) {
    mountRefs.current = Object.fromEntries(
      enabledPlatforms().map(d => [d.id, { current: null }]),
    ) as Record<Platform, RefObject<HTMLDivElement | null>>;
  }

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
    const target = mountRefs.current[platform].current;
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
    if (state.platforms.instagram.kind === "connected-idle") targets.push("instagram");
    // Defensive: the action bar already disables the buttons when nothing is
    // connected, but never let a click silently do nothing.
    if (targets.length === 0) {
      new Notice("Connect TikTok, X/Twitter, or Instagram first, then sync.");
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

  const syncOne = async (id: Platform | "eagle") => {
    if (id === "eagle") {
      await plugin.runEagleImport();
      plugin.triggerHubStateChange();
      return;
    }
    await runOne(id);
  };

  const PLATFORM_LABEL: Record<Platform, string> = Object.fromEntries(
    enabledPlatforms().map(d => [d.id, d.displayName]),
  ) as Record<Platform, string>;

  // Connect/reconnect: mount the SAME embedded webview used for syncing directly
  // into the platform card. The page shows the platform's login screen while
  // logged out; once the auth cookie appears we collapse the pane and the card
  // flips to Connected. No separate webview leaf is opened.
  const connect = async (id: Platform): Promise<void> => {
    if (liveSyncs[id]) return; // a sync owns the webview right now
    setLoginActive((prev) => ({ ...prev, [id]: true }));
    // Wait one frame so the card renders its mount div before we attach.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const target = mountRefs.current[id].current;
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

  const disconnect = (id: Platform) => {
    void plugin.disconnectPlatform(id).then(() => {
      new Notice(`${PLATFORM_LABEL[id]} disconnected.`);
    });
  };

  /** Cancel the currently-running job in the serial queue. */
  const cancelJob = () => {
    plugin.cancelCurrentJob();
  };

  const backfillAll = async () => {
    setBackfilling(true);
    try {
      await Promise.all(
        DATA_BACKFILLS.map(d => plugin.runJob(d.commandName, (signal) => d.runBackfill(plugin, { signal }))
          .catch((e: unknown) => {
            // Suppress AbortError — a cancelled job is not an error.
            if (e instanceof DOMException && e.name === "AbortError") return;
            throw e;
          }),
        ),
      );
    } finally {
      setBackfilling(false);
    }
  };

  const runAllPipelines = async () => {
    setPipelinesRunning(true);
    try {
      // Only run pipelines that are actually enabled (toggle + LLM), using the
      // SAME silent gate that individual pipeline runs use
      // (use-roost-pipeline-rows.ts → isCategoryPipelineActive). Each
      // PIPELINE_ENRICHMENTS def has a non-empty categoryMatches.
      const active = PIPELINE_ENRICHMENTS.filter(d =>
        isCategoryPipelineActive(d.categoryMatches[0], plugin),
      );
      if (active.length === 0) {
        new Notice("No pipelines are enabled. Toggle them on (and enable an LLM) in the Integrations section.");
        return;
      }
      await Promise.all(
        active.map(d => plugin.runJob(d.commandName, (signal) =>
          d.runBackfill(plugin, { signal, onLog: (m) => plugin.fireLog(`[${d.id}] ${m}`) }),
        ).catch((e: unknown) => {
          // Suppress AbortError — a cancelled job is not an error.
          if (e instanceof DOMException && e.name === "AbortError") return;
          throw e;
        })),
      );
    } finally {
      setPipelinesRunning(false);
    }
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
      for (const d of enabledPlatforms()) {
        const poll = loginPollRef.current[d.id];
        if (poll != null) window.clearInterval(poll);
      }
      const wm = plugin.getWebviewManager?.();
      if (!wm) return;
      for (const d of enabledPlatforms()) {
        wm.unmount(d.id);
      }
    };
  }, [plugin]);

  const anySyncing = globalRunning || Object.values(liveSyncs).some((v) => v !== null);

  // First run: show ONLY the onboarding panel. The rest of the Hub (platforms,
  // backfills, integrations) would be confusing before setup is done, so it's
  // hidden until the user finishes or skips (which flips setupComplete and a
  // hub state change re-renders the full Hub below). All hooks run above this
  // early return, so it doesn't break the rules of hooks.
  if (!plugin.settings.setupComplete) {
    return (
      <div className="roost-hub-body mx-auto max-w-3xl py-2">
        <header className="px-4 pt-3 pb-3 border-b border-border">
          <h1 className="text-base font-semibold tracking-tight">Welcome to Roost</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Let's get you set up — just a few quick steps.</p>
        </header>
        <OnboardingPanel plugin={plugin} onComplete={() => plugin.triggerHubStateChange()} />
      </div>
    );
  }

  return (
    <div className="roost-hub-body mx-auto max-w-3xl py-2">
      <header className="px-4 pt-3 pb-3 border-b border-border">
        <h1 className="text-base font-semibold tracking-tight">Roost Hub</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Connect, sync, and manage your platforms — all in one place.</p>
      </header>

      {/* Running job bar — shown whenever a heavy job is active in the queue */}
      {state.global.runningJob && (
        <RunningJobBar
          label={state.global.runningJob.label}
          onCancel={cancelJob}
        />
      )}

      {/* Platforms + sync are the primary surface, so they lead. The global
          Fast/Deep sync controls sit at the top of this section. */}
      <SectionHeader>Platforms &amp; sync</SectionHeader>
      <GlobalActionBar
        state={state}
        isRunning={anySyncing}
        onFastSync={() => void updateAll(true)}
        onDeepSync={() => void updateAll(false)}
        onCancel={() => { enabledPlatforms().forEach((d) => cancelOne(d.id)); }}
      />
      <div className="border-b border-border pb-2">
        {/* Webview-sync platforms: tiktok then x, driven by the registry. */}
        {enabledPlatforms().map((descriptor) => {
          const hubId = descriptor.hubId as PlatformId;
          const platformId = descriptor.id;
          return (
            <PlatformCard
              key={hubId}
              platform={hubId}
              state={state.platforms[hubId]}
              live={liveSyncs[platformId]}
              loginActive={loginActive[platformId]}
              webviewMountRef={mountRefs.current[platformId]}
              onConnect={() => void connect(platformId)}
              onSync={() => void syncOne(platformId)}
              onReconnect={() => void connect(platformId)}
              onCancelLogin={() => stopLogin(platformId)}
              onDisconnect={() => disconnect(platformId)}
              onCancel={() => cancelOne(platformId)}
            />
          );
        })}
        {/* Eagle is not a webview-sync Platform; always rendered last. */}
        <PlatformCard
          key="eagle"
          platform="eagle"
          state={state.platforms.eagle}
          live={null}
          loginActive={false}
          webviewMountRef={null}
          onConnect={() => {}}
          onSync={() => void syncOne("eagle")}
          onReconnect={() => {}}
          onCancelLogin={() => {}}
          onDisconnect={undefined}
          onCancel={() => {}}
        />
      </div>

      <SectionHeader>Backfill &amp; pipelines</SectionHeader>
      <div className="border-b border-border pb-2 px-4 py-2 flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="secondary"
          loading={backfilling}
          disabled={anySyncing || pipelinesRunning}
          onClick={() => void backfillAll()}
          title="Run all content backfills (media, transcripts, tweet bodies, threads, article bodies, playback) — one at a time."
        >
          Backfill all
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={pipelinesRunning}
          disabled={anySyncing || backfilling}
          onClick={() => void runAllPipelines()}
          title="Run all enabled category pipelines (recipe, place, product, …) across the library — one at a time. Needs an LLM."
        >
          Run pipelines
        </Button>
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
          rows={buildPipelineRows(plugin.settings.pipelines, pipelineGate.llm, state.global.pipelinesPending)}
          llm={pipelineGate.llm}
          onToggle={togglePipeline}
        />
      </div>
    </div>
  );
}
