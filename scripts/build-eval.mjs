#!/usr/bin/env node
/**
 * Build an HTML evaluation page for the 20 test items.
 * Shows cover image, summary, TikTok link, all strategy picks.
 * User labels each item → exports JSON for scoring.
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const SEED = 42;

const cache = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "embedding-cache.json"), "utf8"));

// ── Math helpers ──
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mag(a) { return Math.sqrt(dot(a, a)); }
function cosineSim(a, b) { return dot(a, b) / ((mag(a) || 1) * (mag(b) || 1)); }
function computeCentroid(vecs) {
  const d = vecs[0].length;
  const c = new Array(d).fill(0);
  for (const v of vecs) for (let i = 0; i < d; i++) c[i] += v[i];
  for (let i = 0; i < d; i++) c[i] /= vecs.length;
  return c;
}
function stripPreamble(s) {
  return s.replace(/^(This |The |A |An )(short )?(video|image|photo|picture|clip|post|content|reel|story|scene|screenshot|thumbnail|frame|visual|document|subject|footage)[a-z]* (features?|shows?|depicts?|captures?|displays?|presents?|documents?|illustrates?|demonstrates?|highlights?|showcases?|contains?|reveals?|portrays?|is about|involves?|focuses on|centers on|describes?)\s*/i, "");
}
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Build collection data ──
const collectionItems = new Map();
const syncFolder = path.join(VAULT_PATH, "Bookmarks");

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { scanDir(path.join(dir, entry.name)); continue; }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];
      const idMatch = fm.match(/roost_id:\s*"?([^"\n]+)"?/);
      if (!idMatch) continue;
      const id = idMatch[1].trim();
      const collMatch = fm.match(/^collection:\s*(.+)/m);
      const catMatch = fm.match(/^roost_category:\s*(.+)/m);
      const cat = (catMatch?.[1] || collMatch?.[1])?.trim()?.replace(/^"|"$/g, "");
      if (cat && cat !== "undefined" && cat !== "null") {
        if (!collectionItems.has(cat)) collectionItems.set(cat, []);
        collectionItems.get(cat).push(id);
      }
    } catch {}
  }
}
scanDir(syncFolder);

const categoryDefs = [];
for (const [name, ids] of collectionItems) {
  const vecs = ids.filter(id => cache[id]?.vec).map(id => cache[id].vec);
  if (vecs.length === 0) continue;
  categoryDefs.push({ name, centroid: computeCentroid(vecs), memberIds: ids });
}

// ── Pick same 20 items as test-strategies.mjs ──
const labeledIds = new Set();
for (const [, ids] of collectionItems) for (const id of ids) labeledIds.add(id);

const unsortedIds = [];
for (const [id, entry] of Object.entries(cache)) {
  if (!id.startsWith("tiktok:")) continue;
  if (!entry.vec) continue;
  if (!labeledIds.has(id)) unsortedIds.push(id);
}
unsortedIds.sort();

const rng = mulberry32(SEED);
for (let i = unsortedIds.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [unsortedIds[i], unsortedIds[j]] = [unsortedIds[j], unsortedIds[i]];
}
const testIds = unsortedIds.slice(0, 20);

// ── Find vault files for each test item ──
const idToFile = new Map();
function scanForFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { scanForFiles(path.join(dir, entry.name)); continue; }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const filePath = path.join(dir, entry.name);
      const content = fs.readFileSync(filePath, "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];
      const idMatch = fm.match(/roost_id:\s*"?([^"\n]+)"?/);
      if (idMatch) idToFile.set(idMatch[1].trim(), { filePath, fm });
    } catch {}
  }
}
scanForFiles(syncFolder);

