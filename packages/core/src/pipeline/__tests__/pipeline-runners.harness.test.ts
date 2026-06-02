/**
 * Slice 4: Per-pipeline integration harness.
 *
 * Verifies that every pipeline runner:
 *   1. reads from a tmpdir vault with one synced note + embedding cache entry
 *   2. triages (via stub Ollama), extracts (via stub Ollama), writes one output note
 *   3. is idempotent on re-run
 *   4. treats triage verdict "skip" correctly (no note written, skip cached)
 *
 * NOTE: abort-signal tests are it.skip because the registry runner adapters do
 * not propagate opts.signal to the underlying pipeline functions.
 * Adding abort support is out of scope for this slice.
 */
import { describe, it, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  App, FileSystemAdapter, TFile,
  __setRequestUrlImpl, __resetRequestUrlImpl,
} from "obsidian";
// ENRICHMENTS registry is no longer needed directly in this harness —
// each pipeline is driven via its underlying run function. Import kept
// as a placeholder in case future tests want to iterate the registry.
// import { ENRICHMENTS } from "@/lib/enrichments";
import { __resetEmbeddingCache } from "@/pipeline/shared";
import {
  makeRecipeExtraction, makePlaceExtraction, makeMediaExtraction,
  makeProductExtraction, makeWorkoutExtraction, makeTutorialExtraction, makeHomeExtraction,
} from "@/__tests__/fixtures";
import type { AnyExtractionData } from "@/types/roost";
import {
  TUTORIAL_FIELDS, computeTutorialBackfillFields, writeTutorialToBookmark,
} from "@/pipeline/tutorials-pipeline";

// ── Harness adapter ──
//
// The old pipeline-registry had a `runner(app, opts) → PipelineRunResult` API.
// We now drive each pipeline directly via its run function so we can normalize
// the result counts into the {processed, written, skipped, errors} shape the
// harness assertions expect. ENRICHMENTS is imported for any tests that iterate
// the registry, but the per-pipeline runner wrappers call the underlying run
// functions directly.

import { runRecipePipeline } from "@/pipeline/recipe-pipeline";
import { runPlacesPipeline } from "@/pipeline/places-pipeline";
import { runMediaPipeline } from "@/pipeline/media-pipeline";
import { runProductsPipeline } from "@/pipeline/products-pipeline";
import { runWorkoutsPipeline } from "@/pipeline/workouts-pipeline";
import { runTutorialsPipeline } from "@/pipeline/tutorials-pipeline";
import { runHomePipeline } from "@/pipeline/home-pipeline";

/** Per-pipeline cache file names (matches CACHE_FILE constants in each pipeline). */
const CACHE_FILES: Record<string, string> = {
  recipe: "recipe-cache.json",
  place: "places-cache.json",
  media: "media-cache.json",
  product: "products-cache.json",
  workout: "workouts-cache.json",
  tutorial: "tutorials-cache.json",
  home: "home-cache.json",
};

/** Per-pipeline output dirs — kept for legacy test assertions. All pipelines
 *  now write in-place to Bookmarks/, so these dirs no longer receive new files;
 *  the per-pipeline describe blocks verify in-place enrichment directly. */
const OUTPUT_DIRS: Record<string, string> = {
  recipe: "Pipelines/Recipes",
  place: "Pipelines/Places",
  media: "Pipelines/Media",
  product: "Pipelines/Products",
  workout: "Pipelines/Workouts",
  tutorial: "Pipelines/Tutorials",
  home: "Pipelines/Home",
};

/** Normalized result shape returned by all runner adapters. */
interface PipelineRunResult {
  processed: number;
  written: number;
  skipped: number;
  errors: number;
}

/** Run-options passed from the harness to each pipeline runner. */
interface PipelineRunOpts {
  syncFolder: string;
  onLog?: (msg: string) => void;
  filter?: { category: string; subcategory?: string };
}

/** Thin wrapper that gives each pipeline the shape the harness test expects. */
interface PipelineDef {
  id: string;
  runner: (app: App, opts: PipelineRunOpts) => Promise<PipelineRunResult>;
  outputDir: string;
  cacheFile: string;
}

