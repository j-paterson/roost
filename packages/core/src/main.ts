import { Plugin, FileSystemAdapter } from "obsidian";
import { VIEW_TYPE_ROOST } from "./views/roost-view";
import { VIEW_TYPE_ROOST_WEBVIEW } from "./views/roost-webview-view";
import { migrateRoostLayout } from "@/lib/roost-layout-migrate";
import { registerRoostViews } from "@/plugin/register-roost-views";
import { registerRoostCommands } from "@/plugin/register-roost-commands";
import { RoostWorkspace } from "@/plugin/roost-workspace";
import { RoostPluginState } from "@/plugin/roost-plugin-state";
import { exportXCookies } from "@/plugin/export-x-cookies";
import { regenerateCardForActiveNote } from "@/plugin/regenerate-card-command";
import { fetchCoversCommand } from "@/plugin/fetch-covers-command";
// Side-effect import: each pipeline-view module registers itself with the
// pipeline-view registry on load. Adding a new pipeline visualization is
// one entry in src/views/pipeline-views/index.ts.
import "./views/pipeline-views";
import { RoostSettings, DEFAULT_SETTINGS, RoostSettingTab } from "./settings";
import { WebviewManager } from "./sync/webview-manager";
import { setActiveProvider, buildProviderFromSettings } from "./lib/llm-provider";
import { httpProbe, findBinary } from "@/integrations/detect";
import { INTEGRATIONS, detectIntegration, type DetectCtx, type DetectStatus, type IntegrationId } from "@/integrations/registry";
import { teardownInlinePlayer } from "./views/pipeline-views/inline-audio-player";
import { selectEmbedder, type SelectEmbedderOpts, type Embedder } from "./lib/embedder";
import "./styles/globals.css";
import "./styles/bases-view.css";
import "./styles/feed-view.css";

