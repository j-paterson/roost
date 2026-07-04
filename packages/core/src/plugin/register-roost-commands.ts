/**
 * Obsidian command palette registrations for Roost.
 */
import { Notice } from "obsidian";
import { VaultSearchModal } from "@/ui/components/vault-search-modal";
import { DebugBootstrapModal } from "@/ui/components/debug-bootstrap-modal";
import { ENRICHMENTS } from "@/lib/enrichments";
import { registerDigestCommands } from "@/plugin/digest-commands";
import { registerMemoryCommands } from "@/plugin/memory-commands";
import { registerBackfillCommands } from "@/plugin/backfill-commands";
import { registerSeedCommands } from "@/plugin/seed-commands";
import { registerMigrationCommands } from "@/plugin/migration-commands";
import { registerRemapCommands } from "@/plugin/remap-commands";
import type { RoostCommandHost } from "@/plugin/roost-command-host";
import { findBinary } from "@/integrations/detect";
import { getIntegration } from "@/integrations/registry";
import { DEV_COMMANDS_ENABLED } from "@/config";
import { isPipelineEnrichmentId } from "@/lib/enrichments";
import { guardPipelineActive } from "@/lib/pipeline-gate-plugin";
import { runFolderBackfill } from "@/sync/folder-backfill";
import { loadEmbeddingCache, saveEmbeddingCache } from "@/pipeline/shared";
import { loadClassifierHead } from "@/pipeline/classifier-head";
import { gatherReviewTargets } from "@/ui/lib/smart-assign/review-target";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import twitterProbeSource from "@/probes/twitter-probe.probe";

export type { RoostCommandHost } from "@/plugin/roost-command-host";

export type VaultSearchGate = { ok: true } | { ok: false; reason: "off" | "missing" };

/** Decide whether the vault-search command may run. `find` injected for testing. */
export function vaultSearchGate(flagOn: boolean, find: (name: string) => string | null): VaultSearchGate {
  if (!flagOn) return { ok: false, reason: "off" };
  if (!find("vault-search")) return { ok: false, reason: "missing" };
  return { ok: true };
}