/** Build a PipelineDef harness wrapper for a given pipeline id. */
function toPipelineDef(pipelineId: string): PipelineDef {
  const outputDir = OUTPUT_DIRS[pipelineId] ?? "Pipelines/Unknown";
  const cacheFile = CACHE_FILES[pipelineId] ?? `${pipelineId}-cache.json`;

  let runner: PipelineDef["runner"];
  switch (pipelineId) {
    case "recipe":
      runner = async (app, opts) => {
        const r = await runRecipePipeline(app, opts.syncFolder, opts.onLog);
        return { processed: r.candidates, written: r.recipes, skipped: r.skipped + r.restaurants, errors: r.errors };
      };
      break;
    case "place":
      runner = async (app, opts) => {
        const r = await runPlacesPipeline(app, opts.syncFolder, opts.onLog);
        return { processed: r.candidates ?? 0, written: r.places ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 };
      };
      break;
    case "media":
      runner = async (app, opts) => {
        const r = await runMediaPipeline(app, opts.syncFolder, opts.onLog, opts.filter);
        return { processed: r.candidates ?? 0, written: r.media ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 };
      };
      break;
    case "product":
      runner = async (app, opts) => {
        const r = await runProductsPipeline(app, opts.syncFolder, opts.onLog);
        return { processed: r.candidates ?? 0, written: r.products ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 };
      };
      break;
    case "workout":
      runner = async (app, opts) => {
        const r = await runWorkoutsPipeline(app, opts.syncFolder, opts.onLog);
        return { processed: r.candidates ?? 0, written: r.workouts ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 };
      };
      break;
    case "tutorial":
      runner = async (app, opts) => {
        const r = await runTutorialsPipeline(app, opts.syncFolder, opts.onLog);
        return { processed: r.candidates ?? 0, written: r.tutorials ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 };
      };
      break;
    case "home":
      runner = async (app, opts) => {
        const r = await runHomePipeline(app, opts.syncFolder, opts.onLog);
        return { processed: r.candidates ?? 0, written: r.ideas ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 };
      };
      break;
    default:
      throw new Error(`Unknown pipeline id: ${pipelineId}`);
  }

  return { id: pipelineId, runner, outputDir, cacheFile };
}

// ── Legacy PIPELINES shim (used by test lookup code below) ──
const PIPELINES = {
  find: (pred: (p: PipelineDef) => boolean): PipelineDef | undefined => {
    for (const id of Object.keys(CACHE_FILES)) {
      const def = toPipelineDef(id);
      if (pred(def)) return def;
    }
    return undefined;
  },
};

// ── Types ──

type PipelineId = string;

interface HarnessCase {
  id: PipelineId;
  triageVerdict: string;
  extractionFixture: AnyExtractionData;
  outputDirRe: RegExp;
  /** Subset of frontmatter keys that MUST be present in the written note. */
  expectedFrontmatterKeys: string[];
  /**
   * Category value stored in .roost/embedding-cache.json.
   * Must be in the pipeline's filter set (e.g. RECIPE_CATEGORIES, HOME_CATEGORIES…).
   */
  embeddingCategory: string;
}

// ── Cases ──
//
// Notes on reconciled values vs. the plan template:
//   - places:    pipeline frontmatter value is "places" (not "place")
//   - products:  pipeline frontmatter value is "products" (not "product")
//   - workouts:  pipeline frontmatter value is "workouts" (not "workout")
//   - tutorials: pipeline frontmatter value is "tutorials" (not "tutorial")
//   - tutorial:  frontmatter key is "topic" (not "skill"); "skill_area" (not "skill")
//   - home:      frontmatter key is "title" + "idea_type" (not "idea")
//   - abort:     it.skip — signal not propagated by registry adapters (see file header)

const CASES: HarnessCase[] = [
  // Place intentionally excluded from this harness: post-Phase-B.2 it writes
  // extracted fields onto the SOURCE bookmark's frontmatter (no Pipelines/
  // Places/<Country>/<Place>.md note). Its assertions live in the
  // Place-specific test block below.
  // Media intentionally excluded from this harness: post-Phase-A.1 it writes
  // extracted fields onto the SOURCE bookmark's frontmatter (no Pipelines/
  // Media/<X>.md note, no derived index notes). Its assertions live in the
  // Media-specific test block below. Other pipelines still follow the
  // legacy "spawn a note" model and use this harness — they migrate in
  // Phases B and C.
  // Product intentionally excluded from this harness: post-Task-7 it writes
  // extracted fields onto the SOURCE bookmark's frontmatter (no Pipelines/
  // Products/<Type>/<Product>.md note). Its assertions live in the
  // Product-specific test block below.
  // Workout intentionally excluded from this harness: post-Task-8 it writes
  // extracted fields onto the SOURCE bookmark's frontmatter (no Pipelines/
  // Workouts/<Type>/<Workout>.md note). Its assertions live in the
  // Workout-specific test block below.
  // Home intentionally excluded: post-Task-10 it writes extracted fields onto
  // the SOURCE bookmark's frontmatter. Its assertions live in the
  // Home-specific test block below.
];

// ── App factory ──

/**
 * Build an in-memory App over baseDir.
 * Pre-seeds `files` map with any markdown files already on disk inside baseDir
 * so that vault.getMarkdownFiles() returns them from the start.
 */
/** Recursive walk to find the first .md file under root. Used by the
 *  subcategory-backfill tests to locate the sync note that makeRawSyncFile
 *  buries under <syncFolder>/<Platform>/<platform-id>/<...>.md. */
function findMdUnder(root: string): string {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      try { return findMdUnder(full); } catch { /* keep searching */ }
    } else if (entry.name.endsWith(".md")) {
      return full;
    }
  }
  throw new Error(`No .md file under ${root}`);
}

