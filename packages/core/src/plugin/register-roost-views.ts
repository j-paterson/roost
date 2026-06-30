/**
 * Registers Roost workspace views and Bases view factories on plugin load.
 */
import { Notice } from "obsidian";
import type { QueryController } from "obsidian";
import type { Plugin } from "obsidian";
import { RoostView, VIEW_TYPE_ROOST } from "@/views/roost-view";
import { RoostWebviewView, VIEW_TYPE_ROOST_WEBVIEW } from "@/views/roost-webview-view";
import { RoostLinkView, VIEW_TYPE_ROOST_LINK } from "@/views/roost-link-view";
import { RoostHubView, VIEW_TYPE_ROOST_HUB } from "@/views/roost-hub-view";
import { BookmarksBasesView, BASES_VIEW_ID } from "@/views/bookmarks-bases-view";
import { bookmarksViewOptions } from "@/views/bookmarks-view-options";
import { ExplorerBasesView, EXPLORER_VIEW_ID } from "@/views/explorer-bases-view";
import { explorerViewOptions } from "@/views/explorer-view-options";
import { registerRoostCardBlock } from "@/views/roost-card-block";
import { roostModeFromLeaf } from "@/lib/obsidian-bases";
import type { RoostMode } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";

// Host = the RoostPlugin instance. `registerBasesView` is provided by Obsidian's
// Plugin type (since 1.10); we no longer shim it (the old hand-rolled signature
// conflicted with Obsidian's own). The runtime `typeof` guard below still covers
// vaults on a pre-1.10 build.
export type RoostViewRegistrationHost = Plugin & IRoostPlugin;

export function registerRoostViews(
  host: RoostViewRegistrationHost,
  onActiveModeChange: (mode: RoostMode) => void,
): void {
  host.registerView(VIEW_TYPE_ROOST, (leaf) => new RoostView(leaf, host));
  host.registerView(VIEW_TYPE_ROOST_WEBVIEW, (leaf) => new RoostWebviewView(leaf, host));
  host.registerView(VIEW_TYPE_ROOST_LINK, (leaf) => new RoostLinkView(leaf));
  host.registerView(VIEW_TYPE_ROOST_HUB, (leaf) => new RoostHubView(leaf, host));

  registerRoostCardBlock(host);

  if (typeof host.registerBasesView === "function") {
    const registered = host.registerBasesView(BASES_VIEW_ID, {
      name: "Bookmarks",
      icon: "bird",
      factory: (controller: QueryController, scrollEl: HTMLElement) =>
        new BookmarksBasesView(controller, scrollEl),
      options: () => bookmarksViewOptions(),
    });
    if (!registered) {
      console.warn("[roost] registerBasesView returned false — enable Bases in this vault");
    }
  } else {
    console.warn("[roost] Bases API unavailable — Obsidian 1.10+ required for the gallery view");
  }

  try {
    if (typeof host.registerBasesView === "function") {
      host.registerBasesView(EXPLORER_VIEW_ID, {
        name: "Explorer",
        icon: "layout-grid",
        factory: (controller: QueryController, scrollEl: HTMLElement) =>
          new ExplorerBasesView(controller, scrollEl),
        options: () => explorerViewOptions(),
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[roost] Failed to register explorer view:", msg);
    new Notice(`Roost: Explorer view failed to register (${msg})`);
  }

  host.registerEvent(
    host.app.workspace.on("active-leaf-change", (leaf) => {
      onActiveModeChange(roostModeFromLeaf(leaf));
    }),
  );
}
