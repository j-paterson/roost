import { useEffect, useState, useCallback } from "react";
import type { App } from "obsidian";
import { useTickEvery } from "@/ui/hooks/use-tick-every";
import { deriveHubState, type HubState, type HubInputs } from "@/ui/hub/state";
import { llmAvailable } from "@/lib/pipeline-gate";
import { describeActiveEmbedding } from "@/lib/embedder";
import { loadProvenance, classifyMismatch } from "@/lib/embedding-provenance";
import { vaultBasePath } from "@/lib/vault-utils";
import { probeSidecarUp } from "@/lib/sidecar-probe";
import type { IRoostPlugin } from "@/types/plugin";

function ollamaStateFromDetect(status: "available" | "unavailable" | "unknown"): HubInputs["ollamaState"] {
  if (status === "available") return "external"; // running, not managed by us
  if (status === "unavailable") return "failed";
  return null;                                    // "unknown" / flag off
}

function gatherInputs(
  app: App,
  plugin: IRoostPlugin,
  embeddingInput?: HubInputs["embedding"],
): HubInputs {
  const settings = plugin.settings;
  const folder = settings.syncFolder ?? "";
  const folderExists = folder.length > 0 && app.vault.getAbstractFileByPath(folder) !== null;
  return {
    syncFolder: folder,
    folderExists,
    llmBackend: settings.llmBackend,
    ollamaState: ollamaStateFromDetect(plugin.integrationStatus.ollama),
    llmReadyForPipelines: llmAvailable({
      llmBackend: settings.llmBackend,
      anthropicApiKey: settings.anthropicApiKey ?? "",
      ollamaEnabled: settings.integrations.ollama,
      ollamaStatus: plugin.integrationStatus.ollama,
    }),
    syncStateByPlatform: settings.syncState ?? {},
    incompleteByCategory: plugin.lastIncompleteScan,
    authByPlatform: {
      tiktok: plugin.authStatus.tiktok,
      twitter: plugin.authStatus.twitter,
    },
    eagleConfigured:
      (settings.eagleToken ?? "").length > 0 &&
      (settings.eagleLibraryPath ?? "").length > 0,
    embedding: embeddingInput,
    jobBusy: plugin.jobQueue.isBusy(),
    jobLabel: plugin.jobQueue.currentLabel(),
  };
}

async function probeEmbedding(
  app: App,
  plugin: IRoostPlugin,
): Promise<HubInputs["embedding"]> {
  try {
    const active = await describeActiveEmbedding({
      settings: { embeddingBackend: plugin.settings.embeddingBackend ?? "auto" },
      probeSidecar: probeSidecarUp,
    });
    const vaultPath = vaultBasePath(app.vault);
    const prov = loadProvenance(app.vault);
    let mismatchKind = classifyMismatch(prov, active.backend, vaultPath).kind;
    // Explicit sidecar config that's unreachable is itself a degradation, even if
    // provenance "matches". (Do NOT trigger for auto+ollama — that's the honest default.)
    if (active.reason === "configured-sidecar" && active.sidecarConfiguredButDown) {
      mismatchKind = "sidecar-down";
    }
    return { backend: active.backend, mismatch: mismatchKind };
  } catch {
    return undefined;
  }
}

/** Subscribes to `roost:hub-state-changed` plugin events; also re-renders
 *  every 5s for transient agent state (Ollama startup transitions) that
 *  doesn't emit events. */
export function useHubState(app: App, plugin: IRoostPlugin): HubState {
  const tick = useTickEvery(5_000);
  const [version, setVersion] = useState(0);
  const recompute = useCallback(() => setVersion((v) => v + 1), []);
  const [embeddingInput, setEmbeddingInput] = useState<HubInputs["embedding"]>(undefined);

  useEffect(() => {
    // Obsidian Workspace's typed overloads don't accept arbitrary event names,
    // so the cast is required. We store the EventRef and use offref for
    // cleanup, matching the convention elsewhere in the codebase.
    const ref = app.workspace.on("roost:hub-state-changed" as never, () => recompute());
    return () => { app.workspace.offref(ref); };
  }, [app, recompute]);

  // Probe webview auth cookies on mount and every 15s so the cards reflect
  // login/logout (e.g. expired session) without needing a sync. The probe
  // fires `roost:hub-state-changed` internally when it updates authStatus.
  useEffect(() => {
    void plugin.refreshAuthStatus();
    const id = window.setInterval(() => { void plugin.refreshAuthStatus(); }, 15_000);
    return () => window.clearInterval(id);
  }, [plugin]);

  // Probe the active embedding backend on mount and every 30s. This is async
  // so it's tracked in state separately and fed into HubInputs at derive time.
  useEffect(() => {
    void probeEmbedding(app, plugin).then(setEmbeddingInput);
    const id = window.setInterval(
      () => { void probeEmbedding(app, plugin).then(setEmbeddingInput); },
      30_000,
    );
    return () => window.clearInterval(id);
  }, [app, plugin]);

  // tick = time-based re-render (transient agent state has no event stream);
  // version = event-driven re-render. deriveHubState re-runs on either.
  void tick;
  void version;
  return deriveHubState(gatherInputs(app, plugin, embeddingInput));
}
