/**
 * Cluster quality inspection — uses Python HDBSCAN for speed, JS k-means for comparison.
 * Usage: node test/cluster-inspect.mjs [sample-size]
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const SAMPLE_SIZE = parseInt(process.argv[2]) || 1000;
const HOME = process.env.HOME;
const VAULT_CACHE = path.join(HOME, "ObsidianBookmarks/.roost/embedding-cache.json");
const APP_CACHE = path.join(HOME, "Library/Application Support/roost-app/.embedding-cache-tiktok.json");
const PYTHON = path.join(import.meta.dirname, ".venv/bin/python3");
const SCRIPT = path.join(import.meta.dirname, "cluster-python.py");

// ── Run Python pipeline ──
console.log(`\nRunning Python UMAP + HDBSCAN on ${SAMPLE_SIZE} items...\n`);
const sampleArg = SAMPLE_SIZE > 0 ? `--sample ${SAMPLE_SIZE}` : "";
const pyResult = execSync(
  `"${PYTHON}" "${SCRIPT}" ${sampleArg} --min-cluster-size 15`,
  { maxBuffer: 500 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] }
);
const data = JSON.parse(pyResult.toString());

// ── Load cache for old pipeline ──
const cacheFile = fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : APP_CACHE;
const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const sampleIds = data.ids;
const vectors = sampleIds.map(id => cache[id].vec);

// ── Display new pipeline results ──
console.log("\n═══════════════════════════════════════════════");
console.log("NEW PIPELINE (Python UMAP + HDBSCAN)");
console.log(`═══════════════════════════════════════════════`);
console.log(`UMAP 15d: ${data.stats.umap_15d_time_ms}ms | HDBSCAN: ${data.stats.hdbscan_time_ms}ms | Total: ${data.stats.umap_15d_time_ms + data.stats.hdbscan_time_ms}ms\n`);

for (const cl of data.per_cluster) {
  console.log(`Cluster ${cl.label} (${cl.count} items) — top: "${cl.top_category}" (${(cl.purity * 100).toFixed(0)}% purity, cohesion ${(cl.cohesion * 100).toFixed(1)}%)`);
  for (const [cat, count] of Object.entries(cl.categories)) {
    const bar = "█".repeat(Math.ceil(count / cl.count * 20));
    console.log(`  ${String(count).padStart(4)}  ${bar}  ${cat}`);
  }
  if (cl.topic_samples.length > 0) {
    console.log(`  Samples:`);
    for (const t of cl.topic_samples.slice(0, 3)) console.log(`    - ${t}`);
  }
  console.log();
}

console.log(`Noise (${data.stats.noise} items) — top categories:`);
for (const [cat, count] of Object.entries(data.noise_categories).slice(0, 10)) {
  console.log(`  ${String(count).padStart(4)}  ${cat}`);
}

// ── Slider comparison ──
console.log("\n═══════════════════════════════════════════════");
console.log("SLIDER COMPARISON (minClusterSize sweep)");
console.log("═══════════════════════════════════════════════\n");
console.log("  mcs  clusters   noise  purity   time");
console.log("  ───  ────────  ──────  ──────  ──────");
for (const sr of data.slider_results) {
  console.log(`  ${String(sr.min_cluster_size).padStart(3)}  ${String(sr.clusters).padStart(8)}  ${String(sr.noise).padStart(6)}  ${(sr.avg_purity * 100).toFixed(1).padStart(5)}%  ${String(sr.time_ms).padStart(5)}ms`);
}

// ── Old pipeline (JS bisecting k-means) ──
console.log("\n═══════════════════════════════════════════════");
console.log("OLD PIPELINE (bisecting k-means on 768d)");
console.log("═══════════════════════════════════════════════\n");

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function computeCentroid(vecs) {
  const dim = vecs[0].length, avg = new Array(dim).fill(0);
  for (const v of vecs) for (let d = 0; d < dim; d++) avg[d] += v[d];
  for (let d = 0; d < dim; d++) avg[d] /= vecs.length;
  return avg;
}
function computeCohesion(vecs, c) {
  let sum = 0; for (const v of vecs) sum += cosineSimilarity(v, c); return sum / vecs.length;
}
function bisectKMeans(vecs) {
  const n = vecs.length, dim = vecs[0].length;
  const c0 = vecs[Math.floor(Math.random() * n)].slice();
  let maxD = -1, fi = 0;
  for (let i = 0; i < n; i++) { const d = 1 - cosineSimilarity(vecs[i], c0); if (d > maxD) { maxD = d; fi = i; } }
  const c1 = vecs[fi].slice();
  const cs = [c0, c1]; let assign = new Array(n).fill(0);
  for (let iter = 0; iter < 30; iter++) {
    const next = vecs.map(v => cosineSimilarity(v, cs[0]) >= cosineSimilarity(v, cs[1]) ? 0 : 1);
    let changed = false;
    for (let i = 0; i < n; i++) if (next[i] !== assign[i]) { changed = true; break; }
    assign = next; if (!changed) break;
    for (let ki = 0; ki < 2; ki++) {
      const avg = new Array(dim).fill(0); let cnt = 0;
      for (let i = 0; i < n; i++) if (assign[i] === ki) { for (let d = 0; d < dim; d++) avg[d] += vecs[i][d]; cnt++; }
      if (cnt > 0) for (let d = 0; d < dim; d++) avg[d] /= cnt; cs[ki] = avg;
    }
  }
  return assign;
}

function elapsed(t0) { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

const t0old = Date.now();
let nid = 0;
function buildNode(indices) {
  const vecs = indices.map(i => vectors[i]);
  const c = computeCentroid(vecs);
  return { id: nid++, indices, cohesion: computeCohesion(vecs, c), children: null };
}
const oldRoot = buildNode(Array.from({ length: sampleIds.length }, (_, i) => i));
let oldLeaves = [oldRoot];
const unsplittable = new Set();
let splitNum = 0;
while (oldLeaves.length < 60) {
  let bestIdx = -1, bestPri = -Infinity;
  for (let i = 0; i < oldLeaves.length; i++) {
    if (unsplittable.has(oldLeaves[i].id)) continue;
    if (oldLeaves[i].indices.length < 20) continue;
    if (oldLeaves[i].cohesion >= 0.92) continue;
    const pri = oldLeaves[i].indices.length * (1 - oldLeaves[i].cohesion);
    if (pri > bestPri) { bestPri = pri; bestIdx = i; }
  }
  if (bestIdx === -1) break;
  const target = oldLeaves[bestIdx];
  const subVecs = target.indices.map(i => vectors[i]);
  process.stdout.write(`\r  Split ${++splitNum} (${oldLeaves.length} leaves, ${elapsed(t0old)})   `);
  const assign = bisectKMeans(subVecs);
  const left = [], right = [];
  for (let i = 0; i < assign.length; i++) (assign[i] === 0 ? left : right).push(target.indices[i]);
  if (left.length < 10 || right.length < 10) { unsplittable.add(target.id); continue; }
  const ln = buildNode(left), rn = buildNode(right);
  target.children = [ln, rn]; oldLeaves.splice(bestIdx, 1, ln, rn);
}
console.log(`\r  ${oldLeaves.length} leaves, ${splitNum} splits in ${elapsed(t0old)}                `);

// Old purity
const oldPurities = [];
for (let ci = 0; ci < oldLeaves.length; ci++) {
  const memberIds = oldLeaves[ci].indices.map(i => sampleIds[i]);
  const catCounts = new Map();
  for (const id of memberIds) catCounts.set(cache[id]?.category || "(none)", (catCounts.get(cache[id]?.category || "(none)") || 0) + 1);
  const sorted = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);
  const purity = sorted[0][1] / memberIds.length;
  oldPurities.push(purity);
  if (ci < 15) {
    console.log(`Cluster ${ci} (${memberIds.length} items) — top: "${sorted[0][0]}" (${(purity * 100).toFixed(0)}% purity)`);
    for (const [cat, count] of sorted.slice(0, 3)) {
      console.log(`  ${String(count).padStart(4)}  ${"█".repeat(Math.ceil(count / memberIds.length * 20))}  ${cat}`);
    }
  }
}
if (oldLeaves.length > 15) console.log(`  ... and ${oldLeaves.length - 15} more clusters`);

// ── Summary ──
const avgOldPurity = oldPurities.reduce((a, b) => a + b, 0) / oldPurities.length;
const avgNewPurity = data.per_cluster.length > 0
  ? data.per_cluster.reduce((s, c) => s + c.purity, 0) / data.per_cluster.length : 0;
const avgNewCohesion = data.per_cluster.length > 0
  ? data.per_cluster.reduce((s, c) => s + c.cohesion, 0) / data.per_cluster.length : 0;

console.log("\n═══════════════════════════════════════════════");
console.log("COMPARISON SUMMARY");
console.log("═══════════════════════════════════════════════");
console.log(`Old: ${oldLeaves.length} clusters, avg purity ${(avgOldPurity * 100).toFixed(1)}%, 0 noise`);
console.log(`New: ${data.stats.clusters} clusters, avg purity ${(avgNewPurity * 100).toFixed(1)}%, avg cohesion ${(avgNewCohesion * 100).toFixed(1)}%, ${data.stats.noise} noise`);
console.log(`Purity = % of items sharing the top Ollama category in each cluster`);
