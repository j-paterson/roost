#!/usr/bin/env node
/**
 * Generate an interactive HTML visualization of clustering results.
 * UMAP reduces to 2D, then plots items colored by:
 * - Cluster assignment (what the algorithm says)
 * - Collection tag (ground truth)
 * Toggle between views to see where they agree/disagree.
 *
 * Usage: node scripts/visualize-clusters.mjs
 *        open test/cluster-viz.html
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import crypto from "crypto";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");
const PYTHON = path.join(VAULT_PATH, ".roost", "venv", "bin", "python");
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const CLUSTER_SCRIPT = path.join(SCRIPT_DIR, "roost-cluster.py");

console.log("Loading data...");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

// Parse vault for collection tags
const itemCollections = new Map(); // id → collection name
const allGtIds = [];

function walkVault(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkVault(full); continue; }
    if (!entry.name.endsWith(".md")) continue;
    const content = fs.readFileSync(full, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const idMatch = fm.match(/^roost_id:\s*"?([^\s"]+)"?\s*$/m);
    if (!idMatch || !cache[idMatch[1]]?.vec) continue;
    const id = idMatch[1];
    const tagSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
    if (tagSection) for (const line of tagSection[1].split("\n")) {
      const t = line.match(/^\s+-\s+collection\/(.+)/);
      if (t) { itemCollections.set(id, t[1].trim()); allGtIds.push(id); break; }
    }
    if (!itemCollections.has(id)) {
      const cm = fm.match(/^collection:\s*"?([^\n"]+)"?/m);
      if (cm) { itemCollections.set(id, cm[1].trim()); allGtIds.push(id); }
    }
  }
}
walkVault(path.join(VAULT_PATH, "Bookmarks"));
console.log(`${allGtIds.length} ground truth items`);

// Run UMAP to 2D + HDBSCAN
console.log("Running UMAP (2D) + HDBSCAN...");
const inp = path.join(os.tmpdir(), `roost-viz-${crypto.randomUUID()}.json`);
fs.writeFileSync(inp, JSON.stringify({
  ids: allGtIds,
  vectors: allGtIds.map(id => cache[id].vec),
  min_cluster_sizes: [8],
  umap_n_components: 2,
  umap_n_neighbors: 15,
  umap_min_dist: 0.1,
}));
const result = JSON.parse(execFileSync(PYTHON, [CLUSTER_SCRIPT, "--input", inp], {
  encoding: "utf8", timeout: 300000, maxBuffer: 500 * 1024 * 1024,
}));
fs.unlinkSync(inp);

const reduced2d = result.reduced;
const hdbLabels = result.batch["8"];

// Name HDBSCAN clusters
function nameCluster(ids) {
  const cats = new Map();
  for (const id of ids) {
    const cat = cache[id]?.category;
    if (cat) cats.set(cat, (cats.get(cat) || 0) + 1);
  }
  if (cats.size === 0) return "Unknown";
  return [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const clusterMembers = new Map();
for (let i = 0; i < hdbLabels.length; i++) {
  if (hdbLabels[i] === -1) continue;
  if (!clusterMembers.has(hdbLabels[i])) clusterMembers.set(hdbLabels[i], []);
  clusterMembers.get(hdbLabels[i]).push(allGtIds[i]);
}
const clusterNames = new Map();
for (const [label, members] of clusterMembers) clusterNames.set(label, nameCluster(members));

// Build data for HTML
const points = allGtIds.map((id, i) => ({
  x: reduced2d[i][0],
  y: reduced2d[i][1],
  id,
  collection: itemCollections.get(id) || "None",
  cluster: hdbLabels[i] === -1 ? "Noise" : (clusterNames.get(hdbLabels[i]) || "Unknown"),
  clusterLabel: hdbLabels[i],
  summary: (cache[id]?.summary || "").slice(0, 80),
}));

// Generate HTML
const html = `<!DOCTYPE html>
<html>
<head>
<title>Roost Cluster Visualization</title>
<style>
  body { margin: 0; background: #1a1a2e; color: #e0e0e0; font-family: system-ui; }
  #controls { position: fixed; top: 10px; left: 10px; z-index: 10; background: #16213e; padding: 12px; border-radius: 8px; }
  #controls button { padding: 6px 14px; margin: 0 4px; border: 1px solid #444; border-radius: 4px; background: #1a1a2e; color: #e0e0e0; cursor: pointer; }
  #controls button.active { background: #0f3460; border-color: #e94560; }
  #tooltip { position: fixed; background: #16213e; border: 1px solid #444; padding: 8px 12px; border-radius: 6px; font-size: 12px; pointer-events: none; display: none; max-width: 300px; z-index: 20; }
  #stats { position: fixed; bottom: 10px; left: 10px; background: #16213e; padding: 10px; border-radius: 8px; font-size: 12px; max-height: 300px; overflow-y: auto; }
  canvas { display: block; }
</style>
</head>
<body>
<div id="controls">
  <button id="btn-collection" class="active" onclick="setMode('collection')">By Collection</button>
  <button id="btn-cluster" onclick="setMode('cluster')">By Cluster</button>
  <button id="btn-match" onclick="setMode('match')">Match/Mismatch</button>
  <span style="margin-left:12px; font-size:12px">${points.length} items</span>
</div>
<div id="tooltip"></div>
<div id="stats"></div>
<canvas id="canvas"></canvas>
<script>
const points = ${JSON.stringify(points)};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const stats = document.getElementById('stats');

let mode = 'collection';
let W, H;

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
  draw();
}
window.addEventListener('resize', resize);

// Color palettes
const palette = [
  '#e94560','#0f3460','#16c79a','#f5a623','#bd10e0','#50e3c2','#7ed321','#9013fe',
  '#d0021b','#4a90d9','#f8e71c','#8b572a','#417505','#b8e986','#c47dff','#ff6b6b',
  '#4ecdc4','#45b7d1','#96ceb4','#ffeaa7','#dfe6e9','#fd79a8','#6c5ce7','#00b894',
  '#e17055','#74b9ff','#a29bfe','#fdcb6e','#636e72','#2d3436','#fab1a0','#81ecec',
  '#55efc4','#ffeaa7','#dfe6e9','#b2bec3','#ff7675','#fd79a8','#e84393','#6c5ce7',
];

function getUniqueValues(key) {
  return [...new Set(points.map(p => p[key]))].sort();
}

function colorMap(values) {
  const map = {};
  values.forEach((v, i) => map[v] = palette[i % palette.length]);
  map['Noise'] = '#333';
  map['None'] = '#333';
  return map;
}

const collectionColors = colorMap(getUniqueValues('collection'));
const clusterColors = colorMap(getUniqueValues('cluster'));

// Scale points to canvas
const xs = points.map(p => p.x), ys = points.map(p => p.y);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minY = Math.min(...ys), maxY = Math.max(...ys);
const pad = 60;

function toScreen(x, y) {
  return [
    pad + (x - minX) / (maxX - minX) * (W - pad * 2),
    pad + (y - minY) / (maxY - minY) * (H - pad * 2),
  ];
}

function draw() {
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  for (const p of points) {
    const [sx, sy] = toScreen(p.x, p.y);
    let color;
    if (mode === 'collection') color = collectionColors[p.collection] || '#333';
    else if (mode === 'cluster') color = clusterColors[p.cluster] || '#333';
    else {
      // Match mode: green if cluster name ~ collection name, red if not, gray if noise
      if (p.cluster === 'Noise') color = '#333';
      else if (p.cluster.toLowerCase().includes(p.collection.toLowerCase().slice(0,4)) ||
               p.collection.toLowerCase().includes(p.cluster.toLowerCase().slice(0,4)))
        color = '#16c79a';
      else color = '#e94560';
    }
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Stats
  if (mode === 'collection') {
    const counts = {};
    points.forEach(p => counts[p.collection] = (counts[p.collection] || 0) + 1);
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    stats.innerHTML = '<b>Collections</b><br>' + sorted.map(([n, c]) =>
      '<span style="color:' + (collectionColors[n]||'#999') + '">■</span> ' + n + ' (' + c + ')'
    ).join('<br>');
  } else if (mode === 'cluster') {
    const counts = {};
    points.forEach(p => counts[p.cluster] = (counts[p.cluster] || 0) + 1);
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    stats.innerHTML = '<b>Clusters</b><br>' + sorted.map(([n, c]) =>
      '<span style="color:' + (clusterColors[n]||'#999') + '">■</span> ' + n + ' (' + c + ')'
    ).join('<br>');
  } else {
    const match = points.filter(p => p.cluster !== 'Noise' &&
      (p.cluster.toLowerCase().includes(p.collection.toLowerCase().slice(0,4)) ||
       p.collection.toLowerCase().includes(p.cluster.toLowerCase().slice(0,4)))).length;
    const mismatch = points.filter(p => p.cluster !== 'Noise' &&
      !(p.cluster.toLowerCase().includes(p.collection.toLowerCase().slice(0,4)) ||
        p.collection.toLowerCase().includes(p.cluster.toLowerCase().slice(0,4)))).length;
    const noise = points.filter(p => p.cluster === 'Noise').length;
    stats.innerHTML = '<b>Match Analysis</b><br>' +
      '<span style="color:#16c79a">■</span> Match: ' + match + '<br>' +
      '<span style="color:#e94560">■</span> Mismatch: ' + mismatch + '<br>' +
      '<span style="color:#333">■</span> Noise: ' + noise;
  }
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('#controls button').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-' + m).classList.add('active');
  draw();
}

canvas.addEventListener('mousemove', (e) => {
  const mx = e.clientX, my = e.clientY;
  let closest = null, closestDist = 20;
  for (const p of points) {
    const [sx, sy] = toScreen(p.x, p.y);
    const d = Math.hypot(mx - sx, my - sy);
    if (d < closestDist) { closestDist = d; closest = p; }
  }
  if (closest) {
    tooltip.style.display = 'block';
    tooltip.style.left = (mx + 15) + 'px';
    tooltip.style.top = (my + 15) + 'px';
    tooltip.innerHTML = '<b>' + closest.collection + '</b> → ' + closest.cluster + '<br>' + closest.summary;
  } else {
    tooltip.style.display = 'none';
  }
});

resize();
</script>
</body>
</html>`;

const outPath = path.join(SCRIPT_DIR, "..", "test", "cluster-viz.html");
fs.writeFileSync(outPath, html);
console.log(`\nVisualization saved to ${outPath}`);
console.log(`Open with: open ${outPath}`);
