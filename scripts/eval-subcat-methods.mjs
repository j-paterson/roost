#!/usr/bin/env node
/**
 * Sweep (method, floor) cells against subcategory eval scenarios.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.eval.json scripts/eval-subcat-methods.mjs \
 *     [--scenarios=tests/eval/subcat-method-scenarios.json] \
 *     [--out=tests/eval/subcat-method-results.json] \
 *     [--methods=cosine,t1,ensemble] \
 *     [--floors=0.55,0.60,0.65,0.70,0.75] \
 *     [--model=gemma3:4b] \
 *     [--limit-per-parent=N]
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
const SCENARIOS_PATH = args.scenarios ?? "tests/eval/subcat-method-scenarios.json";
const OUT = args.out ?? "tests/eval/subcat-method-results.json";
const METHODS = (args.methods ?? "cosine,t1,ensemble,t1-margin,t1-gate,t1-none").split(",");
const FLOORS = (args.floors ?? "0.55").split(",").map(Number);  // Default to v1 best operating point.
const MARGINS = (args.margins ?? "0.0,0.05,0.10,0.15,0.20").split(",").map(Number);
const GATES = (args.gates ?? "0.0,0.70,0.75,0.80,0.85").split(",").map(Number);
const MODEL = args.model ?? "gemma3:4b";
const LIMIT = args["limit-per-parent"] ? parseInt(args["limit-per-parent"], 10) : undefined;
const VAULT_PATH = args.vault ?? path.join(os.homedir(), "ObsidianBookmarks");

// Wire mock-Obsidian shim → real fetch BEFORE importing evaluate.ts.
const { __setRequestUrlImpl, FileSystemAdapter } = await import(
  path.join(__dirname, "..", "src", "__mocks__", "obsidian.ts")
);
__setRequestUrlImpl(async (req) => {
  const res = await fetch(req.url, {
    method: req.method ?? "GET", headers: req.headers, body: req.body,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
});

const { runCell } = await import(path.join(__dirname, "..", "src", "eval", "subcat-methods.ts"));
const { loadEmbeddingCache } = await import(path.join(__dirname, "..", "src", "pipeline", "shared.ts"));
const { loadAnchorNameEmbeddings, fillMissingAnchorNames, lookupAnchorNameVec } = await import(
  path.join(__dirname, "..", "src", "lib", "anchor-name-embeddings.ts")
);
const { embedStrings } = await import(path.join(__dirname, "..", "src", "pipeline", "shared.ts"));

const adapter = new FileSystemAdapter();
adapter.basePath = VAULT_PATH;
const fakeVault = { adapter };

const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8"));
console.error(
  `Loaded ${scenarios.parents.length} parents, ${scenarios.stats.totalPositives} positives, ` +
  `${scenarios.stats.totalNegatives} negatives from ${SCENARIOS_PATH}`,
);
const ageHours = (Date.now() - new Date(scenarios.generatedAt).getTime()) / 36e5;
if (ageHours > 24) {
  console.error(`[warn] scenarios JSON is ${ageHours.toFixed(1)}h old — vault may have drifted`);
}

const cache = loadEmbeddingCache(fakeVault);
console.error(`Loaded embedding cache (${Object.keys(cache).length} items)`);

// Pre-fill anchor name embeddings for blended centroids.
const allSubcatNames = new Set();
for (const p of scenarios.parents) for (const s of p.subcategories) allSubcatNames.add(s);
const anchorCache = loadAnchorNameEmbeddings(fakeVault);
const updated = await fillMissingAnchorNames([...allSubcatNames], anchorCache, embedStrings);
for (const [k, v] of Object.entries(updated)) if (!anchorCache[k]) anchorCache[k] = v;
const nameEmbeddings = new Map();
for (const name of allSubcatNames) {
  const v = lookupAnchorNameVec(anchorCache, name);
  if (v) nameEmbeddings.set(name.toLowerCase(), v);
}

const cells = [];

// Compute the cell list upfront so we can show progress like "[7/15]".
const cellList = [];
for (const method of METHODS) {
  for (const floor of FLOORS) {
    if (method === "t1-margin") {
      for (const margin of MARGINS) cellList.push({ method, floor, marginThreshold: margin, gateThreshold: undefined });
    } else if (method === "t1-gate") {
      for (const gate of GATES) cellList.push({ method, floor, marginThreshold: undefined, gateThreshold: gate });
    } else {
      cellList.push({ method, floor, marginThreshold: undefined, gateThreshold: undefined });
    }
  }
}
const totalCells = cellList.length;
let cellIdx = 0;

for (const spec of cellList) {
  cellIdx++;
  let lastReport = 0;
  const cellLabel = spec.method === "t1-margin" ? `${spec.method}@${spec.floor}/m=${spec.marginThreshold}`
                  : spec.method === "t1-gate" ? `${spec.method}@${spec.floor}/g=${spec.gateThreshold}`
                  : `${spec.method}@${spec.floor}`;
  const cell = await runCell({
    method: spec.method, floor: spec.floor,
    marginThreshold: spec.marginThreshold,
    gateThreshold: spec.gateThreshold,
    scenarios, cache,
    limitPerParent: LIMIT,
    nameEmbeddings,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastReport > 1000 || done === total) {
        process.stderr.write(`\r  [${cellIdx}/${totalCells}] ${cellLabel} ${done}/${total}      `);
        lastReport = now;
      }
    },
  });
  process.stderr.write("\n");
  console.error(
    `  ${cellLabel}: pos=${cell.metrics.positiveAccuracy.toFixed(3)} ` +
    `comp=${cell.metrics.floorCompliance.toFixed(3)} ` +
    `comb=${cell.metrics.combinedAccuracy.toFixed(3)} ` +
    `time=${(cell.metrics.wallTimeMs / 1000).toFixed(1)}s ` +
    `llm=${cell.metrics.llmCalls}`,
  );
  cells.push(cell);
}

const out = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  scenarios: SCENARIOS_PATH,
  cells,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`\nWrote ${OUT}`);
