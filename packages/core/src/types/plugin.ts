/**
 * IRoostPlugin — structural interface for the RoostPlugin class.
 *
 * Views and hooks import this type instead of the concrete class from
 * src/main.ts, breaking the circular dependency that arises because
 * main.ts imports the views and the views need the plugin type.
 *
 * Keep in sync with RoostPlugin in src/main.ts.
 */
import type { App } from "obsidian";
import type { RoostFilter, ItemClickData, RoostMode } from "@/types/roost";
import type { RoostSettings } from "@/settings";
import type { WebviewManager } from "@/sync/webview-manager";
import type { IncompleteByCategory } from "@/sync/vault-writer";
import type { Embedder, SelectEmbedderOpts } from "@/lib/embedder";
import type { DetectStatus, IntegrationId } from "@/integrations/registry";

export interface IRoostPlugin {
  app: App;
  settings: RoostSettings;
  /** The embedder instance currently active for Smart Assign. Disposed on plugin
   *  unload and replaced each time a new Smart Assign run selects a backend. */
  activeEmbedder: Embedder | null;

  /** Edition-injected embedder factory. Full edition delegates to selectEmbedder
   *  (sidecar/ollama); community edition returns an Ollama embedder. */
  createEmbedder(opts: SelectEmbedderOpts): Promise<Embedder>;

  /** Active filter — null means show all. */
  activeFilter: RoostFilter;

  activeMode: RoostMode;
  onModeChange(fn: (mode: RoostMode) => void): () => void;
  explorerPaths: string[];
  onExplorerPathsChange(fn: (paths: string[]) => void): () => void;
  setExplorerPaths(paths: string[]): void;

  /** Proposed folders — shared with bases view for modal. */
  proposedFolderNames: { id: string; name: string }[];

  /** Last suggestion result — set by hook after reassignment, read by modal. */
  lastSuggestionResult: { count: number; targetName: string; itemIds: string[] } | null;

  /** Latest scanIncompleteIds breakdown — set by handleSync after each sync,
   *  read by the hub's useHubState to derive per-platform backlog rows
   *  without re-running the full-vault scan. Null until first sync. */
  lastIncompleteScan: IncompleteByCategory | null;

  /** Last detected availability per integration ("unknown" until probed or when its flag is off). */
  integrationStatus: Record<IntegrationId, DetectStatus | "unknown">;
  /** Re-probe enabled integrations and refresh `integrationStatus`; triggers a Hub re-render. */
  refreshIntegrations(): Promise<void>;

  /** True while handleConfirm is bulk-writing frontmatter. */
  bulkWriteInProgress: boolean;
  /** Subscribe to bulkWriteInProgress flag changes. Returns an unsubscribe function. */
  onBulkWriteChange(fn: (value: boolean) => void): () => void;

  runSync(platform: "tiktok" | "twitter"): Promise<void>;
  runEagleImport(): Promise<void>;
  activateHubLeaf(): Promise<void>;

  getWebviewManager(): WebviewManager;
  openBookmarksBase(): Promise<void>;
  openExplorerBase(): Promise<void>;
  openWebview(platform: "tiktok" | "twitter"): Promise<void>;
  closeWebview(): void;
  setFilter(filter: RoostFilter): void;
  saveSettings(): Promise<void>;
  triggerHubStateChange(): void;

  onFilterChange(fn: (filter: RoostFilter) => void): () => void;
  onItemClick(fn: (data: ItemClickData) => void): () => void;
  fireItemClick(data: ItemClickData): void;

  /** Log event channel — fired by background commands (e.g. article-backfill),
   *  routed by RoostView into the sidebar log panel. */
  onLog(fn: (msg: string) => void): () => void;
  fireLog(msg: string): void;
  onDataRefresh(fn: () => void): () => void;
  fireDataRefresh(): void;
}
