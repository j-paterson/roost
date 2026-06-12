import { App, PluginSettingTab, Setting } from "obsidian";
import { PIPELINE_ENRICHMENT_IDS, type PipelineId } from "@/lib/enrichments";

export type PipelineFlags = Record<PipelineId, boolean>;

function allPipelinesOn(): PipelineFlags {
  return Object.fromEntries(PIPELINE_ENRICHMENT_IDS.map((id) => [id, true])) as PipelineFlags;
}

export interface IntegrationFlags {
  /** Use a local Ollama server (embeddings + LLM) over HTTP. */
  ollama: boolean;
  /** Use the fine-tuned embedding sidecar over HTTP. */
  sidecar: boolean;
  /** Use ffmpeg/ffprobe for video-frame vision in embedding. */
  ffmpeg: boolean;
  /** Use the vault-search CLI for semantic vault search. */
  vaultSearch: boolean;
}

export interface SyncState {
  complete: boolean;   // did the last sync finish without interruption?
  count: number;       // total items fetched last time
  timestamp: number;   // when the sync finished
}

export interface RoostSettings {
  syncFolder: string;
  eagleLibraryPath: string;
  eagleToken: string;
  syncState: Record<string, SyncState>; // keyed by platform
  recentMoveTargets: string[];
  /** Manually created subcategories that don't yet have items. category → subcategory names */
  emptySubcategories: Record<string, string[]>;
  /** Strength of CLIP visual signal in Smart Assign scoring. 0 = text only,
   *  1 = CLIP only. Default 0.5. Eval data shows 0.3-0.7 all lift accuracy
   *  by 3-5 percentage points. Takes effect on next Smart Assign run. */
  clipFusionAlpha: number;
  /** Embedding backend. "auto" probes the sidecar then falls back to Ollama,
   *  "sidecar" requires Python, "ollama" uses stock nomic-embed-text. */
  embeddingBackend: "auto" | "sidecar" | "ollama";
/** Active LLM backend. "local" routes to Ollama, "cloud" to Anthropic
   *  (with anthropicApiKey), "skip" disables AI features (extraction calls
   *  throw with a helpful message). */
  llmBackend: "local" | "cloud" | "skip";
  /** Anthropic API key. Only used when llmBackend === "cloud". Stored in
   *  plain text in data.json — same security model as every other Obsidian
   *  plugin. Empty string when not set. */
  anthropicApiKey: string;
  /** Anthropic model. Defaults to claude-haiku-4-5 (cheapest/fastest). */
  anthropicModel: string;
  /** TMDB v3 API key. Used to resolve Letterboxd deep links for
   *  Films/Series/Documentaries. Free signup at themoviedb.org.
   *  Empty string falls back to search-URL only. */
  tmdbApiKey: string;
  /** When true, syncTwitter skips the in-line thread + article enrichment
   *  passes. New items still reach disk via the flush; thread + article
   *  body are filled later by the standalone "Backfill X thread context" /
   *  "Backfill X article bodies" commands. Drops incremental sync time
   *  from minutes to seconds. Default false — opt in once the standalone
   *  backfills are proven on the user's vault. */
  fastSyncMode: boolean;
  /** Internal one-time marker: has the legacy tweet-body catch-up run? New
   *  tweets render at write time (twitter-record-writer); this flag gates the
   *  ONE-TIME auto catch-up of pre-031 legacy notes on plugin load. Set true
   *  after a successful auto-run so it never repeats. Not a user preference —
   *  no settings-tab toggle (mirrors the old welcomeCompleted marker). Reset to
   *  false by hand in data.json to force a re-run; the manual "Render X tweet
   *  bodies" command is the always-available fallback. */
  tweetBodyBackfillDone: boolean;
  /** User-curated top-level category order for the library tree. Names in
   *  this array render first (in array order); categories not listed fall
   *  back to count-descending sort. Empty array → pure count-sort. */
  categoryOrder: string[];
  /** User-curated subcategory order, keyed by parent category name. Same
   *  semantics as categoryOrder but per-parent. */
  subcategoryOrder: Record<string, string[]>;

  // ── Agent memory (spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md) ──
  memoryEnabled: boolean;
  memoryJudgeModel: string;             // "default" → reuses settings.evalModel
  memoryConceptMatchThreshold: number;
  memoryConceptCreateThreshold: number;
  memoryClaimRedundantThreshold: number;
  memoryClaimRefineThreshold: number;
  memoryIndexTier1MaxConcepts: number;
  memoryIndexTier1MaxAgeDays: number;
  /** Path to vault-search CLI (optional semantic search). */
  vaultSearchCliPath: string;
  vaultSearchNodePath: string;
  /** OMDB API key for film/TV cover fetch. Empty = skip OMDB lookups. */
  omdbApiKey: string;
  /** Per-integration on/off flags. All off by default; the plugin never
   *  installs or spawns — it points the user at setup and uses a tool if available. */
  integrations: IntegrationFlags;
  /** Per-pipeline on/off. All default on; a pipeline is active only when its
   *  flag is true AND an LLM backend is available (see lib/pipeline-gate.ts). */
  pipelines: PipelineFlags;
}