export function registerRoostCommands(plugin: RoostCommandHost): void {
  plugin.addRibbonIcon("bird", "Roost", () => { void plugin.activateView(); });

  plugin.addCommand({ id: "open", name: "Open Roost", callback: () => plugin.activateView() });
  plugin.addCommand({ id: "sync-tiktok", name: "Sync TikTok", callback: () => plugin.activateView() });
  plugin.addCommand({ id: "sync-twitter", name: "Sync X/Twitter", callback: () => plugin.activateView() });
  plugin.addCommand({ id: "smart-assign", name: "Smart Assign", callback: () => plugin.activateView() });
  plugin.addCommand({
    id: "backfill-x-folders",
    name: "Backfill X bookmark folders",
    callback: async () => {
      await plugin.runJob("Backfill X bookmark folders", () => runFolderBackfill(plugin));
    },
  });
  plugin.addCommand({
    id: "fetch-covers",
    name: "Fetch covers for current Base",
    callback: () => { void plugin.fetchCoversCommand(); },
  });
  plugin.addCommand({
    id: "vault-search",
    name: "Search vault (semantic)",
    callback: () => {
      const gate = vaultSearchGate(plugin.settings.integrations.vaultSearch, findBinary);
      if (!gate.ok) {
        const setup = getIntegration("vault-search").setup.instructions;
        new Notice(
          gate.reason === "off"
            ? `Enable the vault-search integration in Roost settings. ${setup}`
            : `vault-search not found. ${setup}`,
          8000,
        );
        return;
      }
      new VaultSearchModal(plugin.app, plugin).open();
    },
  });
  plugin.addCommand({
    id: "open-hub",
    name: "Open Roost Hub",
    callback: () => { void plugin.activateHubLeaf(); },
  });
  plugin.addCommand({
    id: "rerun-setup",
    name: "Re-run first-time setup",
    callback: () => {
      // Clear the flag, open the Hub, and re-render — the inline onboarding
      // panel re-appears at the top of the Hub.
      plugin.settings.setupComplete = false;
      void plugin.saveSettings().then(() => {
        plugin.triggerHubStateChange();
        return plugin.activateHubLeaf();
      });
    },
  });
  plugin.addCommand({
    id: "reembed-all",
    name: "Re-embed all bookmarks (refresh vectors)",
    callback: () => {
      const cache = loadEmbeddingCache(plugin.app.vault);
      let cleared = 0;
      for (const k of Object.keys(cache)) {
        if (cache[k].vec) { cache[k].vec = null; cleared++; }
      }
      saveEmbeddingCache(plugin.app.vault, cache);
      new Notice(`Cleared ${cleared} cached vectors. Run Smart Assign to re-embed with the current backend.`);
    },
  });
  plugin.addCommand({
    id: "review-other-unsorted",
    name: "Review 'Other' items",
    callback: () => {
      const cache = loadEmbeddingCache(plugin.app.vault);
      const head = loadClassifierHead(plugin.app.vault);
      const { ids, proposalMap } = gatherReviewTargets(
        plugin.app,
        plugin.settings.syncFolder,
        // Default target: "other" — the holding bucket for items explicitly
        // placed there but not yet given a real category.
        // Extension point: expose "unsorted" or "both" via additional commands
        // or a settings toggle when those pools need dedicated review passes.
        "other",
        cache,
        head,
      );
      if (ids.length === 0) {
        new Notice(
          head
            ? "No 'Other' items with embeddings found."
            : "No 'Other' items found (head not trained — run Smart Assign first).",
          6000,
        );
        return;
      }
      plugin.fireItemClick({ action: "startReviewPass", itemIds: ids, proposalMap });
    },
  });

  for (const def of ENRICHMENTS) {
    plugin.addCommand({
      id: def.commandId,
      name: def.commandName,
      callback: async () => {
        if (isPipelineEnrichmentId(def.id) && !guardPipelineActive(def.id, plugin, (msg) => new Notice(msg, 6000))) {
          return;
        }
        await plugin.runJob(def.commandName, () =>
          def.runBackfill(
            plugin,
            isPipelineEnrichmentId(def.id)
              ? { onLog: (m) => plugin.fireLog(`[${def.id}] ${m}`) }
              : undefined,
          ),
        );
      },
    });
  }

  if (DEV_COMMANDS_ENABLED) {
    plugin.addCommand({
      id: "export-x-cookies",
      name: "Export X session cookies (for live e2e tests)",
      callback: async () => { await plugin.exportPlatformCookies("twitter"); },
    });
    plugin.addCommand({
      id: "open-instagram-login",
      name: "Open Instagram (login)",
      callback: async () => { await plugin.openWebview("instagram"); },
    });
    plugin.addCommand({
      id: "export-instagram-cookies",
      name: "Export Instagram session cookies (for live e2e tests)",
      callback: async () => { await plugin.exportPlatformCookies("instagram"); },
    });
    plugin.addCommand({
      id: "open-reddit-login",
      name: "Open Reddit (login)",
      callback: async () => { await plugin.openWebview("reddit"); },
    });
    plugin.addCommand({
      id: "export-reddit-cookies",
      name: "Export Reddit session cookies (for live e2e tests)",
      callback: async () => { await plugin.exportPlatformCookies("reddit"); },
    });
  }

  registerMigrationCommands(plugin);
  registerDigestCommands(plugin);
  registerMemoryCommands(plugin);
  registerBackfillCommands(plugin);
  registerSeedCommands(plugin);
  registerRemapCommands(plugin);

  plugin.addCommand({
    id: "regenerate-card-image",
    name: "Regenerate card image for active note",
    callback: async () => { await plugin.regenerateCardForActiveNote(); },
  });
  if (DEV_COMMANDS_ENABLED) {
    plugin.addCommand({
      id: "debug-probe-bootstrap",
      name: "Debug: probe thread bootstrap",
      callback: async () => {
        await plugin.openWebview("twitter");
        new DebugBootstrapModal({
          app: plugin.app,
          getWebviewManager: () => plugin.getWebviewManager(),
          probeSource: twitterProbeSource as unknown as string,
        }).open();
      },
    });
  }
}
