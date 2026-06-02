import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { HubBody } from "@/ui/hub/hub-body";
import type { IRoostPlugin } from "@/types/plugin";

export const VIEW_TYPE_ROOST_HUB = "roost-hub";

export class RoostHubView extends ItemView {
  private plugin: IRoostPlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: IRoostPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_ROOST_HUB; }
  getDisplayText() { return "Roost Hub"; }
  getIcon() { return "settings-2"; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("roost-hub-view");
    // `roost-root` is the Tailwind `important:` selector — utility
    // classes only apply nested under it. Reusing the same class as the
    // sidebar view keeps the hub's styles working.
    const mountEl = container.createDiv({ cls: "roost-root roost-hub-root" });
    this.root = createRoot(mountEl);
    this.root.render(createElement(HubBody, { app: this.app, plugin: this.plugin }));
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