function makeApp(baseDir: string): App {
  const files = new Map<string, string>();

  // Pre-seed with any markdown files already written to disk (sync files)
  function seedFromDisk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        seedFromDisk(full);
      } else if (entry.name.endsWith(".md")) {
        const relPath = path.relative(baseDir, full);
        const content = fs.readFileSync(full, "utf-8");
        files.set(relPath, content);
      }
    }
  }
  seedFromDisk(baseDir);

  const adapter = new FileSystemAdapter();
  adapter.basePath = baseDir;

  const vault = {
    adapter,
    getAbstractFileByPath: (p: string) =>
      files.has(p) ? (Object.assign(new TFile(), { path: p }) as any) : null,
    read: async (f: any) => files.get(f.path) ?? "",
    create: async (p: string, content: string) => {
      if (files.has(p)) throw new Error("File already exists: " + p);
      files.set(p, content);
      fs.mkdirSync(path.dirname(path.join(baseDir, p)), { recursive: true });
      fs.writeFileSync(path.join(baseDir, p), content);
      return Object.assign(new TFile(), { path: p }) as any;
    },
    modify: async (f: any, content: string) => {
      files.set(f.path, content);
      fs.writeFileSync(path.join(baseDir, f.path), content);
    },
    createFolder: async () => {},
    getMarkdownFiles: () =>
      Array.from(files.keys())
        .filter(p => p.endsWith(".md"))
        .map(p => Object.assign(new TFile(), { path: p })),
  };

  const metadataCache = {
    getFileCache: (f: any) => {
      const content = files.get(f.path) ?? "";
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, any> = {};
      for (const line of fmMatch[1].split("\n")) {
        const m = line.match(/^(\w[\w_]*):\s*(.+)$/);
        if (m) fm[m[1]] = m[2].replace(/^"|"$/g, "");
      }
      return { frontmatter: fm };
    },
  };

  return { vault, metadataCache, workspace: { getLeaf: () => null } } as any;
}

// ── Sync-file factory ──

/**
 * Write a sync-folder markdown file that buildFileIndex will pick up.
 * The roostId MUST follow platform:id format (tiktok:xxx) so readRawJson
 * can locate the sidecar. We also write a minimal raw.json sidecar.
 * The embedding cache entry seeds gatherCandidates' category filter.
 */
function makeRawSyncFile(
  baseDir: string,
  roostId: string,          // e.g. "tiktok:recipe_1"
  syncFolder: string,       // e.g. "Bookmarks/synced"
  embeddingCategory: string,
): void {
  // 1. Parse platform and id
  const colonIdx = roostId.indexOf(":");
  const platform = roostId.slice(0, colonIdx);   // "tiktok" | "twitter"
  const itemId = roostId.slice(colonIdx + 1);    // "recipe_1"
  const platformFolder = platform === "twitter" ? "X" : "TikTok";
  const attachFolder = `${platform}-${itemId}`;

  // 2. Write sync markdown note with roost_id frontmatter
  const noteDir = path.join(baseDir, syncFolder, platformFolder, attachFolder);
  fs.mkdirSync(noteDir, { recursive: true });
  const noteContent = `---
roost_id: ${roostId}
title: "Test post for ${roostId}"
subtitle: ""
source: tiktok
---

How to do a thing. Step by step instructions.
`;
  fs.writeFileSync(path.join(noteDir, `${attachFolder}.md`), noteContent);

  // 3. Write minimal raw.json sidecar
  const rawJson = {
    text: `Test content for ${roostId}`,
    author: { uniqueId: "testuser", signature: "" },
  };
  fs.writeFileSync(path.join(noteDir, "raw.json"), JSON.stringify(rawJson));

  // 4. Seed embedding cache
  const roostDir = path.join(baseDir, ".roost", "cache");
  fs.mkdirSync(roostDir, { recursive: true });

  const cachePath = path.join(roostDir, "embedding-cache.json");
  let cache: Record<string, any> = {};
  if (fs.existsSync(cachePath)) {
    try { cache = JSON.parse(fs.readFileSync(cachePath, "utf-8")); } catch { /* ignore */ }
  }
  cache[roostId] = { vision: "Test visual description", summary: "", category: embeddingCategory, vec: null };
  fs.writeFileSync(cachePath, JSON.stringify(cache));

  // 5. Write embedding-vectors.bin with a zero-vector entry so loadEmbeddingCache
  //    takes the vecMap.size > 0 path and reads the JSON text cache alongside it.
  //    Without at least one entry, the function short-circuits and returns {}.
  const binPath = path.join(roostDir, "embedding-vectors.bin");
  {
    const allKeys = Array.from(new Set([
      ...Object.keys(cache),
      ...((): string[] => {
        if (fs.existsSync(binPath)) {
          try {
            const buf = fs.readFileSync(binPath);
            const nl = buf.indexOf(10);
            if (nl >= 0) return JSON.parse(buf.slice(0, nl).toString("utf8"));
          } catch { /* ignore */ }
        }
        return [];
      })(),
    ]));
    const VEC_DIM = 768;
    const header = Buffer.from(JSON.stringify(allKeys) + "\n", "utf8");
    const floatBuf = Buffer.alloc(allKeys.length * VEC_DIM * 4, 0); // zero-vectors
    fs.writeFileSync(binPath, Buffer.concat([header, floatBuf]));
  }
}

// ── Ollama stub ──

function installOllamaStub(triageVerdict: string, extractionJson: object) {
  __setRequestUrlImpl(async (req) => {
    const body = JSON.parse(req.body ?? "{}");
    // Triage uses num_predict <= 10
    if ((body.options?.num_predict ?? 999) <= 10) {
      return { status: 200, json: { response: triageVerdict }, text: "" };
    }
    // Extraction: return the full fixture JSON
    return { status: 200, json: { response: JSON.stringify(extractionJson) }, text: "" };
  });
}

