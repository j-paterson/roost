/**
 * Shared boilerplate for per-pipeline E2E specs.
 *
 * All extraction pipelines (recipe, place, media, product, tutorial, workout,
 * home) share the same UI trigger (library-tree.tsx:309 play button) and the
 * same end-to-end shape: stub Ollama → click play → assert cache + notes.
 *
 * This helper extracts the common setup/teardown/run-and-assert flow so each
 * per-pipeline spec only declares the cell-specific fields (category, cache
 * filename, prompt markers, expected extraction shape, etc).
 *
 * Skip behaviour: if real Ollama is running on port 11434, startOllamaStub
 * fails with EADDRINUSE → setup returns stubBound=false and the test self-
 * skips. CI has no Ollama, so the stub binds and the test runs.
 */

import { browser, expect } from "@wdio/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { startOllamaStub, stopOllamaStub } from "./ollama-stub.js";
import type { OllamaStub } from "./ollama-stub.js";

export interface PipelineSpecConfig {
  /** Display label, used in describe() text. */
  label: string;
  /** Sidebar tree's data-category attribute (case-sensitive). */
  category: string;
  /** Filename relative to .roost/ — e.g. "recipe-cache.json". */
  cacheFile: string;
  /** Output dir relative to vault root — e.g. "Pipelines/Recipes". */
  outputDir: string;
  /** Roost IDs of fixture bookmarks the pipeline should pick up and process. */
  expectedIds: string[];
  /** Substring or RegExp that uniquely identifies the triage prompt for this
   *  pipeline. The stub responds with `triageResponse`. */
  triagePromptMarker: string | RegExp;
  triageResponse: string;
  /** Substring or RegExp that uniquely identifies the extraction prompt. */
  extractPromptMarker: string | RegExp;
  /** Stubbed extraction object — JSON-stringified into the response. */
  extraction: Record<string, unknown>;
  /** Substring expected in at least one written note (verifies the extraction
   *  data flowed through to the markdown output). */
  noteAssertContains: string;
}

export interface PipelineSpecState {
  stub: OllamaStub | null;
  stubBound: boolean;
  cacheBackup: string;
  outputDirSnapshot: string[];
  vaultPath: string;
}

const PIPELINE_TIMEOUT = 60_000;

export async function getVaultPath(): Promise<string> {
  return browser.executeObsidian(({ app }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app.vault.adapter as any).getBasePath?.() ?? (app.vault.adapter as any).basePath ?? ""
  ) as Promise<string>;
}

export async function openRoostSidebar(): Promise<void> {
  await browser.executeObsidianCommand("roost:open");
  const sidebar = await $(".roost-root");
  await sidebar.waitForDisplayed({ timeout: 30_000 });
  await browser.pause(2000);
}

export async function setupPipelineSpec(cfg: PipelineSpecConfig): Promise<PipelineSpecState> {
  const state: PipelineSpecState = {
    stub: null,
    stubBound: false,
    cacheBackup: "",
    outputDirSnapshot: [],
    vaultPath: "",
  };

  try {
    state.stub = await startOllamaStub(11434);
    state.stubBound = true;
  } catch (err) {
    console.warn(
      `[${cfg.label}] Ollama port 11434 already bound — skipping. ` +
      `Stop local Ollama (\`pkill ollama\`) to run this spec locally.`,
      err instanceof Error ? err.message : err,
    );
    return state;
  }

  // Order matters: more specific markers should be registered first if they
  // overlap with broader ones. Triage and extract prompts are distinct
  // strings across all pipelines, so registration order is generally moot.
  state.stub.respond(cfg.triagePromptMarker, cfg.triageResponse);
  state.stub.respond(cfg.extractPromptMarker, JSON.stringify(cfg.extraction));

  await openRoostSidebar();
  state.vaultPath = await getVaultPath();

  const cachePath = path.join(state.vaultPath, ".roost", cfg.cacheFile);
  state.cacheBackup = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, "utf-8") : "";

  const outDir = path.join(state.vaultPath, cfg.outputDir);
  state.outputDirSnapshot = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];

  return state;
}

export async function teardownPipelineSpec(
  cfg: PipelineSpecConfig,
  state: PipelineSpecState,
): Promise<void> {
  if (!state.stubBound) return;

  // Restore cache to its pre-test contents (or remove if it didn't exist).
  const cachePath = path.join(state.vaultPath, ".roost", cfg.cacheFile);
  if (state.cacheBackup) {
    fs.writeFileSync(cachePath, state.cacheBackup, "utf-8");
  } else if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }

  // Remove any new files created in the output dir during the run.
  const outDir = path.join(state.vaultPath, cfg.outputDir);
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (!state.outputDirSnapshot.includes(f)) {
        try { fs.unlinkSync(path.join(outDir, f)); } catch { /* best-effort */ }
      }
    }
  }

  if (state.stub) await stopOllamaStub(state.stub);
}

/**
 * Click the play button on the matching tree row, wait for completion, and
 * assert the cache + output dir reflect the stubbed extraction.
 */
export async function runPipelineAndAssert(
  cfg: PipelineSpecConfig,
  state: PipelineSpecState,
): Promise<void> {
  const row = await $(`.tree-item-self[data-category="${cfg.category}"]`);
  await row.waitForExist({ timeout: 15_000 });

  const playBtn = await $(
    `.tree-item-self[data-category="${cfg.category}"] .roost-pipeline-button`,
  );
  await playBtn.waitForExist({ timeout: 10_000 });
  await browser.execute((el) => (el as HTMLElement).click(), playBtn);

  // The progress bar may flash briefly or never paint at all on fast runs.
  // Give the run a moment to start, then wait for the bar to clear if shown.
  await browser.pause(500);
  const bar = await $(
    `.tree-item-self[data-category="${cfg.category}"] .roost-pipeline-bar`,
  );
  if (await bar.isExisting().catch(() => false)) {
    await bar.waitForExist({ reverse: true, timeout: PIPELINE_TIMEOUT });
  }
  // Allow the post-write filesystem flush to settle.
  await browser.pause(1000);

  // ── Assert: cache grew with each expected ID ──
  const cachePath = path.join(state.vaultPath, ".roost", cfg.cacheFile);
  const cacheAfter = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  for (const id of cfg.expectedIds) {
    expect(cacheAfter[id]).toBeDefined();
  }

  // ── Assert: output dir has at least one new note per expected ID ──
  const outDir = path.join(state.vaultPath, cfg.outputDir);
  const after = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const newFiles = after.filter((f) => !state.outputDirSnapshot.includes(f));
  expect(newFiles.length).toBeGreaterThanOrEqual(cfg.expectedIds.length);

  // Spot-check: at least one new note contains the stubbed extraction signal.
  const sample = newFiles.find((f) => f.endsWith(".md"));
  expect(sample).toBeDefined();
  const noteText = fs.readFileSync(path.join(outDir, sample!), "utf-8");
  expect(noteText).toContain(cfg.noteAssertContains);
}
