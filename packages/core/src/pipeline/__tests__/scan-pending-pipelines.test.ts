/**
 * Unit tests for scanPendingPipelines.
 *
 * Uses an in-memory / temp-disk vault so we can call loadPipelineCache
 * and the real gate logic without spinning up Ollama or the full plugin.
 *
 * Test cases (per plan 052 §Test plan):
 *   (a) In-scope candidate with NO cache entry → counted pending
 *   (b) cache entry {triage:"skip", extraction:null} → NOT pending (anti-nag)
 *   (c) {triage:"recipe", extraction:<set>} + enrichment_v_recipe===schemaVersion → not pending, not stale
 *   (d) {triage:"recipe", extraction:null} (triaged-to-extract) → counted pending
 *   (e) cache entry present + enrichment_v_recipe < schemaVersion → stale, not pending
 *   (f) gate off (pipeline toggled off or LLM down) → blocked:true, count 0
 *   (g) item whose embedded.category does not match → not a candidate → not counted
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter, TFile } from "obsidian";
import { scanPendingPipelines } from "@/pipeline/scan-pending-pipelines";
import { savePipelineCache, __resetEmbeddingCache } from "@/pipeline/shared";
import { getEnrichmentById } from "@/lib/enrichments";

// ── Helpers ──

interface FakeAppResult {
  vault: ReturnType<typeof makeVaultLike>;
  metadataCache: ReturnType<typeof makeMetadataCacheLike>;
  syncFolder: string;
}

function makeVaultLike(baseDir: string, files: Map<string, string>) {
  const adapter = new FileSystemAdapter();
  adapter.basePath = baseDir;
  return {
    adapter,
    getAbstractFileByPath: (p: string) =>
      files.has(p) ? (Object.assign(new TFile(), { path: p }) as unknown) : null,
    read: async (f: unknown) => files.get((f as { path: string }).path) ?? "",
    getMarkdownFiles: () =>
      Array.from(files.keys())
        .filter(p => p.endsWith(".md"))
        .map(p => Object.assign(new TFile(), { path: p })),
  };
}

function makeMetadataCacheLike(files: Map<string, string>) {
  return {
    getFileCache: (f: unknown) => {
      const content = files.get((f as { path: string }).path) ?? "";
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, unknown> = {};
      for (const line of fmMatch[1].split("\n")) {
        const m = line.match(/^([\w][\w_]*):\s*(.+)$/);
        if (m) {
          const val = m[2].replace(/^"|"$/g, "").trim();
          fm[m[1]] = isNaN(Number(val)) || val === "" ? val : Number(val);
        }
      }
      return { frontmatter: fm };
    },
  };
}

function seedEmbeddingCache(
  baseDir: string,
  entries: Record<string, { category: string }>,
) {
  const cacheDir = path.join(baseDir, ".roost", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const embeddingCache: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(entries)) {
    embeddingCache[id] = { category: e.category, vec: null, summary: "" };
  }
  fs.writeFileSync(path.join(cacheDir, "embedding-cache.json"), JSON.stringify(embeddingCache));
  // Write minimal vector file
  const keys = Object.keys(entries);
  const VEC_DIM = 768;
  const header = Buffer.from(JSON.stringify(keys) + "\n", "utf8");
  const floatBuf = Buffer.alloc(keys.length * VEC_DIM * 4, 0);
  fs.writeFileSync(path.join(cacheDir, "embedding-vectors.bin"), Buffer.concat([header, floatBuf]));
}

function makeApp(
  baseDir: string,
  roostId: string,
  embeddingCategory: string,
  frontmatterExtra: Record<string, string | number> = {},
): FakeAppResult {
  const syncFolder = "Bookmarks";
  const shortId = roostId.replace("tiktok:", "");
  const relPath = `${syncFolder}/TikTok/tiktok-${shortId}/note.md`;

  const noteLines = [`roost_id: ${roostId}`, `title: Test note`];
  for (const [k, v] of Object.entries(frontmatterExtra)) {
    noteLines.push(`${k}: ${v}`);
  }
  const noteContent = `---\n${noteLines.join("\n")}\n---\n`;

  const noteDir = path.join(baseDir, path.dirname(relPath));
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, relPath), noteContent);

  seedEmbeddingCache(baseDir, { [roostId]: { category: embeddingCategory } });

  const files = new Map<string, string>();
  files.set(relPath, noteContent);

  const vault = makeVaultLike(baseDir, files);
  const metadataCache = makeMetadataCacheLike(files);

  return { vault, metadataCache, syncFolder };
}

function makePlugin(
  { vault, metadataCache, syncFolder }: FakeAppResult,
  opts?: {
    pipelinesOn?: boolean;
    ollamaStatus?: "available" | "unavailable" | "unknown";
  },
): Parameters<typeof scanPendingPipelines>[0] {
  const on = opts?.pipelinesOn ?? true;
  const pipelineFlags = {
    recipe: on, place: on, mediaExtraction: on, product: on,
    workout: on, tutorial: on, home: on,
    playback: on, articleBody: on, thread: on, mediaFiles: on,
    tweetBody: on, transcript: on,
  };
  return {
    app: { vault, metadataCache } as unknown as Parameters<typeof scanPendingPipelines>[0]["app"],
    settings: {
      syncFolder,
      llmBackend: "local",
      anthropicApiKey: "",
      integrations: { ollama: true },
      pipelines: pipelineFlags,
    },
    integrationStatus: { ollama: opts?.ollamaStatus ?? "available" },
  } as unknown as Parameters<typeof scanPendingPipelines>[0];
}

// ── Constants ──

const RECIPE_DEF = getEnrichmentById("recipe")!;
const RECIPE_CACHE_FILE = RECIPE_DEF.cacheFile!;

// ── Tests ──

describe("scanPendingPipelines", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-scan-pending-"));
    __resetEmbeddingCache();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    __resetEmbeddingCache();
  });

  it("(a) in-scope candidate with no cache entry → counted pending", () => {
    const fake = makeApp(tmp, "tiktok:r1", "recipe", { roost_category: "Recipes" });
    const plugin = makePlugin(fake);
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].pending).toBeGreaterThanOrEqual(1);
    expect(result.byPipeline["recipe"].blocked).toBe(false);
    expect(result.pendingItemIds["recipe"]).toContain("tiktok:r1");
  });

  it("(b) skip-verdict cache entry → NOT pending (anti-nag)", () => {
    const fake = makeApp(tmp, "tiktok:r1", "recipe", { roost_category: "Recipes" });
    savePipelineCache(
      fake.vault as unknown as Parameters<typeof savePipelineCache>[0],
      RECIPE_CACHE_FILE,
      { "tiktok:r1": { triage: "skip", extraction: null } },
    );
    const plugin = makePlugin(fake);
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].pending).toBe(0);
    expect(result.pendingItemIds["recipe"]).toHaveLength(0);
  });

  it("(c) completed extraction + current schema → not pending, not stale", () => {
    // A note WITHOUT the enrichment_v_recipe field → isVersionStale returns false (legacy items
    // are not auto-flagged). So a completed extraction is not stale by default.
    const fake = makeApp(tmp, "tiktok:r1", "recipe", { roost_category: "Recipes" });
    savePipelineCache(
      fake.vault as unknown as Parameters<typeof savePipelineCache>[0],
      RECIPE_CACHE_FILE,
      { "tiktok:r1": { triage: "recipe", extraction: { title: "Carbonara" } } },
    );
    const plugin = makePlugin(fake);
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].pending).toBe(0);
    expect(result.byPipeline["recipe"].stale).toBe(0);
  });

  it("(d) {triage:'recipe', extraction:null} → counted pending (triaged-to-extract)", () => {
    const fake = makeApp(tmp, "tiktok:r1", "recipe", { roost_category: "Recipes" });
    savePipelineCache(
      fake.vault as unknown as Parameters<typeof savePipelineCache>[0],
      RECIPE_CACHE_FILE,
      { "tiktok:r1": { triage: "recipe", extraction: null } },
    );
    const plugin = makePlugin(fake);
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].pending).toBe(1);
    expect(result.pendingItemIds["recipe"]).toContain("tiktok:r1");
  });

  it("(e) enrichment_v_recipe < schemaVersion → stale, not pending", () => {
    const schemaV = RECIPE_DEF.schemaVersion;
    // Note has an OLD enrichment_v_recipe field
    const fake = makeApp(tmp, "tiktok:r1", "recipe", {
      [`enrichment_v_recipe`]: schemaV - 1,
      roost_category: "Recipes",
    });
    // Completed (non-pending) cache entry
    savePipelineCache(
      fake.vault as unknown as Parameters<typeof savePipelineCache>[0],
      RECIPE_CACHE_FILE,
      { "tiktok:r1": { triage: "recipe", extraction: { title: "Old Carbonara" } } },
    );
    const plugin = makePlugin(fake);
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].pending).toBe(0);
    expect(result.byPipeline["recipe"].stale).toBe(1);
  });

  it("(f) pipeline toggled off → blocked:true, count 0", () => {
    const fake = makeApp(tmp, "tiktok:r1", "recipe");
    const plugin = makePlugin(fake, { pipelinesOn: false });
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].blocked).toBe(true);
    expect(result.byPipeline["recipe"].pending).toBe(0);
  });

  it("(f) LLM unavailable → blocked:true", () => {
    const fake = makeApp(tmp, "tiktok:r1", "recipe");
    const plugin = makePlugin(fake, { ollamaStatus: "unavailable" });
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].blocked).toBe(true);
  });

  it("(g) item with non-matching category → not a candidate → not counted", () => {
    const fake = makeApp(tmp, "tiktok:r1", "random-unrelated-thing");
    const plugin = makePlugin(fake);
    const result = scanPendingPipelines(plugin, Date.now());
    expect(result.byPipeline["recipe"].pending).toBe(0);
    expect(result.pendingItemIds["recipe"]).toHaveLength(0);
  });
});