// Re-export constants and types so existing `import … from "@/main"` lines
// keep working without modification. Canonical definitions live in config.ts
// and types/roost.d.ts so that views, hooks, and pipeline files can import
// them without cycling back through this entry-point file.
export { PLUGIN_ID, CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "./config";
export type { FolderView, RoostFilter, ItemClickData, RoostMode } from "./types/roost";

import type { RoostFilter, ItemClickData, RoostMode } from "./types/roost";

export default class RoostPlugin extends Plugin {
  settings: RoostSettings = DEFAULT_SETTINGS;
  /** The embedder currently active for Smart Assign. Disposed on plugin unload
   *  and replaced at the start of each new Smart Assign run. */
  activeEmbedder: Embedder | null = null;
  integrationStatus: Record<IntegrationId, DetectStatus | "unknown"> = {
    ollama: "unknown", sidecar: "unknown", ffmpeg: "unknown", "vault-search": "unknown",
  };
  private workspace: RoostWorkspace | null = null;
  private readonly buses = new RoostPluginState();

  /** Active filter — null means show all */
  get activeFilter(): RoostFilter {
    return this.buses.filter.value;
  }

  /** Current sidebar mode — set by active-leaf-change */
  get activeMode(): RoostMode {
    return this.buses.mode.value;
  }

  /** File paths visible in the current explorer Base (for sidebar tree) */
  get explorerPaths(): string[] {
    return this.buses.explorerPaths.value;
  }

  /** Proposed folders — shared with bases view for modal */
  proposedFolderNames: { id: string; name: string }[] = [];

  /** Last suggestion result — set by hook after reassignment, read by modal */
  lastSuggestionResult: { count: number; targetName: string; itemIds: string[] } | null = null;

  /** Latest scanIncompleteIds breakdown (set by handleSync after every sync,
   *  read by the hub's useHubState to derive per-platform backlog rows).
   *  Kept on the plugin instance so the hub re-renders pick up the same
   *  result without re-running the (expensive) full-vault scan. */
  lastIncompleteScan: import("./sync/vault-writer").IncompleteByCategory | null = null;

  get bulkWriteInProgress(): boolean {
    return this.buses.bulkWrite.value;
  }

  set bulkWriteInProgress(value: boolean) {
    this.buses.bulkWrite.set(value);
  }

  onModeChange(fn: (mode: RoostMode) => void): () => void {
    return this.buses.mode.subscribe(fn);
  }

  onExplorerPathsChange(fn: (paths: string[]) => void): () => void {
    return this.buses.explorerPaths.subscribe(fn);
  }

  setExplorerPaths(paths: string[]): void {
    this.buses.explorerPaths.set(paths);
  }

  onBulkWriteChange(fn: (value: boolean) => void): () => void {
    return this.buses.bulkWrite.subscribe(fn);
  }

  onItemClick(fn: (data: ItemClickData) => void): () => void {
    return this.buses.itemClick.subscribe(fn);
  }

  fireItemClick(data: ItemClickData): void {
    this.buses.itemClick.emit(data);
  }

  onDataRefresh(fn: () => void): () => void {
    return this.buses.dataRefresh.subscribe(fn);
  }

  fireDataRefresh(): void {
    this.buses.dataRefresh.emit();
  }

  onLog(fn: (msg: string) => void): () => void {
    return this.buses.log.subscribe(fn);
  }

  fireLog(msg: string): void {
    console.log("[roost]", msg);
    this.buses.log.emit(msg);
  }

  onFilterChange(fn: (filter: RoostFilter) => void): () => void {
    return this.buses.filter.subscribe(fn);
  }

  setFilter(filter: RoostFilter): void {
    this.buses.filter.set(filter);
  }

  private setMode(mode: RoostMode): void {
    this.buses.mode.set(mode);
  }

  private ws(): RoostWorkspace {
    if (!this.workspace) {
      this.workspace = new RoostWorkspace(this.app, () => this.settings);
    }
    return this.workspace;
  }

  async onload() {
    await this.loadSettings();

    // Install the active LLM provider before any pipeline code can run.
    // Updates again whenever settings change (see refreshLLMProvider).
    this.refreshLLMProvider();

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Roost requires a local vault (FileSystemAdapter) — desktop only.");
    }
    const vaultRoot = adapter.getBasePath();
    const pluginDir = adapter.getFullPath(this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);

    migrateRoostLayout(vaultRoot);

    void this.refreshIntegrations();

    registerRoostViews(this, (mode) => this.setMode(mode));
    registerRoostCommands(this);
    this.addSettingTab(new RoostSettingTab(this.app, this));

    // One-time migration: drop the legacy welcomeCompleted flag.
    if ("welcomeCompleted" in (this.settings as unknown as Record<string, unknown>)) {
      delete (this.settings as unknown as Record<string, unknown>).welcomeCompleted;
      void this.saveSettings();
    }

    // Open the hub on first launch when no platforms are configured. The 500ms
    // delay lets Obsidian's workspace settle before we open a new leaf.
    window.setTimeout(() => {
      const hasAnyPlatform =
        Object.keys(this.settings.syncState ?? {}).length > 0 ||
        ((this.settings.eagleToken ?? "").length > 0 &&
          (this.settings.eagleLibraryPath ?? "").length > 0);
      if (!hasAnyPlatform) {
        void this.ws().activateHubLeaf();
      }
    }, 500);
  }

  async regenerateCardForActiveNote(): Promise<void> {
    await regenerateCardForActiveNote(this.app);
  }

  async activateView(): Promise<void> {
    await this.ws().activateRoostSidebar();
  }

  async runSync(platform: "tiktok" | "twitter"): Promise<void> {
    await this.ws().runSync(platform);
  }

  async runEagleImport(): Promise<void> {
    await this.ws().runEagleImport();
  }

  async activateHubLeaf(): Promise<void> {
    await this.ws().activateHubLeaf();
  }

  async openBookmarksBase(): Promise<void> {
    await this.ws().openBookmarksBase();
  }

  async openExplorerBase(): Promise<void> {
    await this.ws().openExplorerBase();
  }

  async openWebview(platform: "tiktok" | "twitter"): Promise<void> {
    await this.ws().openWebview(platform);
  }

  async exportXCookies(): Promise<void> {
    await exportXCookies(() => this.getWebviewManager());
  }

  async fetchCoversCommand(): Promise<void> {
    await fetchCoversCommand(this.app, this.settings.omdbApiKey || undefined);
  }

  closeWebview(): void {
    this.ws().closeWebview();
  }

  getWebviewManager(): WebviewManager {
    return this.ws().getWebviewManager();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ROOST);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ROOST_WEBVIEW);
    this.workspace?.destroy();
    this.workspace = null;
    teardownInlinePlayer();
    this.activeEmbedder?.dispose();
    this.activeEmbedder = null;
  }

  async loadSettings() {
    const raw = (await this.loadData()) ?? {};
    // Migration: pythonBinary / sidecarScript were hardcoded user-machine paths
    // that became stale when the vault moved. They're now derived from
    // app.vault.adapter.basePath at spawn time — strip the stale keys.
    let migrated = false;
    if ("pythonBinary" in raw) { delete (raw as Record<string, unknown>).pythonBinary; migrated = true; }
    if ("sidecarScript" in raw) { delete (raw as Record<string, unknown>).sidecarScript; migrated = true; }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    if (migrated) await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Settings may have changed the active LLM backend or its key; rebuild
    // the provider so subsequent pipeline calls use the new config.
    this.refreshLLMProvider();
    this.triggerHubStateChange();
  }

  /** Notify hub subscribers (status strip + hub leaf) that derived state has
   *  changed. Call after settings save, sync completion, webview open, and
   *  any other state transition the hub surfaces. */
  triggerHubStateChange(): void {
    this.app.workspace.trigger("roost:hub-state-changed");
  }

  /** Embedder factory: probe sidecar, else Ollama, per settings. */
  createEmbedder(opts: SelectEmbedderOpts): Promise<Embedder> {
    return selectEmbedder(opts);
  }

  private detectCtx(): DetectCtx {
    return { httpProbe, resolveBinary: (name) => findBinary(name) };
  }

  async refreshIntegrations(): Promise<void> {
    const ctx = this.detectCtx();
    const flags = this.settings.integrations;
    for (const i of INTEGRATIONS) {
      this.integrationStatus[i.id] = flags[i.flagKey]
        ? await detectIntegration(i.id, ctx, Date.now())
        : "unknown";
    }
    this.triggerHubStateChange();
  }

  /** Build and install the LLM provider matching current settings.
   *  Falls back to Ollama if cloud is selected without a key. */
  refreshLLMProvider() {
    const provider = buildProviderFromSettings({
      llmBackend: this.settings.llmBackend,
      anthropicApiKey: this.settings.anthropicApiKey,
      anthropicModel: this.settings.anthropicModel,
    });
    setActiveProvider(provider);
  }
}