// ── Suite ──

describe("pipeline runners — uniform harness", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-harness-"));
  });

  afterEach(() => {
    __resetRequestUrlImpl();
    __resetEmbeddingCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Happy-path: single post writes one note ──

  for (const c of CASES) {
    it(`${c.id}: single post writes one note with expected frontmatter`, async () => {
      const roostId = `tiktok:${c.id}_1`;
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", c.embeddingCategory);
      installOllamaStub(c.triageVerdict, c.extractionFixture);

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === c.id) as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.errors).toBe(0);
      expect(result.written).toBe(1);

      const written = app.vault.getMarkdownFiles()
        .map((f: any) => f.path)
        .filter((p: string) => p.startsWith(def.outputDir));
      expect(written.length).toBeGreaterThanOrEqual(1);

      // At least one note (not an index) matches the outputDirRe
      const notePaths = written.filter((p: string) => !p.toLowerCase().includes("index"));
      expect(notePaths.length).toBeGreaterThanOrEqual(1);
      expect(notePaths[0]).toMatch(c.outputDirRe);

      // Check frontmatter of first non-index output note
      const file = app.vault.getAbstractFileByPath(notePaths[0]) as any;
      const fm = (app as any).metadataCache.getFileCache(file)?.frontmatter ?? {};
      for (const key of c.expectedFrontmatterKeys) {
        expect(fm, `missing frontmatter key "${key}" in ${notePaths[0]}`).toHaveProperty(key);
      }
    });
  }

  // ── Idempotent re-run ──
  //
  // The underlying pipeline functions re-write cached extractions on every run
  // (to pick up quality score / format updates), so result.written reflects
  // "notes written or updated", not "new notes created". We verify idempotency
  // by checking that the FILE COUNT in the output dir doesn't grow on re-run.

  for (const c of CASES) {
    it(`${c.id}: idempotent rerun creates no new notes`, async () => {
      const roostId = `tiktok:${c.id}_idem`;
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", c.embeddingCategory);
      installOllamaStub(c.triageVerdict, c.extractionFixture);

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === c.id) as PipelineDef;

      const first = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(first.written).toBeGreaterThan(0);
      expect(first.errors).toBe(0);

      // Count files in output dir after first run
      const countOutputFiles = () => {
        const outDir = path.join(tmp, def.outputDir);
        if (!fs.existsSync(outDir)) return 0;
        let count = 0;
        function walk(d: string) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(path.join(d, e.name));
            else if (e.name.endsWith(".md")) count++;
          }
        }
        walk(outDir);
        return count;
      };

      const filesAfterFirst = countOutputFiles();
      expect(filesAfterFirst).toBeGreaterThan(0);

      // Reset embedding singleton so second run re-reads the same cache file
      __resetEmbeddingCache();

      // Second run — same Ollama stubs, same input
      const second = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(second.errors).toBe(0);

      const filesAfterSecond = countOutputFiles();
      expect(filesAfterSecond).toBe(filesAfterFirst); // no new files created
      expect(second.written).toBeLessThanOrEqual(first.written); // no write-count explosion
    });
  }

  // ── Abort test — TODO: signal not propagated by registry adapters ──
  //
  // The runner adapters in pipeline-registry.ts call the underlying pipeline
  // functions without forwarding opts.signal, so abort cannot be tested at
  // this level without modifying production code. Registered as todo so these
  // surface in the vitest report as planned work, not false-positive skips.

  for (const c of CASES) {
    test.todo(`${c.id}: abort mid-run halts at next item boundary`);
  }

  // ── Skip triage ──

  for (const c of CASES) {
    it(`${c.id}: triage 'skip' writes no note and caches skip`, async () => {
      const roostId = `tiktok:${c.id}_skip`;
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", c.embeddingCategory);
      __setRequestUrlImpl(async () => ({ status: 200, json: { response: "skip" }, text: "" }));

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === c.id) as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.written).toBe(0);

      // The pipeline cache must record the skip so re-runs don't re-triage.
      // Unconditional: cache file exists, entry exists, triage is a skip verdict.
      // The skip vocabulary is "skip" or "none" — any pipeline-specific
      // positive verdicts (e.g. recipe's "restaurant") would have produced a
      // written note and failed the written === 0 check above.
      const cachePath = path.join(tmp, ".roost", "cache", def.cacheFile);
      expect(fs.existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      const entry = cache[roostId];
      expect(entry, `missing cache entry for ${roostId} in ${def.cacheFile}`).toBeTruthy();
      expect(entry.triage).toMatch(/^(skip|none)$/);
    });
  }

  // ── Media (post-Phase-A.1: enriches source bookmark in place) ──

  describe("media (in-place enrichment)", () => {
    it("writes media_* fields onto the source bookmark", async () => {
      const roostId = "tiktok:media_inplace_1";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "film");
      installOllamaStub("media", makeMediaExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.errors).toBe(0);
      expect(result.written).toBe(1);

      // No notes written under Pipelines/Media/.
      const pipelineNotes = app.vault.getMarkdownFiles()
        .map((f: any) => f.path)
        .filter((p: string) => p.startsWith("Pipelines/Media/"));
      expect(pipelineNotes).toEqual([]);

      // The source bookmark gained media_* fields in its frontmatter.
      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      expect(sourceFile).toBeDefined();
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm).toHaveProperty("media_title");
      expect(fm).toHaveProperty("media_creator");
      expect(fm).toHaveProperty("pipeline_v_media");
      // Single source of truth for the type lives in roost_subcategory
      // (rule 2 backfilled it). The pipeline does NOT also write media_type
      // — having both invites divergence.
      expect(fm).not.toHaveProperty("media_type");
      expect(fm).toHaveProperty("roost_subcategory");
    });

    it("idempotent: rerun stamps the same fields without churn", async () => {
      const roostId = "tiktok:media_inplace_idem";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "film");
      installOllamaStub("media", makeMediaExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;

      const first = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(first.written).toBe(1);

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const readContent = await (app as any).vault.read(sourceFile);

      // Re-run on the same vault.
      const second = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(second.errors).toBe(0);
      // The important assertion is no churn:
      const readContent2 = await (app as any).vault.read(sourceFile);
      expect(readContent2).toBe(readContent);
    });

    // ── Rule 2: subcategory backfill ─────────────────────────────────

    it("subcategory backfill: sets both roost_category + roost_subcategory when both empty", async () => {
      const roostId = "tiktok:media_subcat_blank";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "film");
      installOllamaStub("media", makeMediaExtraction({ mediaType: "book" }));

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;
      await def.runner(app, { syncFolder: "Bookmarks/synced" });

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm.roost_category).toBe("Media");
      expect(fm.roost_subcategory).toBe("Books");
    });

    it("subcategory backfill: fills subcategory only when category=\"Media\" is already set", async () => {
      const roostId = "tiktok:media_subcat_cat_only";
      // Pre-stamp the source bookmark with roost_category: "Media" but no subcategory.
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "film");
      const target = findMdUnder(path.join(tmp, "Bookmarks", "synced"));
      let content = fs.readFileSync(target, "utf-8");
      content = content.replace("---\n", "---\nroost_category: \"Media\"\n");
      fs.writeFileSync(target, content);

      installOllamaStub("media", makeMediaExtraction({ mediaType: "film" }));

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;
      await def.runner(app, { syncFolder: "Bookmarks/synced" });

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm.roost_category).toBe("Media");
      expect(fm.roost_subcategory).toBe("Films");
    });

    it("subcategory backfill: leaves both alone when category is set to something other than \"Media\"", async () => {
      const roostId = "tiktok:media_subcat_other_cat";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "film");
      const target = findMdUnder(path.join(tmp, "Bookmarks", "synced"));
      let content = fs.readFileSync(target, "utf-8");
      content = content.replace("---\n", "---\nroost_category: Travel\n");
      fs.writeFileSync(target, content);

      installOllamaStub("media", makeMediaExtraction({ mediaType: "film" }));

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;
      await def.runner(app, { syncFolder: "Bookmarks/synced" });

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm.roost_category).toBe("Travel");
      expect(fm.roost_subcategory).toBeUndefined();
      // Pipeline never writes media_type alongside the user's curation —
      // roost_subcategory is the single source of truth.
      expect(fm.media_type).toBeUndefined();
      // ...but the LLM-extracted data fields still land.
      expect(fm.media_title).toBeDefined();
    });

    // ── Rule 1: filter-scoped runs ───────────────────────────────────

    it("filter-scoped run: processes only bookmarks matching the filter", async () => {
      // Two bookmarks: one in Media/Books, one in Media/Films. Run with
      // a filter scoped to the Books subcategory; only that bookmark
      // should pick up media_* fields.
      makeRawSyncFile(tmp, "tiktok:filter_book", "Bookmarks/synced", "film");
      makeRawSyncFile(tmp, "tiktok:filter_film", "Bookmarks/synced", "film");

      // Stamp roost_category + roost_subcategory on each note.
      const allMd = (() => {
        const out: string[] = [];
        function walk(d: string) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".md")) out.push(full);
          }
        }
        walk(path.join(tmp, "Bookmarks", "synced"));
        return out;
      })();
      for (const md of allMd) {
        let content = fs.readFileSync(md, "utf-8");
        const subcat = md.includes("filter_book") ? "Books" : "Films";
        content = content.replace("---\n", `---\nroost_category: "Media"\nroost_subcategory: ${subcat}\n`);
        fs.writeFileSync(md, content);
      }

      installOllamaStub("media", makeMediaExtraction({ mediaType: "book" }));

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;
      const result = await def.runner(app, {
        syncFolder: "Bookmarks/synced",
        filter: { category: "Media", subcategory: "Books" },
      });

      expect(result.errors).toBe(0);
      expect(result.processed).toBe(1);
      expect(result.written).toBe(1);

      // The Books bookmark got stamped; the Films one didn't.
      const bookFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.includes("filter_book")) as any;
      const filmFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.includes("filter_film")) as any;
      const bookFm = (app as any).metadataCache.getFileCache(bookFile)?.frontmatter ?? {};
      const filmFm = (app as any).metadataCache.getFileCache(filmFile)?.frontmatter ?? {};
      expect(bookFm.media_title).toBeDefined();
      expect(filmFm.media_title).toBeUndefined();
    });

    it("subcategory backfill: never overrides existing subcategory and never writes a competing media_type", async () => {
      const roostId = "tiktok:media_subcat_already_set";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "film");
      const target = findMdUnder(path.join(tmp, "Bookmarks", "synced"));
      let content = fs.readFileSync(target, "utf-8");
      content = content.replace("---\n", "---\nroost_category: \"Media\"\nroost_subcategory: Films\n");
      fs.writeFileSync(target, content);

      // Pipeline classifies as a book, but user already chose Films. Both
      // signals coexist conceptually (LLM thinks book; user says film) but
      // we don't persist the LLM's media_type — roost_subcategory wins.
      installOllamaStub("media", makeMediaExtraction({ mediaType: "book" }));

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "media") as PipelineDef;
      await def.runner(app, { syncFolder: "Bookmarks/synced" });

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm.roost_subcategory).toBe("Films");
      expect(fm.media_type).toBeUndefined();
    });
  });

  // ── Recipe (post-Phase-B.1: enriches source bookmark in place) ──

  describe("recipe (in-place enrichment)", () => {
    it("writes recipe_* fields onto the source bookmark", async () => {
      const roostId = "tiktok:recipe_inplace_1";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "recipe");
      installOllamaStub("recipe", makeRecipeExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "recipe") as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.errors).toBe(0);
      expect(result.written).toBe(1);

      // No notes written under Pipelines/Recipes/.
      const pipelineNotes = app.vault.getMarkdownFiles()
        .map((f: any) => f.path)
        .filter((p: string) => p.startsWith("Pipelines/Recipes/"));
      expect(pipelineNotes).toEqual([]);

      // The source bookmark gained recipe_* fields in its frontmatter.
      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      expect(sourceFile).toBeDefined();
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm).toHaveProperty("recipe_dish");
      expect(fm).toHaveProperty("recipe_cuisine");
      expect(fm).toHaveProperty("enrichment_v_recipe");
      expect(fm).toHaveProperty("roost_subcategory");
    });

    it("idempotent: rerun stamps the same fields without churn", async () => {
      const roostId = "tiktok:recipe_inplace_idem";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "recipe");
      installOllamaStub("recipe", makeRecipeExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "recipe") as PipelineDef;

      const first = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(first.written).toBe(1);

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const readContent = await (app as any).vault.read(sourceFile);

      // Re-run on the same vault.
      const second = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(second.errors).toBe(0);
      // The important assertion is no churn:
      const readContent2 = await (app as any).vault.read(sourceFile);
      expect(readContent2).toBe(readContent);
    });
  });

  // ── Place (post-Phase-B.2: enriches source bookmark in place) ──

  describe("place (in-place enrichment)", () => {
    it("writes place_* fields onto the source bookmark", async () => {
      const roostId = "tiktok:place_inplace_1";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "travel");
      installOllamaStub("place", makePlaceExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "place") as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.errors).toBe(0);
      expect(result.written).toBe(1);

      // No notes written under Pipelines/Places/.
      const pipelineNotes = app.vault.getMarkdownFiles()
        .map((f: any) => f.path)
        .filter((p: string) => p.startsWith("Pipelines/Places/"));
      expect(pipelineNotes).toEqual([]);

      // The source bookmark gained place_* fields in its frontmatter.
      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      expect(sourceFile).toBeDefined();
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm).toHaveProperty("place_name");
      expect(fm).toHaveProperty("place_city");
      expect(fm).toHaveProperty("place_country");
      expect(fm).toHaveProperty("enrichment_v_place");
      expect(fm).toHaveProperty("roost_subcategory");
    });

    it("idempotent: rerun stamps the same fields without churn", async () => {
      const roostId = "tiktok:place_inplace_idem";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "travel");
      installOllamaStub("place", makePlaceExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "place") as PipelineDef;

      const first = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(first.written).toBe(1);

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const readContent = await (app as any).vault.read(sourceFile);

      // Re-run on the same vault.
      const second = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(second.errors).toBe(0);
      // The important assertion is no churn:
      const readContent2 = await (app as any).vault.read(sourceFile);
      expect(readContent2).toBe(readContent);
    });
  });

  // ── Product (post-Task-7: enriches source bookmark in place) ──

  describe("product (in-place enrichment)", () => {
    it("writes product_* fields onto the source bookmark", async () => {
      const roostId = "tiktok:product_inplace_1";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "product");
      installOllamaStub("product", makeProductExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "product") as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.errors).toBe(0);
      expect(result.written).toBe(1);

      // No notes written under Pipelines/Products/.
      const pipelineNotes = app.vault.getMarkdownFiles()
        .map((f: any) => f.path)
        .filter((p: string) => p.startsWith("Pipelines/Products/"));
      expect(pipelineNotes).toEqual([]);

      // The source bookmark gained product_* fields in its frontmatter.
      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      expect(sourceFile).toBeDefined();
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm).toHaveProperty("product_name");
      expect(fm).toHaveProperty("product_brand");
      expect(fm).toHaveProperty("enrichment_v_product");
      expect(fm).toHaveProperty("roost_subcategory");
    });

    it("idempotent: rerun stamps the same fields without churn", async () => {
      const roostId = "tiktok:product_inplace_idem";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "product");
      installOllamaStub("product", makeProductExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "product") as PipelineDef;

      const first = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(first.written).toBe(1);

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const readContent = await (app as any).vault.read(sourceFile);

      // Re-run on the same vault.
      const second = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(second.errors).toBe(0);
      // The important assertion is no churn:
      const readContent2 = await (app as any).vault.read(sourceFile);
      expect(readContent2).toBe(readContent);
    });
  });

  // ── Workout (post-Task-8: enriches source bookmark in place) ──

  describe("workout (in-place enrichment)", () => {
    it("writes workout_* fields onto the source bookmark", async () => {
      const roostId = "tiktok:workout_inplace_1";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "fitness");
      installOllamaStub("workout", makeWorkoutExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "workout") as PipelineDef;
      const result = await def.runner(app, { syncFolder: "Bookmarks/synced" });

      expect(result.errors).toBe(0);
      expect(result.written).toBe(1);

      // No notes written under Pipelines/Workouts/.
      const pipelineNotes = app.vault.getMarkdownFiles()
        .map((f: any) => f.path)
        .filter((p: string) => p.startsWith("Pipelines/Workouts/"));
      expect(pipelineNotes).toEqual([]);

      // The source bookmark gained workout_* fields in its frontmatter.
      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      expect(sourceFile).toBeDefined();
      const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
      expect(fm).toHaveProperty("workout_name");
      expect(fm).toHaveProperty("workout_target_area");
      expect(fm).toHaveProperty("enrichment_v_workout");
      expect(fm).toHaveProperty("roost_subcategory");
    });

    it("idempotent: rerun stamps the same fields without churn", async () => {
      const roostId = "tiktok:workout_inplace_idem";
      makeRawSyncFile(tmp, roostId, "Bookmarks/synced", "fitness");
      installOllamaStub("workout", makeWorkoutExtraction());

      const app = makeApp(tmp);
      const def = PIPELINES.find(p => p.id === "workout") as PipelineDef;

      const first = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(first.written).toBe(1);

      const sourceFile = app.vault.getMarkdownFiles()
        .find((f: any) => f.path.startsWith("Bookmarks/synced/")) as any;
      const readContent = await (app as any).vault.read(sourceFile);

      // Re-run on the same vault.
      const second = await def.runner(app, { syncFolder: "Bookmarks/synced" });
      expect(second.errors).toBe(0);
      // The important assertion is no churn:
      const readContent2 = await (app as any).vault.read(sourceFile);
      expect(readContent2).toBe(readContent);
    });
  });
});