// ── Build item data ──
const TOP_K = 5;
const items = testIds.map((id, idx) => {
  const entry = cache[id];
  const summary = stripPreamble((entry.summary || entry.vision?.slice(0, 100) || id)).slice(0, 200);
  const candidates = categoryDefs
    .map(cat => ({ name: cat.name, sim: cosineSim(entry.vec, cat.centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K);

  const fileInfo = idToFile.get(id);
  let url = "", title = "", coverPath = "", subtitle = "";
  if (fileInfo) {
    const urlMatch = fileInfo.fm.match(/^url:\s*(.+)/m);
    url = urlMatch?.[1]?.trim() || "";
    const titleMatch = fileInfo.fm.match(/^title:\s*"?([\s\S]*?)"?\s*$/m);
    title = titleMatch?.[1]?.trim()?.replace(/^"|"$/g, "") || "";
    const coverMatch = fileInfo.fm.match(/^cover:\s*"?\[\[([^\]]+)\]\]"?/m);
    if (coverMatch) {
      coverPath = path.join(VAULT_PATH, coverMatch[1]);
    }
    const subMatch = fileInfo.fm.match(/^subtitle:\s*"?([\s\S]*?)"?\s*$/m);
    subtitle = subMatch?.[1]?.trim()?.replace(/^"|"$/g, "") || "";
  }

  // Extract video ID for media path fallback
  const videoId = id.replace("tiktok:", "");
  const mediaDir = path.join(VAULT_PATH, "Bookmarks/TikTok", `tiktok-${videoId}`);
  if (!coverPath && fs.existsSync(path.join(mediaDir, "cover.jpg"))) {
    coverPath = path.join(mediaDir, "cover.jpg");
  }
  const videoPath = fs.existsSync(path.join(mediaDir, "video.mp4")) ? path.join(mediaDir, "video.mp4") : "";

  return { idx, id, summary, url, title: title.slice(0, 200), subtitle: subtitle.slice(0, 300), coverPath, videoPath, candidates, ollamaCategory: entry.category };
});

// ── Strategy results from test output (hardcoded from the run) ──
const strategyPicks = {
  "Embedding-only": ["Stuff","Edits","Relationships","Edits","Lifestyle","Music","Edits","Macro","Macro","Crafts","Places","Art","Places","Austin","No match","Finances","Media List","Art","Austin","Fitness"],
  "Binary llama": ["No match","No match","Relationships","Edits","No match","Music","Edits","Macro","Macro","No match","No match","Art","No match","No match","Places","Finances","Media List","Art","Austin","Fitness"],
  "Binary gemma4": ["Stuff","Edits","Relationships","Edits","Lifestyle","No match","Edits","Macro","Macro","Crafts","No match","Art","No match","Austin","Places","Finances","Media List","Art","Austin","Fitness"],
  "Tiered": ["Stuff","Edits","Relationships","Edits","Lifestyle","Music","Edits","Macro","Macro","No match","No match","Art","No match","Austin","Places","Finances","No match","No match","Austin","Fitness"],
  "Batched": ["code","Edits","Kaizen","Media List","Crafts","Music","Watchlist","Macro","Macro","Lifestyle","???","???","???","???","???","Finances","No match","Art","Austin","Fitness"],
  "Baseline MC": ["Stuff","Media List","Relationships","Stuff","Lifestyle","Music","Media List","Macro","Macro","Crafts","D & D","Art","Edits","Stuff","Vibes","Finances","Edits","Media List","Media List","Fitness"],
  "Two-pass NOT": ["Stuff","Edits","Relationships","Edits","Lifestyle","Music","Edits","Macro","Macro","Crafts","No match","Art","No match","Austin","Places","Finances","Media List","Art","Austin","Fitness"],
};

const collectionNames = [...collectionItems.keys()].sort();

// ── Generate HTML ──
const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Smart Assign Evaluation — 20 Items</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  h1 { text-align: center; margin-bottom: 10px; color: #fff; }
  .instructions { text-align: center; margin-bottom: 20px; color: #aaa; font-size: 14px; }
  .item-card { background: #16213e; border-radius: 12px; padding: 20px; margin-bottom: 20px; display: grid; grid-template-columns: 200px 1fr; gap: 20px; }
  .item-num { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.7); color: #fff; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 14px; }
  .media-col { position: relative; }
  .cover { width: 200px; height: 355px; object-fit: cover; border-radius: 8px; cursor: pointer; }
  video.cover { background: #000; }
  .info-col { display: flex; flex-direction: column; gap: 10px; }
  .title { font-size: 13px; color: #8888aa; line-height: 1.4; max-height: 40px; overflow: hidden; }
  .summary { font-size: 15px; line-height: 1.5; color: #ddd; }
  .subtitle { font-size: 12px; color: #777; line-height: 1.4; max-height: 60px; overflow: hidden; }
  .link { font-size: 13px; }
  .link a { color: #4ea8de; text-decoration: none; }
  .link a:hover { text-decoration: underline; }
  .candidates { font-size: 13px; color: #999; }
  .candidates span { margin-right: 12px; }
  .strategies { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; font-size: 13px; margin-top: 5px; }
  .strat { background: #1a1a3e; padding: 4px 8px; border-radius: 4px; }
  .strat-name { color: #666; font-size: 11px; }
  .strat-pick { color: #ccc; font-weight: 500; }
  .strat-pick.no-match { color: #666; font-style: italic; }
  .label-row { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
  .label-row select { font-size: 15px; padding: 6px 10px; border-radius: 6px; background: #0f3460; color: #fff; border: 1px solid #4ea8de; }
  .label-row label { font-weight: bold; color: #4ea8de; }
  .export-bar { position: sticky; bottom: 0; background: #0f3460; padding: 15px; text-align: center; border-radius: 8px; margin-top: 20px; }
  .export-bar button { font-size: 16px; padding: 10px 30px; border-radius: 8px; background: #4ea8de; color: #fff; border: none; cursor: pointer; font-weight: bold; }
  .export-bar button:hover { background: #3a8fbe; }
  .progress { color: #aaa; margin-left: 20px; }
  .score-table { margin-top: 20px; width: 100%; border-collapse: collapse; }
  .score-table th, .score-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
  .score-table th { color: #4ea8de; }
  #results-area { display: none; margin-top: 20px; background: #16213e; padding: 20px; border-radius: 12px; }
</style>
</head>
<body>
<h1>Smart Assign Evaluation</h1>
<p class="instructions">For each item, select the collection it belongs in (or "None"). Click the cover image to play/pause video. Click "Score All Strategies" when done.</p>

${items.map((item, i) => `
<div class="item-card" id="card-${i}">
  <div class="media-col">
    <span class="item-num">#${i + 1}</span>
    ${item.videoPath
      ? `<video class="cover" src="file://${item.videoPath}" poster="file://${item.coverPath}" muted loop playsinline onclick="this.paused?this.play():this.pause()"></video>`
      : `<img class="cover" src="file://${item.coverPath}" onerror="this.style.background='#333'">`
    }
  </div>
  <div class="info-col">
    <div class="summary">${escapeHtml(item.summary)}</div>
    ${item.title ? `<div class="title">${escapeHtml(item.title.slice(0, 150))}</div>` : ""}
    ${item.subtitle ? `<div class="subtitle">${escapeHtml(item.subtitle.slice(0, 250))}</div>` : ""}
    ${item.url ? `<div class="link"><a href="${escapeHtml(item.url)}" target="_blank">Open on TikTok</a></div>` : ""}
    <div class="candidates">Top-5: ${item.candidates.map(c => `<span>${c.name} (${c.sim.toFixed(3)})</span>`).join("")}</div>
    <div class="strategies">
      ${Object.entries(strategyPicks).map(([name, picks]) => {
        const pick = picks[i];
        const cls = (pick === "No match" || pick === "???") ? "no-match" : "";
        return `<div class="strat"><div class="strat-name">${name}</div><div class="strat-pick ${cls}">${pick}</div></div>`;
      }).join("")}
    </div>
    <div class="label-row">
      <label for="label-${i}">Your label:</label>
      <select id="label-${i}" onchange="updateProgress()">
        <option value="">-- select --</option>
        <option value="None">None (doesn't belong anywhere)</option>
        ${collectionNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}
      </select>
    </div>
  </div>
</div>
`).join("")}

<div class="export-bar">
  <button onclick="scoreStrategies()">Score All Strategies</button>
  <span class="progress" id="progress">0 / 20 labeled</span>
</div>

<div id="results-area"></div>

<script>
const N = ${items.length};
const strategyPicks = ${JSON.stringify(strategyPicks)};
const strategyTimes = {
  "Embedding-only": 0.0,
  "Binary llama": 19.8,
  "Binary gemma4": 361.7,
  "Tiered": 24.8,
  "Batched": 298.0,
  "Baseline MC": 423.4,
  "Two-pass NOT": 294.5,
};

function updateProgress() {
  let n = 0;
  for (let i = 0; i < N; i++) {
    if (document.getElementById('label-' + i).value) n++;
  }
  document.getElementById('progress').textContent = n + ' / ' + N + ' labeled';
}

function scoreStrategies() {
  const labels = [];
  for (let i = 0; i < N; i++) {
    labels.push(document.getElementById('label-' + i).value);
  }
  const unlabeled = labels.filter(l => !l).length;
  if (unlabeled > 0 && !confirm(unlabeled + ' items unlabeled. Score anyway?')) return;

  // Score each strategy
  const results = {};
  for (const [name, picks] of Object.entries(strategyPicks)) {
    let total = 0, correct = 0, acceptable = 0, wrong = 0;
    let correctReject = 0, overReject = 0, underReject = 0;
    const details = [];
    for (let i = 0; i < N; i++) {
      const label = labels[i];
      if (!label) { details.push({ score: '-', pick: picks[i], label }); continue; }
      const pick = picks[i];
      let score;
      if (label === "None") {
        if (pick === "No match" || pick === "???") { score = 3; correctReject++; }
        else { score = 0; underReject++; }
      } else if (pick === "No match" || pick === "???") {
        score = 1; overReject++;
      } else if (pick === label) {
        score = 3; correct++;
      } else {
        // Check if it's a "neighbor" — close enough to be acceptable
        // For now, mark as wrong; user can override
        score = 0; wrong++;
      }
      total += score;
      details.push({ score, pick, label });
    }
    const labeled = labels.filter(l => l).length;
    const hasHome = labels.filter(l => l && l !== "None").length;
    const assigned = picks.filter((p, i) => labels[i] && p !== "No match" && p !== "???").length;
    const correctAssigned = details.filter(d => d.score === 3 && d.label !== "None").length;

    results[name] = {
      meanScore: labeled > 0 ? (total / labeled).toFixed(2) : '-',
      precision: assigned > 0 ? (correctAssigned / assigned * 100).toFixed(0) + '%' : '-',
      recall: hasHome > 0 ? (assigned / hasHome * 100).toFixed(0) + '%' : '-',
      correct, overReject, underReject, wrong,
      time: strategyTimes[name],
      details,
    };
  }

  // Render results table
  let html = '<h2 style="color:#fff;margin-bottom:15px">Strategy Scores</h2>';
  html += '<table class="score-table"><tr><th>Strategy</th><th>Mean Score</th><th>Precision</th><th>Recall</th><th>Correct</th><th>Over-reject</th><th>Under-reject</th><th>Wrong</th><th>Time</th><th>Score/sec</th></tr>';
  for (const [name, r] of Object.entries(results)) {
    const sps = r.time > 0 ? (parseFloat(r.meanScore) / r.time * 100).toFixed(2) : '\\u221e';
    html += '<tr><td>' + name + '</td><td>' + r.meanScore + '</td><td>' + r.precision + '</td><td>' + r.recall + '</td><td>' + r.correct + '</td><td>' + r.overReject + '</td><td>' + r.underReject + '</td><td>' + r.wrong + '</td><td>' + r.time + 's</td><td>' + sps + '</td></tr>';
  }
  html += '</table>';

  // Per-item breakdown
  html += '<h3 style="color:#fff;margin:20px 0 10px">Per-Item Detail</h3>';
  html += '<table class="score-table"><tr><th>#</th><th>Your Label</th>';
  for (const name of Object.keys(results)) html += '<th>' + name + '</th>';
  html += '</tr>';
  for (let i = 0; i < N; i++) {
    html += '<tr><td>' + (i+1) + '</td><td style="color:#4ea8de">' + (labels[i] || '-') + '</td>';
    for (const [name, r] of Object.entries(results)) {
      const d = r.details[i];
      const color = d.score === 3 ? '#4ade80' : d.score === 1 ? '#fbbf24' : d.score === 0 ? '#f87171' : '#666';
      html += '<td style="color:' + color + '">' + d.pick + ' (' + d.score + ')</td>';
    }
    html += '</tr>';
  }
  html += '</table>';

  // Export labels as JSON
  html += '<h3 style="color:#fff;margin:20px 0 10px">Labels JSON</h3>';
  html += '<pre style="background:#0a0a1a;padding:12px;border-radius:8px;font-size:13px;overflow-x:auto">' + JSON.stringify(labels, null, 2) + '</pre>';

  const area = document.getElementById('results-area');
  area.innerHTML = html;
  area.style.display = 'block';
  area.scrollIntoView({ behavior: 'smooth' });
}
</script>
</body>
</html>`;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const outPath = path.join(ROOST_DIR, "eval.html");
fs.writeFileSync(outPath, html);
console.log(`Wrote evaluation page to: ${outPath}`);
console.log(`Open in browser: file://${outPath}`);