export const DEFAULT_SETTINGS: RoostSettings = {
  syncFolder: "Bookmarks",
  eagleLibraryPath: "",
  eagleToken: "",
  syncState: {},
  recentMoveTargets: [],
  emptySubcategories: {},
  clipFusionAlpha: 0.5,
  embeddingBackend: "auto",
  llmBackend: "local",
  anthropicApiKey: "",
  anthropicModel: "claude-haiku-4-5-20251001",
  tmdbApiKey: "",
  fastSyncMode: false,
  tweetBodyBackfillDone: false,
  categoryOrder: [],
  subcategoryOrder: {},
  memoryEnabled: false,
  memoryJudgeModel: "default",
  memoryConceptMatchThreshold: 0.75,
  memoryConceptCreateThreshold: 0.55,
  memoryClaimRedundantThreshold: 0.92,
  memoryClaimRefineThreshold: 0.75,
  memoryIndexTier1MaxConcepts: 20,
  memoryIndexTier1MaxAgeDays: 90,
  vaultSearchCliPath: "",
  vaultSearchNodePath: "",
  omdbApiKey: "",
  integrations: { ollama: false, sidecar: false, ffmpeg: false, vaultSearch: false },
  pipelines: allPipelinesOn(),
};

/** Minimal plugin interface needed by RoostSettingTab. */
interface IPlugin {
  settings: RoostSettings;
  saveSettings(): Promise<void>;
}

export class RoostSettingTab extends PluginSettingTab {
  plugin: IPlugin;

  constructor(app: App, plugin: IPlugin) {
    // PluginSettingTab requires Plugin (concrete class), but IPlugin is a structural
    // interface — the cast is unavoidable without coupling settings to main.ts.
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Folder where synced bookmarks are saved")
      .addText(text => text
        .setPlaceholder("Bookmarks")
        .setValue(this.plugin.settings.syncFolder)
        .onChange(async (value) => {
          this.plugin.settings.syncFolder = value || "Bookmarks";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Fast sync mode")
      .setDesc(
        "When enabled, syncing X/Twitter only discovers new bookmarks — " +
        "thread context and X article bodies are NOT enriched in-line. " +
        "Drops sync time from minutes to seconds. Run the standalone " +
        "'Backfill X thread context' and 'Backfill X article bodies' " +
        "commands (Cmd+P) to fill those gaps separately. Recommended only " +
        "after you've verified those backfill commands work on your vault.",
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.fastSyncMode)
        .onChange(async (value) => {
          this.plugin.settings.fastSyncMode = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Eagle library path")
      .setDesc("Path to your Eagle library (e.g., /Users/you/Bookmarks.library)")
      .addText(text => text
        .setPlaceholder("/Users/you/Bookmarks.library")
        .setValue(this.plugin.settings.eagleLibraryPath)
        .onChange(async (value) => {
          this.plugin.settings.eagleLibraryPath = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Eagle API token")
      .setDesc("Token for Eagle API (optional — used to auto-detect library path)")
      .addText(text => text
        .setPlaceholder("your-eagle-token")
        .setValue(this.plugin.settings.eagleToken)
        .onChange(async (value) => {
          this.plugin.settings.eagleToken = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("TMDB API key")
      .setDesc(
        "Optional. Used to resolve Letterboxd deep links for Films/Series/Documentaries. " +
        "Free signup at themoviedb.org. Leave blank to use search-URL fallback only.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Your TMDB v3 API key")
          .setValue(this.plugin.settings.tmdbApiKey)
          .onChange(async (value) => {
            this.plugin.settings.tmdbApiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("CLIP fusion strength (α)")
      .setDesc("Blend visual + text similarity in Smart Assign. 0 = text only, 1 = CLIP only. Default 0.5. Takes effect on next Smart Assign run.")
      .addText(text => text
        .setPlaceholder("0.5")
        .setValue(String(this.plugin.settings.clipFusionAlpha))
        .onChange(async (value) => {
          const n = parseFloat(value);
          this.plugin.settings.clipFusionAlpha = Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("OMDB API key")
      .setDesc("API key for film/TV cover fetch (fetch-covers command)")
      .addText(text => text
        .setPlaceholder("your-omdb-key")
        .setValue(this.plugin.settings.omdbApiKey)
        .onChange(async (value) => {
          this.plugin.settings.omdbApiKey = value.trim();
          await this.plugin.saveSettings();
        })
      );

    // ── Agent memory ──
    containerEl.createEl("h3", { text: "Agent memory" });

    new Setting(containerEl)
      .setName("Enable agent memory")
      .setDesc(
        "When enabled, the weekly digest pipeline writes a domain-interest " +
        "knowledge graph to Memory/ in the vault: Memory/MEMORY.md (a routing " +
        "index sized for an agent system prompt), MEMORY-archive.md, and " +
        "per-topic files under Memory/topics/. Intended for consumption by an " +
        "external agentic LLM — e.g. a Nous Research Hermes agent that reads " +
        "Memory/MEMORY.md. Default off: existing digest behavior is unchanged " +
        "when disabled."
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.memoryEnabled)
        .onChange(async (value) => {
          this.plugin.settings.memoryEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Memory judge model")
      .setDesc(
        "Ollama model used by the concept-router + claim-novelty LLM " +
        "judges. \"default\" reuses the digest's evaluation model. " +
        "Should be switched to whatever Hermes is running once that " +
        "integration ships, so writer and reader share a model family."
      )
      .addText(text => text
        .setPlaceholder("default")
        .setValue(this.plugin.settings.memoryJudgeModel)
        .onChange(async (value) => {
          this.plugin.settings.memoryJudgeModel = value.trim() || "default";
          await this.plugin.saveSettings();
        })
      );

  }
}