// ── Tutorial in-place enrichment ──
//
// These tests verify that the tutorial pipeline writes extraction fields back
// to the SOURCE bookmark's frontmatter rather than creating a separate note.

describe("tutorial (in-place enrichment)", () => {
  const baseTutorial = makeTutorialExtraction();

  // ── computeTutorialBackfillFields (pure) ──

  it("emits all tutorial_* fields + enrichment_v_tutorial", () => {
    const u = computeTutorialBackfillFields(baseTutorial, {});
    expect(u[TUTORIAL_FIELDS.topic]).toBe(baseTutorial.topic);
    expect(u[TUTORIAL_FIELDS.skillArea]).toBe(baseTutorial.skillArea);
    expect(u[TUTORIAL_FIELDS.difficulty]).toBe(baseTutorial.difficulty);
    expect(u[TUTORIAL_FIELDS.version]).toBe(1);
  });

  it("sets roost_category=Tutorials + roost_subcategory=skillArea when slot is empty", () => {
    const u = computeTutorialBackfillFields(baseTutorial, {});
    expect(u["roost_category"]).toBe("Tutorials");
    expect(u["roost_subcategory"]).toBe(baseTutorial.skillArea);
  });

  it("does not overwrite existing roost_category when already set to a different category", () => {
    const u = computeTutorialBackfillFields(baseTutorial, { roost_category: "Recipes" });
    expect(u["roost_category"]).toBeUndefined();
    expect(u["roost_subcategory"]).toBeUndefined();
  });

  it("fills missing subcategory when category already matches Tutorials", () => {
    const u = computeTutorialBackfillFields(baseTutorial, { roost_category: "Tutorials" });
    expect(u["roost_subcategory"]).toBe(baseTutorial.skillArea);
  });

  it("leaves subcategory alone when already set", () => {
    const u = computeTutorialBackfillFields(baseTutorial, {
      roost_category: "Tutorials",
      roost_subcategory: "Photography",
    });
    expect(u["roost_subcategory"]).toBeUndefined();
  });

  // ── writeTutorialToBookmark (I/O) ──

  it("writes tutorial fields to the source bookmark frontmatter", async () => {
    const initialContent = [
      "---",
      "roost_id: tiktok:tutorial_1",
      "title: How to pour coffee",
      "---",
      "",
      "Body text.",
    ].join("\n");

    let written = "";
    const mockFile = Object.assign(new TFile(), { path: "Bookmarks/synced/tiktok-tutorial_1/tiktok-tutorial_1.md" });
    const mockApp = {
      vault: {
        read: async () => initialContent,
        modify: async (_f: unknown, content: string) => { written = content; },
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter: { roost_id: "tiktok:tutorial_1", title: "How to pour coffee" } }),
      },
    } as any;

    await writeTutorialToBookmark(mockApp, mockFile, baseTutorial);

    expect(written).toContain(`${TUTORIAL_FIELDS.topic}: `);
    expect(written).toContain(`${TUTORIAL_FIELDS.version}: 1`);
    expect(written).toContain("roost_category: Tutorials");
  });

  it("does not call vault.modify if frontmatter is already up to date", async () => {
    // Pre-populate ALL tutorial fields (including arrays) in the exact YAML format
    // that updateNoteFrontmatter produces, so it detects no changes.
    // Use a minimal extraction with no description so we don't need to deal with
    // quoting edge cases for multi-word descriptions.
    const minimalTutorial = makeTutorialExtraction({ description: "" });
    const toolsList = minimalTutorial.tools.map(t => `  - ${t}`).join("\n");
    const stepsList = minimalTutorial.steps.map(s => `  - ${s}`).join("\n");
    const fullFm = [
      `${TUTORIAL_FIELDS.topic}: ${minimalTutorial.topic}`,
      `${TUTORIAL_FIELDS.skillArea}: ${minimalTutorial.skillArea}`,
      `${TUTORIAL_FIELDS.difficulty}: ${minimalTutorial.difficulty}`,
      `${TUTORIAL_FIELDS.timeEstimate}: ${minimalTutorial.timeEstimate}`,
      // description is empty → null → not written
      `${TUTORIAL_FIELDS.tools}:\n${toolsList}`,
      `${TUTORIAL_FIELDS.steps}:\n${stepsList}`,
      `${TUTORIAL_FIELDS.version}: 1`,
      "roost_category: Tutorials",
      `roost_subcategory: ${minimalTutorial.skillArea}`,
    ].join("\n");
    const content = `---\n${fullFm}\n---\n\nBody.\n`;

    let modifyCalled = false;
    const mockFile = Object.assign(new TFile(), { path: "Bookmarks/synced/tiktok-tutorial_2/tiktok-tutorial_2.md" });
    const existingFm: Record<string, unknown> = {
      [TUTORIAL_FIELDS.topic]: minimalTutorial.topic,
      [TUTORIAL_FIELDS.skillArea]: minimalTutorial.skillArea,
      [TUTORIAL_FIELDS.difficulty]: minimalTutorial.difficulty,
      [TUTORIAL_FIELDS.timeEstimate]: minimalTutorial.timeEstimate,
      [TUTORIAL_FIELDS.tools]: minimalTutorial.tools,
      [TUTORIAL_FIELDS.steps]: minimalTutorial.steps,
      [TUTORIAL_FIELDS.version]: 1,
      roost_category: "Tutorials",
      roost_subcategory: minimalTutorial.skillArea,
    };
    const mockApp = {
      vault: {
        read: async () => content,
        modify: async () => { modifyCalled = true; },
      },
      metadataCache: { getFileCache: () => ({ frontmatter: existingFm }) },
    } as any;

    await writeTutorialToBookmark(mockApp, mockFile, minimalTutorial);

    // updateNoteFrontmatter returns null when nothing changes → modify not called.
    expect(modifyCalled).toBe(false);
  });
});

