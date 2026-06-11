import { useEffect, useState, useCallback } from "react";
import type { App } from "obsidian";
import { useTickEvery } from "@/ui/hooks/use-tick-every";
import { deriveHubState, type HubState, type HubInputs } from "@/ui/hub/state";
import { llmAvailable } from "@/lib/pipeline-gate";
import type { IRoostPlugin } from "@/types/plugin";

function ollamaStateFromDetect(status: "available" | "unavailable" | "unknown"): HubInputs["ollamaState"] {
  if (status === "available") return "external"; // running, not managed by us
  if (status === "unavailable") return "failed";
  return null;                                    // "unknown" / flag off
}

function gatherInputs(app: App, plugin: IRoostPlugin): HubInputs {
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
  };
}

/** Subscribes to `roost:hub-state-changed` plugin events; also re-renders
 *  every 5s for transient agent state (Ollama startup transitions) that
 *  doesn't emit events. */
export function useHubState(app: App, plugin: IRoostPlugin): HubState {
  const tick = useTickEvery(5_000);
  const [version, setVersion] = useState(0);
  const recompute = useCallback(() => setVersion((v) => v + 1), []);

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

  // tick = time-based re-render (transient agent state has no event stream);
  // version = event-driven re-render. deriveHubState re-runs on either.
  void tick;
  void version;
  return deriveHubState(gatherInputs(app, plugin));
}
