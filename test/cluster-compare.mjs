/**
 * Cluster comparison visualization — old (bisecting k-means) vs new (Python UMAP + HDBSCAN).
 * Generates an HTML file with side-by-side 2D scatter plots.
 *
 * Usage: node test/cluster-compare.mjs [sample-size]
 * Output: test/cluster-compare.html
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
const OUT_FILE = path.join(import.meta.dirname, "cluster-compare.html");

// ── Run Python pipeline ──
console.log(`Running Python UMAP + HDBSCAN on ${SAMPLE_SIZE} items...`);
const pyResult = execSync(
  `"${PYTHON}" "${SCRIPT}" --sample ${SAMPLE_SIZE} --min-cluster-size 15`,
  { maxBuffer: 500 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] }
);
const data = JSON.parse(pyResult.toString());

// ── Load cache for old pipeline ──
const cacheFile = fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : APP_CACHE;
const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const sampleIds = data.ids;
const vectors = sampleIds.map(id => cache[id].vec);

// ── Old pipeline (JS bisecting k-means) ──
console.log("Running old pipeline (bisecting k-means on 768d)...");

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

let nid = 0;
function buildNode(indices) {
  const vecs = indices.map(i => vectors[i]);
  const c = computeCentroid(vecs);
  return { id: nid++, indices, cohesion: computeCohesion(vecs, c), children: null };
}
const root = buildNode(Array.from({ length: sampleIds.length }, (_, i) => i));
let leaves = [root];
const unsplittable = new Set();
while (leaves.length < 60) {
  let bestIdx = -1, bestPri = -Infinity;
  for (let i = 0; i < leaves.length; i++) {
    if (unsplittable.has(leaves[i].id)) continue;
    if (leaves[i].indices.length < 20) continue;
    if (leaves[i].cohesion >= 0.92) continue;
    const pri = leaves[i].indices.length * (1 - leaves[i].cohesion);
    if (pri > bestPri) { bestPri = pri; bestIdx = i; }
  }
  if (bestIdx === -1) break;
  const target = leaves[bestIdx];
  const subVecs = target.indices.map(i => vectors[i]);
  const assign = bisectKMeans(subVecs);
  const left = [], right = [];
  for (let i = 0; i < assign.length; i++) (assign[i] === 0 ? left : right).push(target.indices[i]);
  if (left.length < 10 || right.length < 10) { unsplittable.add(target.id); continue; }
  const ln = buildNode(left), rn = buildNode(right);
  target.children = [ln, rn]; leaves.splice(bestIdx, 1, ln, rn);
}

const oldLabels = new Array(sampleIds.length).fill(-1);
leaves.forEach((leaf, ci) => { for (const i of leaf.indices) oldLabels[i] = ci; });

// ── Stats ──
function clusterStats(labels, name) {
  const unique = [...new Set(labels)].sort((a, b) => a - b);
  const clusterLabels = unique.filter(l => l >= 0);
  const noiseCount = labels.filter(l => l === -1).length;
  const purities = clusterLabels.map(cl => {
    const memberIds = labels.map((l, i) => l === cl ? sampleIds[i] : null).filter(Boolean);
    const cats = new Map();
    for (const id of memberIds) cats.set(cache[id]?.category || "", (cats.get(cache[id]?.category || "") || 0) + 1);
    const top = [...cats.entries()].sort((a, b) => b[1] - a[1])[0];
    return top[1] / memberIds.length;
  });
  const avgPurity = purities.length > 0 ? purities.reduce((a, b) => a + b, 0) / purities.length : 0;
  const cohesions = clusterLabels.map(cl => {
    const memberVecs = labels.map((l, i) => l === cl ? vectors[i] : null).filter(Boolean);
    if (memberVecs.length < 2) return 1;
    const c = computeCentroid(memberVecs);
    return computeCohesion(memberVecs, c);
  });
  const avgCohesion = cohesions.length > 0 ? cohesions.reduce((a, b) => a + b, 0) / cohesions.length : 0;
  console.log(`  ${name}: ${clusterLabels.length} clusters, ${noiseCount} noise, purity ${(avgPurity*100).toFixed(1)}%, cohesion ${(avgCohesion*100).toFixed(1)}%`);
  return { clusters: clusterLabels.length, noise: noiseCount, avgPurity, avgCohesion };
}

const oldStats = clusterStats(oldLabels, "Old (k-means)");
const newStats = clusterStats(data.labels, "New (HDBSCAN)");

// ── Build points using Python's 2D UMAP coords ──
const points = sampleIds.map((id, i) => ({
  x: data.reduced_2d[i][0],
  y: data.reduced_2d[i][1],
  oldLabel: oldLabels[i],
  newLabel: data.labels[i],
  category: cache[id]?.category || "",
  topic: (cache[id]?.topic || "").slice(0, 60),
}));

// ── Slider data ──
const sliderData = data.slider_results.map(sr => ({
  mcs: sr.min_cluster_size,
  clusters: sr.clusters,
  noise: sr.noise,
  purity: sr.avg_purity,
  labels: sr.labels,
}));

// ── Generate HTML ──
console.log(`Writing ${OUT_FILE}...`);

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Roost Cluster Comparison — ${sampleIds.length} items</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; border-bottom: 1px solid #333; }
  .header h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
  .header .stats { display: flex; gap: 32px; font-size: 13px; color: #999; flex-wrap: wrap; }
  .header .stat-value { color: #fff; font-weight: 600; }
  .controls { padding: 8px 24px; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 16px; }
  .controls label { font-size: 12px; color: #999; }
  .controls input[type="range"] { width: 200px; }
  .controls .slider-info { font-size: 12px; color: #7ec8e3; min-width: 200px; }
  .panels { display: flex; height: calc(100vh - 130px); }
  .panel { flex: 1; position: relative; border-right: 1px solid #333; }
  .panel:last-child { border-right: none; }
  .panel-title { position: absolute; top: 8px; left: 12px; z-index: 10;
    font-size: 13px; font-weight: 600; background: rgba(26,26,46,0.85);
    padding: 4px 10px; border-radius: 6px; border: 1px solid #444; }
  .panel-stats { position: absolute; top: 8px; right: 12px; z-index: 10;
    font-size: 11px; color: #888; background: rgba(26,26,46,0.85);
    padding: 4px 10px; border-radius: 6px; border: 1px solid #333; }
  canvas { width: 100%; height: 100%; cursor: crosshair; }
  .tooltip { position: fixed; pointer-events: none; z-index: 100;
    background: rgba(20,20,40,0.95); border: 1px solid #555; border-radius: 6px;
    padding: 8px 12px; font-size: 12px; max-width: 300px; display: none; }
  .tooltip .cat { color: #7ec8e3; }
  .tooltip .topic { color: #999; font-style: italic; }
  .legend { position: absolute; bottom: 8px; left: 12px; z-index: 10;
    font-size: 11px; background: rgba(26,26,46,0.85); padding: 6px 10px;
    border-radius: 6px; border: 1px solid #333; max-height: 200px; overflow-y: auto; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
</style>
</head>
<body>
<div class="header">
  <h1>Cluster Comparison — ${sampleIds.length} items</h1>
  <div class="stats">
    <div>Old (bisecting k-means 768d): <span class="stat-value">${oldStats.clusters} clusters</span>, purity <span class="stat-value">${(oldStats.avgPurity*100).toFixed(1)}%</span>, cohesion ${(oldStats.avgCohesion*100).toFixed(1)}%</div>
    <div>New (UMAP 15d + HDBSCAN): <span class="stat-value">${newStats.clusters} clusters</span>, ${newStats.noise} noise, purity <span class="stat-value">${(newStats.avgPurity*100).toFixed(1)}%</span>, cohesion ${(newStats.avgCohesion*100).toFixed(1)}%</div>
  </div>
</div>
<div class="controls">
  <label>minClusterSize:</label>
  <input type="range" id="slider" min="0" max="${sliderData.length - 1}" value="2" step="1">
  <div class="slider-info" id="slider-info"></div>
</div>
<div class="panels">
  <div class="panel">
    <div class="panel-title">Old: Bisecting K-Means</div>
    <div class="panel-stats" id="stats-old"></div>
    <canvas id="canvas-old"></canvas>
    <div class="legend" id="legend-old"></div>
  </div>
  <div class="panel">
    <div class="panel-title">New: UMAP + HDBSCAN</div>
    <div class="panel-stats" id="stats-new"></div>
    <canvas id="canvas-new"></canvas>
    <div class="legend" id="legend-new"></div>
  </div>
</div>
<div class="tooltip" id="tooltip"></div>
<script>
const points = ${JSON.stringify(points)};
const sliderData = ${JSON.stringify(sliderData)};

function clusterColor(label, total) {
  if (label < 0) return "rgba(100,100,100,0.25)";
  const hue = (label * 360 / Math.max(total, 1) + 15) % 360;
  return \`hsla(\${hue}, 70%, 60%, 0.7)\`;
}

// Compute bounds once (shared 2D coords)
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const p of points) {
  if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
  if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
}

function drawCanvas(canvasId, legendId, statsId, labels, statsText) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  ctx.scale(dpr, dpr);

  const W = rect.width, H = rect.height, pad = 40;
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const scale = Math.min((W - pad*2) / rangeX, (H - pad*2) / rangeY);
  const ox = (W - rangeX * scale) / 2, oy = (H - rangeY * scale) / 2;
  function toScreen(p) { return { x: ox + (p.x - minX) * scale, y: oy + (p.y - minY) * scale }; }

  const uniqueLabels = [...new Set(labels)].sort((a,b) => a-b);
  const clusterLabels = uniqueLabels.filter(l => l >= 0);
  const totalClusters = clusterLabels.length;

  ctx.clearRect(0, 0, W, H);

  // Noise first
  for (let i = 0; i < points.length; i++) {
    if (labels[i] >= 0) continue;
    const s = toScreen(points[i]);
    ctx.fillStyle = "rgba(80,80,80,0.2)";
    ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI*2); ctx.fill();
  }
  // Clusters
  for (let i = 0; i < points.length; i++) {
    if (labels[i] < 0) continue;
    const s = toScreen(points[i]);
    ctx.fillStyle = clusterColor(labels[i], totalClusters);
    ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI*2); ctx.fill();
  }

  // Legend
  const legend = document.getElementById(legendId);
  legend.innerHTML = "";
  const noiseCount = labels.filter(l => l === -1).length;
  for (const cl of clusterLabels) {
    const count = labels.filter(l => l === cl).length;
    const div = document.createElement("div");
    div.className = "legend-item";
    div.innerHTML = \`<span class="legend-dot" style="background:\${clusterColor(cl, totalClusters)}"></span>Cluster \${cl} (\${count})\`;
    legend.appendChild(div);
  }
  if (noiseCount > 0) {
    const div = document.createElement("div");
    div.className = "legend-item";
    div.innerHTML = \`<span class="legend-dot" style="background:rgba(100,100,100,0.5)"></span>Noise (\${noiseCount})\`;
    legend.appendChild(div);
  }

  document.getElementById(statsId).textContent = statsText;

  // Tooltip
  const tooltip = document.getElementById("tooltip");
  canvas.onmousemove = (e) => {
    const br = canvas.getBoundingClientRect();
    const mx = e.clientX - br.left, my = e.clientY - br.top;
    let closest = null, closestDist = 15;
    for (let i = 0; i < points.length; i++) {
      const s = toScreen(points[i]);
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < closestDist) { closestDist = d; closest = i; }
    }
    if (closest !== null) {
      const p = points[closest];
      tooltip.style.display = "block";
      tooltip.style.left = (e.clientX + 12) + "px";
      tooltip.style.top = (e.clientY + 12) + "px";
      const label = labels[closest];
      tooltip.innerHTML = \`<div><strong>\${label >= 0 ? "Cluster " + label : "Noise"}</strong></div><div class="cat">\${p.category}</div><div class="topic">\${p.topic}</div>\`;
    } else {
      tooltip.style.display = "none";
    }
  };
  canvas.onmouseleave = () => { tooltip.style.display = "none"; };
}

// Old panel (static)
const oldLabels = points.map(p => p.oldLabel);
drawCanvas("canvas-old", "legend-old", "stats-old", oldLabels,
  \`${oldStats.clusters} clusters · purity ${(oldStats.avgPurity*100).toFixed(1)}%\`);

// New panel (slider-controlled)
function updateNew(idx) {
  const sr = sliderData[idx];
  document.getElementById("slider-info").textContent =
    \`mcs=\${sr.mcs} → \${sr.clusters} clusters, \${sr.noise} noise, purity \${(sr.purity*100).toFixed(1)}%\`;
  drawCanvas("canvas-new", "legend-new", "stats-new", sr.labels,
    \`\${sr.clusters} clusters · \${sr.noise} noise · purity \${(sr.purity*100).toFixed(1)}%\`);
}

document.getElementById("slider").addEventListener("input", (e) => updateNew(+e.target.value));
updateNew(2); // default: index 2 = mcs=15
</script>
</body>
</html>`;

fs.writeFileSync(OUT_FILE, html);
console.log(`\nDone! Open: file://${OUT_FILE}`);
