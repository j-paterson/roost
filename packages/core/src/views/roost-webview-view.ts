import { ItemView, WorkspaceLeaf } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";

export const VIEW_TYPE_ROOST_WEBVIEW = "roost-webview";

/**
 * Dedicated view for TikTok/X webviews — opens in main content area
 * for login, then can be closed while sync continues in the background.
 */
export class RoostWebviewView extends ItemView {
  private plugin: IRoostPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: IRoostPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_ROOST_WEBVIEW; }
  getDisplayText() { return "Roost — Login"; }
  getIcon() { return "globe"; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.style.cssText = "padding: 0 !important; overflow: hidden !important;";

    // Mount the webview manager's container here
    const wm = this.plugin.getWebviewManager();
    if (wm) {
      container.appendChild(wm.getContainer());
    }
  }

  async onClose() {
    // Don't destroy the webview manager — it persists at the plugin level
    // Just detach the container
    const wm = this.plugin.getWebviewManager();
    if (wm) {
      wm.hideAll();
    }
  }
}
