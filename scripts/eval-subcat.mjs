#!/usr/bin/env node
/**
 * Smart Assign Phase-1 quality eval runner. For each scenario:
 *  - Build CategoryDefs from anchorConfig
 *  - Invoke scoreAgainstCategories (no writes)
 *  - Compare predictions to groundTruth
 *  - Multi-run for ensemble stochasticity
 *
 * Outputs: per-scenario accuracy + aggregate, with mean ± stdev.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.eval.json scripts/eval-subcat.mjs [--runs=3] [--out=tests/eval/baseline-results.json]
 *
 * Requires tsconfig.eval.json to alias obsidian → src/__mocks__/obsidian.ts
 * and wire __setRequestUrlImpl so scoreAgainstCategories can call Ollama.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const RUNS = parseInt(args.runs ?? "3", 10);
const OUT = args.out ?? "tests/eval/baseline-results.json";

const SCENARIOS_PATH = "tests/eval/subcat-scenarios.json";
const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");

// ── Wire obsidian mock requestUrl → real fetch (must happen before evaluate.ts loads) ──
// tsconfig.eval.json maps "obsidian" → src/__mocks__/obsidian.ts.
// The mock's requestUrl throws by default; we replace it with real fetch so
// scoreAgainstCategories can reach Ollama.
const { __setRequestUrlImpl, FileSystemAdapter } = await import(
  path.join(__dirname, "..", "src", "__mocks__", "obsidian.ts")
);

__setRequestUrlImpl(async (req) => {
  const res = await fetch(req.url, {
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
});

const { scoreAgainstCategories, buildCategoryDefs } = await import(
  path.join(__dirname, "..", "src", "pipeline", "evaluate.ts")
);
const { loadEmbeddingCache, embedStrings } = await import(
  path.join(__dirname, "..", "src", "pipeline", "shared.ts")
);
const { loadAnchorNameEmbeddings, saveAnchorNameEmbeddings, fillMissingAnchorNames, lookupAnchorNameVec } = await import(
  path.join(__dirname, "..", "src", "lib", "anchor-name-embeddings.ts")
);

// Build a vault-like object that vaultBasePath() accepts.
// vaultBasePath checks `vault.adapter instanceof FileSystemAdapter`,
// so we must use the mock's class with basePath set.
const adapter = new FileSystemAdapter();
adapter.basePath = VAULT_PATH;
const fakeVault = { adapter };

function loadScenarios() {
  const text = fs.readFileSync(SCENARIOS_PATH, "utf8");
  return JSON.parse(text).scenarios;
}

async function runScenario(scenario, embeddingCache, anchorCache) {
  const collections = scenario.anchorConfig;
  const descriptions = new Map();

  // Wire name embeddings so empty-anchor collections get a centroid from their
  // collection name. This mirrors the production path in use-smart-assign.ts
  // (lines 333-352). Without this, buildCategoryDefs skips zero-item collections
  // and the blended-centroid improvement is never exercised by the eval harness.
  let nameEmbeddings = new Map();
  try {
    const updatedCache = await fillMissingAnchorNames(
      Object.keys(collections),
      anchorCache,
      embedStrings,
    );
    // Update in-place so subsequent runs reuse embeddings within a scenario set
    for (const [k, v] of Object.entries(updatedCache)) {
      if (!anchorCache[k]) anchorCache[k] = v;
    }
    for (const name of Object.keys(collections)) {
      const v = lookupAnchorNameVec(anchorCache, name);
      if (v) nameEmbeddings.set(name.toLowerCase(), v);
    }
  } catch (e) {
    console.error(`  [warn] anchor-name embedding failed: ${e.message}. Falling back to pure-item centroids.`);
    nameEmbeddings = new Map();
  }

  const categoryDefs = buildCategoryDefs(collections, descriptions, embeddingCache, undefined, undefined, nameEmbeddings);
  if (categoryDefs.length === 0) {
    return { scenario: scenario.name, accuracy: 0, n: 0, perItem: [], note: "no centroids built" };
  }
  const result = await scoreAgainstCategories({
    itemIds: scenario.testItems,
    cache: embeddingCache,
    categories: categoryDefs,
    vault: fakeVault,
    phaseTag: "eval",
    onLog: () => {},
  });
  let correct = 0;
  const perItem = [];
  for (const id of scenario.testItems) {
    const predicted = result.assignments.get(id) ?? "misc";
    const expected = scenario.groundTruth[id];
    const ok = predicted === expected;
    if (ok) correct++;
    perItem.push({ id, expected, predicted, ok });
  }
  return {
    scenario: scenario.name,
    accuracy: correct / scenario.testItems.length,
    n: scenario.testItems.length,
    perItem,
  };
}

function summarize(results) {
  const byScenario = new Map();
  for (const run of results) {
    for (const r of run) {
      if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
      byScenario.get(r.scenario).push(r.accuracy);
    }
  }
  const out = [];
  for (const [name, accs] of byScenario) {
    const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
    const variance = accs.reduce((s, a) => s + (a - mean) ** 2, 0) / accs.length;
    const stdev = Math.sqrt(variance);
    out.push({ scenario: name, mean, stdev, runs: accs });
  }
  return out;
}

async function main() {
  const scenarios = loadScenarios();
  console.error(`Loaded ${scenarios.length} scenarios`);
  const cache = loadEmbeddingCache(fakeVault);
  console.error(`Loaded embedding cache (${Object.keys(cache).length} items)`);

  // Load anchor-name embedding cache (shared across all scenario runs so
  // embed calls happen at most once per collection name per eval invocation).
  const anchorCache = loadAnchorNameEmbeddings(fakeVault);
  console.error(`Loaded anchor-name cache (${Object.keys(anchorCache).length} entries)`);

  const allRuns = [];
  for (let r = 0; r < RUNS; r++) {
    console.error(`\n── Run ${r + 1}/${RUNS} ──`);
    const runResults = [];
    for (const s of scenarios) {
      console.error(`  ${s.name}…`);
      const t0 = Date.now();
      const result = await runScenario(s, cache, anchorCache);
      console.error(`    ${(result.accuracy * 100).toFixed(1)}% (${Math.round((Date.now() - t0) / 1000)}s)`);
      runResults.push(result);
    }
    allRuns.push(runResults);
  }

  // Persist any newly fetched anchor-name embeddings so the next eval run is
  // fully cached. Errors are non-fatal — the eval results are already in memory.
  try {
    saveAnchorNameEmbeddings(fakeVault, anchorCache);
  } catch (e) {
    console.error(`[warn] Could not save anchor-name cache: ${e.message}`);
  }

  const summary = summarize(allRuns);
  const aggregate = {
    runsPerScenario: RUNS,
    timestamp: new Date().toISOString(),
    perScenario: summary,
    overallMean: summary.reduce((s, x) => s + x.mean, 0) / summary.length,
  };

  fs.writeFileSync(OUT, JSON.stringify(aggregate, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(`Overall mean accuracy: ${(aggregate.overallMean * 100).toFixed(1)}%`);
  for (const s of summary) {
    console.log(`  ${s.scenario}: ${(s.mean * 100).toFixed(1)}% ± ${(s.stdev * 100).toFixed(1)}pp`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