// ── Home in-place enrichment ──

describe("home (in-place enrichment)", () => {
  it("writes home_* fields onto the source bookmark", async () => {
    const { HOME_FIELDS, computeHomeBackfillFields, writeHomeToBookmark } = await import("@/pipeline/home-pipeline");
    const baseHome = makeHomeExtraction();
    const updates = computeHomeBackfillFields(baseHome, {});
    expect(updates[HOME_FIELDS.title]).toBe(baseHome.title);
    expect(updates[HOME_FIELDS.room]).toBe(baseHome.room);
    expect(updates[HOME_FIELDS.version]).toBe(1);
    expect(updates["roost_category"]).toBe("Home");
  });

  it("writeHomeToBookmark applies updates via updateNoteFrontmatter", async () => {
    const { HOME_FIELDS, writeHomeToBookmark } = await import("@/pipeline/home-pipeline");
    const baseHome = makeHomeExtraction();
    const initialContent = "---\nroost_id: tiktok:home_1\ntitle: Cozy nook\n---\n\nBody.\n";

    let written = "";
    const mockFile = Object.assign(new TFile(), { path: "Bookmarks/synced/tiktok-home_1/tiktok-home_1.md" });
    const mockApp = {
      vault: {
        read: async () => initialContent,
        modify: async (_f: unknown, content: string) => { written = content; },
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter: { roost_id: "tiktok:home_1", title: "Cozy nook" } }),
      },
    } as any;

    await writeHomeToBookmark(mockApp, mockFile, baseHome);

    expect(written).toContain(`${HOME_FIELDS.title}: `);
    expect(written).toContain(`${HOME_FIELDS.version}: 1`);
    expect(written).toContain("roost_category: Home");
  });
});
