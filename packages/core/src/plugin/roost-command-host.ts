/**
 * Plugin surface required by Roost command registration modules.
 */
import type { Plugin } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type { Platform } from "@/types/sync";
import type { WebviewManager } from "@/sync/webview-manager";

export interface RoostCommandHost extends IRoostPlugin, Plugin {
  activateView(): Promise<void>;
  activateHubLeaf(): Promise<void>;
  openWebview(platform: Platform): Promise<void>;
  getWebviewManager(): WebviewManager;
  fetchCoversCommand(): Promise<void>;
  exportPlatformCookies(platform: Platform): Promise<void>;
  regenerateCardForActiveNote(): Promise<void>;
}
