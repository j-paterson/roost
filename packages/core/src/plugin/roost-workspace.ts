/**
 * Workspace leaf helpers — sidebar, hub, bases, webview panes.
 */
import { FileView, type App } from "obsidian";
import { VIEW_TYPE_ROOST } from "@/views/roost-view";
import { VIEW_TYPE_ROOST_WEBVIEW } from "@/views/roost-webview-view";
import { VIEW_TYPE_ROOST_HUB } from "@/views/roost-hub-view";
import { WebviewManager } from "@/sync/webview-manager";
import { ensureBasesFiles } from "@/sync/bases-setup";
import type { RoostSettings } from "@/settings";

export class RoostWorkspace {
  private webviewManager: WebviewManager | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => RoostSettings,
  ) {}

  /** Open Roost sidebar in the left pane */
  async activateRoostSidebar(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ROOST)[0];
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_ROOST, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Hub entry point for per-platform sync */
  async runSync(platform: "tiktok" | "twitter"): Promise<void> {
    await this.activateRoostSidebar();
    const settings = this.getSettings();
    const initialTs = settings.syncState?.[platform]?.timestamp ?? 0;
    this.app.workspace.trigger("roost:request-sync", platform);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10 * 60_000) {
      const ts = settings.syncState?.[platform]?.timestamp ?? 0;
      if (ts > initialTs) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Hub entry point for Eagle import */
  async runEagleImport(): Promise<void> {
    await this.activateRoostSidebar();
    this.app.workspace.trigger("roost:request-eagle-import");
  }

  /** Open the Roost Hub workspace leaf, or focus it if already open */
  async activateHubLeaf(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ROOST_HUB);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_ROOST_HUB, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openBookmarksBase(): Promise<void> {
    const { syncFolder } = this.getSettings();
    await this.openBaseFile(`${syncFolder}/All Bookmarks.base`, () =>
      ensureBasesFiles(this.app.vault, syncFolder),
    );
  }

  async openExplorerBase(): Promise<void> {
    const { syncFolder } = this.getSettings();
    await this.openBaseFile(`${syncFolder}/Explorer.base`);
  }

  private async openBaseFile(
    basePath: string,
    ensure?: () => Promise<void>,
  ): Promise<void> {
    let file = this.app.vault.getAbstractFileByPath(basePath);
    if (!file && ensure) {
      await ensure();
      file = this.app.vault.getAbstractFileByPath(basePath);
      if (!file) return;
    }
    if (!file) return;
    const existing = this.app.workspace.getLeavesOfType("base").find((leaf) => {
      return leaf.view instanceof FileView && leaf.view.file?.path === basePath;
    });
    if (existing) {
      this.app.workspace.revealLeaf(existing);
    } else {
      await this.app.workspace.openLinkText(basePath, "", false);
    }
  }

  /** Open webview in main content area for login */
  async openWebview(platform: "tiktok" | "twitter"): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ROOST_WEBVIEW)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_ROOST_WEBVIEW, active: true });
    }
    workspace.revealLeaf(leaf);
    this.getWebviewManager().show(platform);
  }

  closeWebview(): void {
    this.webviewManager?.hideAll();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ROOST_WEBVIEW);
  }

  getWebviewManager(): WebviewManager {
    if (!this.webviewManager) {
      const container = document.createElement("div");
      container.style.cssText = "width: 100%; height: 100%; position: relative;";
      this.webviewManager = new WebviewManager(container, () => {});
      this.webviewManager.create("tiktok");
      this.webviewManager.create("twitter");
    }
    return this.webviewManager;
  }

  destroy(): void {
    this.webviewManager?.destroy();
    this.webviewManager = null;
  }
}
