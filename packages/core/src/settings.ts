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
  /** Smart Assign top-level scoring: when true (default), assign each item to its
   *  top-1 nearest category centroid and skip the dual-LLM rerank. Validated to
   *  beat the ensemble on honest labels (+11.7pp; adversary could-not-refute —
   *  see docs/superpowers/specs/2026-06-16-honest-eval-results.md). Set false to
   *  restore the LLM rerank. */
  smartAssignEmbeddingOnly: boolean;
  /** When true, Smart Assign Step 1 uses the trained LogReg classifier head
   *  (<vault>/.roost/cache/classifier-head.json) instead of nearest-centroid.
   *  Default true (the validated honest-eval default) — flip only after the
   *  validation gate passes (top-1 ≈ 0.68, rejection AUROC > 0.52 on holdout).
   *  Falls back to nearest-centroid when the weights file is absent or its classes
   *  don't match the current category set.
   *  See docs/superpowers/specs/2026-06-18-classifier-head-design.md. */
  smartAssignClassifierHead: boolean;
  /** When true, Smart Assign uses the multi-label tag-detector forward pass
   *  (tag-detectors.ts) instead of the classifier-head/centroid single-label path.
   *  Produces a { primary, tags: string[] } result per item; confirm writes
   *  roost_category = primary AND appends category/* native tags. Falls back to
   *  the existing path when the tag-detectors.json weights file is absent.
   *  Default false — flip only after D1 validation on a sample of items.
   *  See docs/superpowers/specs/2026-06-19-tag-system-wave2-smartassign.md. */
  smartAssignTags: boolean;
  /** Wave: logit stacking. When true (and the head + embedding-only paths are
   *  on), Smart Assign Step 1 combines a text-only and a vision-on classifier
   *  head via a trained meta-head. Falls back to the single head when the
   *  stacked weight files are absent/mismatched. Default true since the
   *  acceptance gate (balanced heads, qwen cover-only): overall top-1 TikTok
   *  72.0→76.9% (+4.9pp), Twitter 47.7→54.7% (+7.0pp). The two sub-margin
   *  per-category dips (TikTok Media −8.4pp, Spicy −8.3pp) were hand-audited as
   *  label-ambiguity / SFW-cover edge cases, not real regressions, and accepted.
   *  NOTE: the stacked heads expect qwen cover-only vision-on + text-only
   *  embeddings — re-run Smart Assign (describe + dual-embed) so the runtime
   *  cache matches before relying on this path. */
  smartAssignStacking: boolean;
  /** When true, confirming Smart Assign triggers a retrain of the per-vault
   *  classifier head via the Python sidecar (off-thread, seconds). The new head
   *  is swapped in only when the acceptance gate passes — fail-closed. Default
   *  true — retrain now runs off-thread in the sidecar so it no longer blocks
   *  the UI. Set false to disable auto-retrain entirely.
   *  See docs/superpowers/specs/2026-06-26-self-improving-loop-design.md. */
  smartAssignAutoRetrain: boolean;
  /** Names of the user's OWN categories that handle uncensored/explicit content
   *  (e.g. ["Spicy"], ["Adult"]). This is the only place an uncensored category
   *  is named — the product code never hardcodes one. Categories listed here route
   *  through the uncensored content side branch: the local image classifier
   *  (uncensored-image-detector.ts / sidecar /classify-uncensored) instead of /
   *  OR'd with the text detector for classification, and image/GT evaluation
   *  instead of the cloud LLM (which refuses explicit/uncensored content). Empty
   *  by default — the uncensored content side branch is inert until the user
   *  flags a category. */
  uncensoredCategories: string[];
  /** Names of the user's categories that are FACETS (tones/cross-cutting, not
   *  topics — e.g. ["Humor","Spicy"]). Facets are almost always SECONDARY labels,
   *  so they get recall-target detector thresholds (facet-detectors.json) instead
   *  of the base-rate topical thresholds. The only place facets are named — no
   *  taxonomy is hardcoded. Empty by default. (train-facet-detectors.py --facets
   *  should match this list.) */
  facetCategories: string[];
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
  /** True after the first-run onboarding completes. Default false — the inline
   *  onboarding panel shows at the top of the Hub on first launch and can be
   *  re-shown via the "Re-run first-time setup" command. */
  setupComplete: boolean;
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
  smartAssignEmbeddingOnly: true,
  smartAssignClassifierHead: true,
  smartAssignTags: false,
  smartAssignStacking: true,
  // Retrain now runs in the sidecar (off-thread, seconds) — safe to default ON.
  smartAssignAutoRetrain: true,
  uncensoredCategories: [],
  facetCategories: [],
  anthropicApiKey: "",
  anthropicModel: "claude-haiku-4-5-20251001",
  tmdbApiKey: "",
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
  setupComplete: false,
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
      .setName("Auto-retrain classifier on Smart Assign")
      .setDesc("When enabled, each Smart Assign run first retrains the per-vault head from your accumulated corrections (in-process, before scoring) — the new head is swapped in only if it beats the current one on a held-out check, else the current head is kept. Off by default.")
      .addToggle((t) => t.setValue(this.plugin.settings.smartAssignAutoRetrain).onChange(async (v) => {
        this.plugin.settings.smartAssignAutoRetrain = v; await this.plugin.saveSettings();
      }));

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
