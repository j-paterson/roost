import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { RoostView as RoostViewComponent } from "@/ui/components/RoostView";
import type { IRoostPlugin } from "@/types/plugin";

export const VIEW_TYPE_ROOST = "roost-view";

/**
 * Unified Roost view — sync + smart assign in one tab.
 * Webview at the view level (proven pattern), React for controls.
 */
export class RoostView extends ItemView {
  private plugin: IRoostPlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: IRoostPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_ROOST; }
  getDisplayText() { return "Roost"; }
  getIcon() { return "bird"; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("roost-sync-view");

    const mountEl = container.createDiv({ cls: "roost-root" });
    this.root = createRoot(mountEl);
    this.root.render(
      createElement(RoostViewComponent, {
        app: this.app,
        plugin: this.plugin,
      })
    );
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
