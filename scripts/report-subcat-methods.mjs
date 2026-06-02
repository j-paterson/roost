#!/usr/bin/env node
/**
 * Read subcat-methods runner output and print three stdout tables:
 *   1. Best operating point per method
 *   2. Pareto frontier across all (method, floor) cells
 *   3. Confidence calibration for the best per-method cells
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.eval.json scripts/report-subcat-methods.mjs \
 *     [--results=tests/eval/subcat-method-results.json]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const RESULTS = args.results ?? "tests/eval/subcat-method-results.json";

const { bestPerMethod, paretoFilter, calibrationBuckets } = await import(
  path.join(__dirname, "..", "src", "eval", "subcat-report.ts")
);

const data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));

const summaries = data.cells.map(cell => {
  const total = cell.perItem.length || 1;
  return {
    method: cell.method,
    floor: cell.floor,
    secondaryThreshold: cell.secondaryThreshold ?? null,
    positiveAccuracy: cell.metrics.positiveAccuracy,
    floorCompliance: cell.metrics.floorCompliance,
    combinedAccuracy: cell.metrics.combinedAccuracy,
    msPer1k: (cell.metrics.wallTimeMs / total) * 1000,
    llmPer1k: (cell.metrics.llmCalls / total) * 1000,
  };
});

function fmt(n, w = 5) {
  return n.toFixed(3).padStart(w);
}

console.log("=== Best operating point per method ===");
console.log("Method        Floor   Sec     Pos Acc   Floor Comp   Combined   ms/1k    LLM/1k");
for (const c of bestPerMethod(summaries).sort((a, b) => a.method.localeCompare(b.method))) {
  const sec = c.secondaryThreshold === null ? "  -  " : c.secondaryThreshold.toFixed(2);
  console.log(
    `${c.method.padEnd(12)}  ${c.floor.toFixed(2)}    ${sec}    ${fmt(c.positiveAccuracy)}     ${fmt(c.floorCompliance)}        ${fmt(c.combinedAccuracy)}      ${c.msPer1k.toFixed(0).padStart(6)}   ${c.llmPer1k.toFixed(0)}`,
  );
}

console.log("\n=== Pareto frontier ===");
console.log("(cells dominated by some other cell on both accuracy AND cost are filtered out)");
const pareto = paretoFilter(summaries).sort((a, b) => a.combinedAccuracy - b.combinedAccuracy);
for (const c of pareto) {
  const label = c.secondaryThreshold === null
    ? `${c.method}@${c.floor.toFixed(2)}`
    : `${c.method}@${c.floor.toFixed(2)}/s=${c.secondaryThreshold.toFixed(2)}`;
  console.log(
    `${label.padEnd(28)}  pos=${fmt(c.positiveAccuracy)}  comp=${fmt(c.floorCompliance)}  ms/1k=${c.msPer1k.toFixed(0).padStart(6)}  [PARETO]`,
  );
}

console.log("\n=== Confidence calibration (best per-method cells) ===");
const bestCells = bestPerMethod(summaries);
for (const best of bestCells.sort((a, b) => a.method.localeCompare(b.method))) {
  const fullCell = data.cells.find(c => c.method === best.method && c.floor === best.floor);
  if (!fullCell) continue;
  console.log(`${best.method}@${best.floor.toFixed(2)}:`);
  for (const b of calibrationBuckets(fullCell.perItem)) {
    console.log(`  ${b.bucket}  n=${String(b.n).padStart(4)}  acc=${b.accuracy.toFixed(2)}`);
  }
}
