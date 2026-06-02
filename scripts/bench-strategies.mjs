#!/usr/bin/env node
/**
 * Compare clustering strategies head-to-head on ground truth items.
 * Tests current approach vs HDBSCAN-core + LLM-assignment.
 * Uses Gemma 4 as evaluator for all strategies.
 *
 * Usage: node scripts/bench-strategies.mjs
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
const OLLAMA = "http://localhost:11434";
const EVAL_MODEL = "gemma4:e4b";
const MCS = 8; // best from sweep
const EVAL_BATCH = 25;

// ── Load data ─────────────────────────────────────────────────

console.log("Loading data...");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

const collectionItems = new Map();
const allIds = [];
const itemMeta = new Map();

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
    let hasColl = false;
    const tagSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
    if (tagSection) for (const line of tagSection[1].split("\n")) {
      const t = line.match(/^\s+-\s+collection\/(.+)/);
      if (t) { hasColl = true; const n = t[1].trim(); if (!collectionItems.has(n)) collectionItems.set(n, new Set()); collectionItems.get(n).add(id); }
    }
    const cm = fm.match(/^collection:\s*"?([^\n"]+)"?/m);
    if (cm) { hasColl = true; const n = cm[1].trim(); if (!collectionItems.has(n)) collectionItems.set(n, new Set()); collectionItems.get(n).add(id); }
    if (hasColl) {
      allIds.push(id);
      itemMeta.set(id, { summary: cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id });
    }
  }
}
walkVault(path.join(VAULT_PATH, "Bookmarks"));
console.log(`${allIds.length} ground truth items, ${collectionItems.size} collections\n`);

// ── Caching ───────────────────────────────────────────────────

const LLM_CACHE_PATH = path.join(os.tmpdir(), "roost-llm-cache.json");
let llmCache = {};
try { llmCache = JSON.parse(fs.readFileSync(LLM_CACHE_PATH, "utf8")); } catch {}
let llmCacheHits = 0, llmCacheMisses = 0;

function saveLlmCache() { fs.writeFileSync(LLM_CACHE_PATH, JSON.stringify(llmCache)); }

function llmCacheKey(itemId, summary, catListHash) {
  return `${itemId}|${catListHash}`;
}

// Single shared Python result
let sharedPythonResult = null;

// ── Helpers ───────────────────────────────────────────────────

function runPythonCached() {
  if (sharedPythonResult) return sharedPythonResult;
  const inp = path.join(os.tmpdir(), `roost-strat-${crypto.randomUUID()}.json`);
  fs.writeFileSync(inp, JSON.stringify({ ids: allIds, vectors: allIds.map(id => cache[id].vec), min_cluster_sizes: [MCS] }));
  try {
    sharedPythonResult = JSON.parse(execFileSync(PYTHON, [CLUSTER_SCRIPT, "--input", inp], {
      encoding: "utf8", timeout: 300000, maxBuffer: 500 * 1024 * 1024,
    }));
    return sharedPythonResult;
  } finally { try { fs.unlinkSync(inp); } catch {} }
}

const STOPWORDS = new Set(["the","a","an","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","this","that","these","those","and","but","or","not","for","with","about","between","through","during","before","after","from","into","out","over","under","all","both","each","few","more","most","other","some","such","only","very","just","also","now","image","video","post","shows","features","person","people","using","text","wearing","standing","sitting","holding","subject","showcases","captures","depicts","young","woman","man","appears","shown","seen"]);

function nameCluster(memberIds) {
  const cats = new Map();
  for (const id of memberIds) {
    const cat = cache[id]?.category;
    if (cat) cats.set(cat, (cats.get(cat) || 0) + 1);
  }
  if (cats.size > 0) {
    const [topCat, topCount] = [...cats.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= memberIds.length * 0.4) return topCat.charAt(0).toUpperCase() + topCat.slice(1);
  }
  const tf = new Map();
  for (const id of memberIds) {
    if (cache[id]?.summary) for (const w of cache[id].summary.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)) {
      if (w.length >= 4 && !STOPWORDS.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
    }
  }
  let best = "Unnamed", bestScore = -1;
  for (const [term, count] of tf) {
    if (count > bestScore) { bestScore = count; best = term.charAt(0).toUpperCase() + term.slice(1); }
  }
  return best;
}

function computeCollectionF1(assignments) {
  // assignments: Map<string, number> (id → cluster index)
  const clusters = new Map();
  for (const [id, ci] of assignments) {
    if (!clusters.has(ci)) clusters.set(ci, []);
    clusters.get(ci).push(id);
  }
  let f1Sum = 0, n = 0;
  for (const [, collIds] of collectionItems) {
    if (collIds.size < 3) continue;
    let best = 0;
    for (const [, cIds] of clusters) {
      const cs = new Set(cIds);
      const ov = [...collIds].filter(id => cs.has(id)).length;
      if (ov === 0) continue;
      const p = ov / cIds.length, r = ov / collIds.size;
      best = Math.max(best, 2 * p * r / (p + r));
    }
    f1Sum += best; n++;
  }
  return n > 0 ? f1Sum / n : 0;
}

// ── LLM classify batch ────────────────────────────────────────

async function llmClassify(itemSummaries, categoryNames) {
  const catList = categoryNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const catHash = crypto.createHash("md5").update(catList).digest("hex").slice(0, 12);
  const results = new Map(); // id → category index (0-based) or -1

  // Check cache for all items first
  const uncached = [];
  for (const item of itemSummaries) {
    const key = llmCacheKey(item.id, item.summary, catHash);
    if (llmCache[key] !== undefined) {
      results.set(item.id, llmCache[key]);
      llmCacheHits++;
    } else {
      uncached.push(item);
    }
  }

  if (uncached.length === 0) {
    console.log(`    (${itemSummaries.length} items from cache)`);
    return results;
  }
  if (llmCacheHits > 0) {
    console.log(`    (${itemSummaries.length - uncached.length} cached, ${uncached.length} to evaluate)`);
  }

  for (let bi = 0; bi < uncached.length; bi += EVAL_BATCH) {
    const batch = uncached.slice(bi, bi + EVAL_BATCH);
    const LABELS = batch.map((_, i) => i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`);
    const itemLines = batch.map((item, i) => `${LABELS[i]}. ${item.summary}`).join("\n");

    const prompt = `Categories:\n${catList}\n\nFor each item, pick the BEST fitting category number (1-${categoryNames.length}), or NONE.\n\nItems:\n${itemLines}\n\nRespond with ONLY the letter and number (or NONE), one per line:`;

    try {
      const res = await fetch(`${OLLAMA}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
      });
      const raw = (await res.json()).response?.trim() || "";
      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*([A-Z]{1,2})\b.*?\b(\d+|NONE)\s*$/i);
        if (!match) continue;
        const idx = LABELS.indexOf(match[1].toUpperCase());
        if (idx < 0 || idx >= batch.length) continue;
        const verdict = match[2].toUpperCase() === "NONE" ? -1 : parseInt(match[2], 10) - 1;
        results.set(batch[idx].id, verdict);
        // Cache it
        const key = llmCacheKey(batch[idx].id, batch[idx].summary, catHash);
        llmCache[key] = verdict;
        llmCacheMisses++;
      }
    } catch {}

    if ((bi + EVAL_BATCH) % 150 < EVAL_BATCH || bi + EVAL_BATCH >= uncached.length) {
      process.stdout.write(`\r    ${Math.min(bi + EVAL_BATCH, uncached.length)}/${uncached.length}`);
      saveLlmCache();
    }
  }
  console.log();
  return results;
}

// ── Strategy A: Current (k-means primary, HDBSCAN confidence) ─

async function strategyA() {
  console.log("Strategy A: K-means primary + HDBSCAN confidence + LLM eval");

  const result = runPythonCached();
  const hdbLabels = result.batch[String(MCS)];

  // Bisecting k-means on reduced vectors (euclidean)
  const reduced = result.reduced;
  const maxLeaves = Math.max(2, Math.round(allIds.length / MCS));

  // Simple k-means: assign every item to nearest HDBSCAN cluster centroid
  // (approximation of what the plugin does)
  const hdbClusters = new Map();
  for (let i = 0; i < hdbLabels.length; i++) {
    if (hdbLabels[i] === -1) continue;
    if (!hdbClusters.has(hdbLabels[i])) hdbClusters.set(hdbLabels[i], []);
    hdbClusters.get(hdbLabels[i]).push(i);
  }

  // Compute centroids in reduced space
  const centroids = new Map();
  for (const [label, indices] of hdbClusters) {
    const dim = reduced[0].length;
    const avg = new Array(dim).fill(0);
    for (const i of indices) for (let d = 0; d < dim; d++) avg[d] += reduced[i][d];
    for (let d = 0; d < dim; d++) avg[d] /= indices.length;
    centroids.set(label, avg);
  }

  // Assign noise items to nearest centroid
  const assignments = new Map();
  for (let i = 0; i < allIds.length; i++) {
    if (hdbLabels[i] !== -1) {
      assignments.set(allIds[i], hdbLabels[i]);
    } else {
      let bestLabel = 0, bestDist = Infinity;
      for (const [label, centroid] of centroids) {
        let dist = 0;
        for (let d = 0; d < reduced[0].length; d++) { const dd = reduced[i][d] - centroid[d]; dist += dd * dd; }
        if (dist < bestDist) { bestDist = dist; bestLabel = label; }
      }
      assignments.set(allIds[i], bestLabel);
    }
  }

  // Name clusters
  const clusterMembers = new Map();
  for (const [id, label] of assignments) {
    if (!clusterMembers.has(label)) clusterMembers.set(label, []);
    clusterMembers.get(label).push(id);
  }
  const clusterNames = new Map();
  for (const [label, members] of clusterMembers) clusterNames.set(label, nameCluster(members));

  const f1Before = computeCollectionF1(assignments);
  console.log(`  Before LLM: F1=${f1Before.toFixed(4)}, ${clusterMembers.size} clusters, 0 noise (all assigned)`);

  // LLM evaluation
  const catNames = [...new Set(clusterNames.values())];
  const catNameToIdx = new Map();
  catNames.forEach((n, i) => catNameToIdx.set(n, i));

  const itemSummaries = allIds.map(id => ({
    id,
    summary: (cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id).slice(0, 120),
  }));

  console.log(`  Running LLM eval (${catNames.length} categories)...`);
  const verdicts = await llmClassify(itemSummaries, catNames);

  // Apply: confirmed stays, reassigned moves, NONE → misc
  let confirmed = 0, reassigned = 0, misc = 0;
  const finalAssignments = new Map();
  for (const [id, label] of assignments) {
    const currentCatName = clusterNames.get(label);
    const currentCatIdx = catNameToIdx.get(currentCatName);
    const verdict = verdicts.get(id);
    if (verdict === undefined) {
      finalAssignments.set(id, label); confirmed++;
    } else if (verdict === -1) {
      misc++; // not assigned
    } else if (verdict === currentCatIdx) {
      finalAssignments.set(id, label); confirmed++;
    } else {
      // Find cluster with matching name
      const targetName = catNames[verdict];
      let targetLabel = null;
      for (const [l, n] of clusterNames) { if (n === targetName) { targetLabel = l; break; } }
      if (targetLabel !== null) { finalAssignments.set(id, targetLabel); reassigned++; }
      else { misc++; }
    }
  }

  const f1After = computeCollectionF1(finalAssignments);
  console.log(`  After LLM:  F1=${f1After.toFixed(4)}, ${confirmed} confirmed, ${reassigned} reassigned, ${misc} misc`);
  return { f1Before, f1After, confirmed, reassigned, misc, clusters: clusterMembers.size, strategy: "A: k-means + LLM" };
}

// ── Strategy B: HDBSCAN cores + LLM assignment for noise ──────

async function strategyB() {
  console.log("\nStrategy B: HDBSCAN cores + LLM assigns noise items");

  const result = runPythonCached();
  const hdbLabels = result.batch[String(MCS)];

  // HDBSCAN clusters are the "cores"
  const coreAssignments = new Map();
  const noiseIds = [];
  for (let i = 0; i < hdbLabels.length; i++) {
    if (hdbLabels[i] !== -1) coreAssignments.set(allIds[i], hdbLabels[i]);
    else noiseIds.push(allIds[i]);
  }

  // Name core clusters
  const clusterMembers = new Map();
  for (const [id, label] of coreAssignments) {
    if (!clusterMembers.has(label)) clusterMembers.set(label, []);
    clusterMembers.get(label).push(id);
  }
  const clusterNames = new Map();
  for (const [label, members] of clusterMembers) clusterNames.set(label, nameCluster(members));

  const f1Cores = computeCollectionF1(coreAssignments);
  console.log(`  Cores only: F1=${f1Cores.toFixed(4)}, ${clusterMembers.size} clusters, ${noiseIds.length} noise`);

  // LLM assigns noise items to clusters (or NONE)
  const catNames = [...new Set(clusterNames.values())];
  const catNameToIdx = new Map();
  catNames.forEach((n, i) => catNameToIdx.set(n, i));

  const noiseSummaries = noiseIds.map(id => ({
    id,
    summary: (cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id).slice(0, 120),
  }));

  console.log(`  LLM assigning ${noiseIds.length} noise items to ${catNames.length} categories...`);
  const verdicts = await llmClassify(noiseSummaries, catNames);

  // Apply
  const finalAssignments = new Map(coreAssignments);
  let assigned = 0, misc = 0;
  for (const id of noiseIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined || verdict === -1) {
      misc++;
    } else {
      const targetName = catNames[verdict];
      let targetLabel = null;
      for (const [l, n] of clusterNames) { if (n === targetName) { targetLabel = l; break; } }
      if (targetLabel !== null) { finalAssignments.set(id, targetLabel); assigned++; }
      else { misc++; }
    }
  }

  const f1After = computeCollectionF1(finalAssignments);
  const confirmed = coreAssignments.size; // all cores are "confirmed"
  console.log(`  After LLM:  F1=${f1After.toFixed(4)}, ${confirmed} core + ${assigned} LLM-assigned, ${misc} misc`);
  return { f1Before: f1Cores, f1After, confirmed, reassigned: assigned, misc, clusters: clusterMembers.size, strategy: "B: HDBSCAN + LLM" };
}

// ── Strategy C: HDBSCAN cores + LLM evaluates ALL (cores too) ─

async function strategyC() {
  console.log("\nStrategy C: HDBSCAN cores + LLM evaluates everything (cores + noise)");

  const result = runPythonCached();
  const hdbLabels = result.batch[String(MCS)];

  // Name HDBSCAN clusters
  const hdbClusters = new Map();
  for (let i = 0; i < hdbLabels.length; i++) {
    if (hdbLabels[i] === -1) continue;
    if (!hdbClusters.has(hdbLabels[i])) hdbClusters.set(hdbLabels[i], []);
    hdbClusters.get(hdbLabels[i]).push(allIds[i]);
  }
  const clusterNames = new Map();
  for (const [label, members] of hdbClusters) clusterNames.set(label, nameCluster(members));

  const catNames = [...new Set(clusterNames.values())];

  // LLM classifies ALL items
  const allSummaries = allIds.map(id => ({
    id,
    summary: (cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id).slice(0, 120),
  }));

  console.log(`  LLM classifying all ${allIds.length} items against ${catNames.length} categories...`);
  const verdicts = await llmClassify(allSummaries, catNames);

  // Build final assignments purely from LLM verdicts
  const finalAssignments = new Map();
  let assigned = 0, misc = 0;
  for (const id of allIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined || verdict === -1) {
      misc++;
    } else {
      const targetName = catNames[verdict];
      let targetLabel = null;
      for (const [l, n] of clusterNames) { if (n === targetName) { targetLabel = l; break; } }
      if (targetLabel !== null) { finalAssignments.set(id, targetLabel); assigned++; }
      else { misc++; }
    }
  }

  const f1 = computeCollectionF1(finalAssignments);
  console.log(`  Result: F1=${f1.toFixed(4)}, ${assigned} assigned, ${misc} misc`);
  return { f1Before: 0, f1After: f1, confirmed: 0, reassigned: assigned, misc, clusters: catNames.length, strategy: "C: HDBSCAN names + LLM assigns all" };
}

// ── Run all strategies ────────────────────────────────────────

console.log("=".repeat(60));
console.log(`Testing 3 strategies on ${allIds.length} items (mcs=${MCS})\n`);

const results = [];
results.push(await strategyA());
results.push(await strategyB());
results.push(await strategyC());

console.log("\n" + "=".repeat(60));
console.log("\nSummary:");
console.log(`${"Strategy".padEnd(40)} ${"F1".padStart(7)} ${"Misc".padStart(6)} ${"Clusters".padStart(9)}`);
console.log("-".repeat(65));
for (const r of results) {
  console.log(`${r.strategy.padEnd(40)} ${r.f1After.toFixed(4).padStart(7)} ${String(r.misc).padStart(6)} ${String(r.clusters).padStart(9)}`);
}
console.log();
const best = results.sort((a, b) => b.f1After - a.f1After)[0];
console.log(`Winner: ${best.strategy} (F1=${best.f1After.toFixed(4)})`);
console.log(`\nLLM cache: ${llmCacheHits} hits, ${llmCacheMisses} misses`);
saveLlmCache();
