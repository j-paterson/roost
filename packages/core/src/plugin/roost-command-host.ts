/**
 * Plugin surface required by Roost command registration modules.
 */
import type { Plugin } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type { WebviewManager } from "@/sync/webview-manager";

export interface RoostCommandHost extends IRoostPlugin, Plugin {
  activateView(): Promise<void>;
  activateHubLeaf(): Promise<void>;
  openWebview(platform: "tiktok" | "twitter"): Promise<void>;
  getWebviewManager(): WebviewManager;
  fetchCoversCommand(): Promise<void>;
  exportXCookies(): Promise<void>;
  regenerateCardForActiveNote(): Promise<void>;
}
