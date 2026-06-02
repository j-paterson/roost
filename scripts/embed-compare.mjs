#!/usr/bin/env node
/**
 * A/B comparison of embedding models on ground truth items.
 * Re-embeds collection-tagged items with a new model, runs UMAP+HDBSCAN,
 * and compares collection recovery F1 against the current embeddings.
 *
 * Usage:
 *   node scripts/embed-compare.mjs                          # compare qwen3 vs nomic
 *   node scripts/embed-compare.mjs --model mxbai-embed-large # test specific model
 *   node scripts/embed-compare.mjs --full                    # embed ALL items, not just GT
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

const NEW_MODEL = process.argv.find(a => a.startsWith("--model="))?.split("=")[1]
  || (process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : null)
  || "qwen3-embedding:4b";
const EMBED_DIM = 1024; // target dimension (MRL truncation)
const FULL_MODE = process.argv.includes("--full");

// ── Load data ─────────────────────────────────────────────────

console.log("Loading data...");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

// Parse vault for collection tags
const itemMeta = new Map(); // roost_id → { text, subtitle, tags, collections }
const collectionItems = new Map(); // name → Set<id>

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
    if (!idMatch) continue;
    const id = idMatch[1];
    const titleMatch = fm.match(/^title:\s*"?(.+?)"?\s*$/m);
    const subtitleMatch = fm.match(/^subtitle:\s*"(.+?)"\s*$/m);
    const text = titleMatch?.[1] || "";
    const subtitle = subtitleMatch?.[1]?.replace(/\\"/g, '"') || "";

    const collections = [];
    const tagSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
    if (tagSection) {
      for (const line of tagSection[1].split("\n")) {
        const t = line.match(/^\s+-\s+collection\/(.+)/);
        if (t) collections.push(t[1].trim());
      }
    }
    const collMatch = fm.match(/^collection:\s*"?([^\n"]+)"?/m);
    if (collMatch) collections.push(collMatch[1].trim());

    itemMeta.set(id, { text, subtitle, collections });
    for (const c of collections) {
      if (!collectionItems.has(c)) collectionItems.set(c, new Set());
      collectionItems.get(c).add(id);
    }
  }
}
walkVault(path.join(VAULT_PATH, "Bookmarks"));

// Determine which items to re-embed
let targetIds;
if (FULL_MODE) {
  targetIds = Object.keys(cache).filter(id => cache[id]?.vec);
} else {
  // Only ground truth items (have collection tags)
  const gtIds = new Set();
  for (const ids of collectionItems.values()) for (const id of ids) gtIds.add(id);
  targetIds = [...gtIds].filter(id => cache[id]?.vec);
}

console.log(`Target: ${targetIds.length} items (${FULL_MODE ? "all" : "ground truth only"})`);
console.log(`Model: ${NEW_MODEL} → ${EMBED_DIM}d`);
console.log(`Ground truth: ${collectionItems.size} collections\n`);

// ── Embed with new model ──────────────────────────────────────

async function embedText(text, model) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const vec = data.embeddings?.[0];
  if (!vec) return null;
  // MRL truncation to target dim
  return vec.slice(0, EMBED_DIM);
}

console.log(`Embedding ${targetIds.length} items with ${NEW_MODEL}...`);
const newVecs = new Map(); // id → vector
const CONCURRENCY = 3;
let done = 0, errors = 0;
const startTime = Date.now();

for (let i = 0; i < targetIds.length; i += CONCURRENCY) {
  const batch = targetIds.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(batch.map(async (id) => {
    const entry = cache[id];
    const meta = itemMeta.get(id);
    const parts = [entry?.summary, entry?.category, meta?.text, meta?.subtitle].filter(Boolean);
    const embedText_ = parts.join(" ").slice(0, 2000);
    if (embedText_.length <= 10) return null;
    const vec = await embedText(embedText_, NEW_MODEL);
    if (vec) newVecs.set(id, vec);
    return vec;
  }));
  for (const r of results) {
    if (r.status === "rejected") errors++;
  }
  done += batch.length;
  if (done % 100 < CONCURRENCY || done >= targetIds.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (done / (Date.now() - startTime) * 1000).toFixed(1);
    const eta = ((targetIds.length - done) / rate / 60).toFixed(0);
    process.stdout.write(`\r  ${done}/${targetIds.length} (${errors} errors, ${elapsed}s, ~${eta}min left)`);
  }
}
console.log(`\n  Done: ${newVecs.size} embedded, ${errors} errors\n`);

// ── Run clustering on both models ─────────────────────────────

function runPython(params) {
  const inputPath = path.join(os.tmpdir(), `roost-cmp-${crypto.randomUUID()}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(params));
  try {
    const stdout = execFileSync(PYTHON, [CLUSTER_SCRIPT, "--input", inputPath], {
      encoding: "utf8", timeout: 300000, maxBuffer: 1024 * 1024 * 500,
    });
    return JSON.parse(stdout);
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
  }
}

function computeF1(labels, ids) {
  const clusters = new Map();
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === -1) continue;
    if (!clusters.has(labels[i])) clusters.set(labels[i], []);
    clusters.get(labels[i]).push(ids[i]);
  }
  const noise = labels.filter(l => l === -1).length;

  let f1Sum = 0, collCount = 0;
  const perColl = {};
  for (const [collName, collIds] of collectionItems) {
    if (collIds.size < 3) continue;
    let bestF1 = 0, bestCluster = -1;
    for (const [label, clusterIds] of clusters) {
      const clusterSet = new Set(clusterIds);
      const overlap = [...collIds].filter(id => clusterSet.has(id)).length;
      if (overlap === 0) continue;
      const p = overlap / clusterIds.length;
      const r = overlap / collIds.size;
      const f1 = 2 * p * r / (p + r);
      if (f1 > bestF1) { bestF1 = f1; bestCluster = label; }
    }
    perColl[collName] = { f1: bestF1, n: collIds.size, cluster: bestCluster };
    f1Sum += bestF1;
    collCount++;
  }
  return {
    macroF1: collCount > 0 ? f1Sum / collCount : 0,
    clusters: clusters.size,
    noise,
    noiseRate: noise / labels.length,
    perColl,
  };
}

const MCS = [10, 15, 20];
const EVAL_MCS = 15; // which mcs to run LLM evaluation on
const EVAL_MODEL = "gemma4:e4b";
const EVAL_BATCH_SIZE = 30;

// ── Cluster naming (c-TF-IDF) ────────────────────────────────

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did",
  "will","would","could","should","may","might","shall","can","need","dare","ought",
  "this","that","these","those","and","but","or","nor","not","for","with","about","against",
  "between","through","during","before","after","above","below","from","into","out","off",
  "over","under","again","further","then","once","here","there","when","where","why","how",
  "all","both","each","few","more","most","other","some","such","only","own","same","than",
  "too","very","just","also","now","its","his","her","their","our","your","what","which",
  "who","whom","while","she","him","they","them","you","many","first","take","come","made","going",
  "thing","things","well","back","still","even","give","want","because","any","been","having",
  "image","video","post","shows","features","social","media","person","people","using","text",
  "wearing","standing","sitting","holding","near","white","black","large","small","inside",
  "subject","showcases","captures","depicts","describes","discusses","highlights","presents",
  "young","woman","man","user","creator","someone","individual","setting","foreground",
  "appears","shown","seen","life","personal","another","something","visible","overlay",
]);

function nameCluster(memberIds, embCache, allItemIDF, totalItems) {
  // Category consensus
  const catCounts = new Map();
  for (const id of memberIds) {
    const cat = embCache[id]?.category;
    if (cat) catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  }
  if (catCounts.size > 0) {
    const [topCat, topCount] = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= memberIds.length * 0.4) {
      return topCat.charAt(0).toUpperCase() + topCat.slice(1);
    }
  }
  // TF-IDF fallback
  const tf = new Map();
  for (const id of memberIds) {
    const entry = embCache[id];
    if (entry?.category) {
      const cat = entry.category.toLowerCase().replace(/[^a-z]/g, "");
      if (cat.length >= 3 && !STOPWORDS.has(cat)) tf.set(cat, (tf.get(cat) || 0) + 3);
    }
    if (entry?.summary) {
      for (const w of entry.summary.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)) {
        if (w.length >= 4 && !STOPWORDS.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
      }
    }
  }
  const totalTerms = [...tf.values()].reduce((a, b) => a + b, 0) || 1;
  let best = "Unnamed", bestScore = -1;
  for (const [term, count] of tf) {
    const idf = Math.log(1 + totalItems / (allItemIDF.get(term) || 1));
    const score = (count / totalTerms) * idf;
    if (score > bestScore) { bestScore = score; best = term.charAt(0).toUpperCase() + term.slice(1); }
  }
  return best;
}

function buildIDF(ids, embCache) {
  const idf = new Map();
  for (const id of ids) {
    const entry = embCache[id];
    const seen = new Set();
    if (entry?.category) {
      const cat = entry.category.toLowerCase().replace(/[^a-z]/g, "");
      if (cat.length >= 3) seen.add(cat);
    }
    if (entry?.summary) {
      for (const w of entry.summary.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)) {
        if (w.length >= 4 && !STOPWORDS.has(w)) seen.add(w);
      }
    }
    for (const t of seen) idf.set(t, (idf.get(t) || 0) + 1);
  }
  return idf;
}

// ── LLM evaluation ────────────────────────────────────────────

async function evaluateClusters(labels, ids, embCache, modelLabel) {
  // Group by cluster
  const clusters = new Map();
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === -1) continue;
    if (!clusters.has(labels[i])) clusters.set(labels[i], []);
    clusters.get(labels[i]).push(ids[i]);
  }

  // Name clusters
  const idf = buildIDF(ids, embCache);
  const clusterNames = new Map();
  for (const [label, memberIds] of clusters) {
    clusterNames.set(label, nameCluster(memberIds, embCache, idf, ids.length));
  }

  // Build category list
  const categoryList = [];
  const labelToIdx = new Map();
  for (const [label, name] of clusterNames) {
    labelToIdx.set(label, categoryList.length);
    categoryList.push(name);
  }
  const categoryText = categoryList.map((name, i) => `${i + 1}. ${name}`).join("\n");

  // Build all items with their assigned cluster
  const allItems = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === -1) continue;
    const entry = embCache[ids[i]];
    const summary = (entry?.summary || entry?.vision?.slice(0, 100) || ids[i]).slice(0, 120);
    allItems.push({ id: ids[i], summary, assignedIdx: labelToIdx.get(labels[i]) });
  }

  console.log(`  [${modelLabel}] Evaluating ${allItems.length} items against ${categoryList.length} categories...`);

  let confirmed = 0, reassigned = 0, misc = 0, evalErrors = 0;
  const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  for (let bi = 0; bi < allItems.length; bi += EVAL_BATCH_SIZE) {
    const batch = allItems.slice(bi, bi + EVAL_BATCH_SIZE);
    const labels_ = batch.map((_, i) => i < 26 ? LABELS[i] : `A${LABELS[i - 26]}`);
    const itemLines = batch.map((item, i) => `${labels_[i]}. ${item.summary}`).join("\n");

    const prompt = `Categories:\n${categoryText}\n\nFor each item, pick the BEST fitting category number (1-${categoryList.length}), or NONE if it doesn't clearly fit any category.\n\nItems:\n${itemLines}\n\nRespond with ONLY the letter and number (or NONE), one per line:\n${labels_[0]}: 3\n${labels_[1]}: NONE\n(etc.)`;

    try {
      const res = await fetch(`${OLLAMA}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
      });
      const data = await res.json();
      const raw = (data.response || "").trim();

      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*([A-Z]{1,2})\b.*?\b(\d+|NONE)\s*$/i);
        if (!match) continue;
        const label = match[1].toUpperCase();
        const labelIdx = labels_.indexOf(label);
        if (labelIdx < 0 || labelIdx >= batch.length) continue;

        if (match[2].toUpperCase() !== "NONE") {
          const catNum = parseInt(match[2], 10) - 1;
          if (catNum === batch[labelIdx].assignedIdx) confirmed++;
          else reassigned++;
        } else {
          misc++;
        }
      }
    } catch {
      evalErrors++;
    }

    if ((bi + EVAL_BATCH_SIZE) % 300 < EVAL_BATCH_SIZE) {
      const done = Math.min(bi + EVAL_BATCH_SIZE, allItems.length);
      process.stdout.write(`\r  [${modelLabel}] ${done}/${allItems.length}`);
    }
  }
  console.log();

  const total = confirmed + reassigned + misc;
  return {
    confirmed, reassigned, misc,
    confirmRate: total > 0 ? confirmed / total : 0,
    reassignRate: total > 0 ? reassigned / total : 0,
    miscRate: total > 0 ? misc / total : 0,
    clusters: clusters.size,
    noise: labels.filter(l => l === -1).length,
  };
}

// Baseline: current embeddings (nomic-embed-text)
console.log("Running baseline (nomic-embed-text, 768d)...");
const baseIds = targetIds.filter(id => cache[id]?.vec);
const baseVecs = baseIds.map(id => cache[id].vec);
const baseResult = runPython({ ids: baseIds, vectors: baseVecs, min_cluster_sizes: MCS });

// New model
console.log(`Running ${NEW_MODEL} (${EMBED_DIM}d)...`);
const newIds = [...newVecs.keys()];
const newVecArray = newIds.map(id => newVecs.get(id));
const newResult = runPython({ ids: newIds, vectors: newVecArray, min_cluster_sizes: MCS });

// ── Compare ───────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log(`\n  ${"Config".padEnd(35)} ${"mcs".padStart(4)} ${"F1".padStart(7)} ${"Clusters".padStart(9)} ${"Noise".padStart(7)}`);
console.log("  " + "-".repeat(66));

for (const mcs of MCS) {
  const baseLabels = baseResult.batch[String(mcs)];
  const newLabels = newResult.batch[String(mcs)];

  const baseMetrics = computeF1(baseLabels, baseIds);
  const newMetrics = computeF1(newLabels, newIds);

  const delta = newMetrics.macroF1 - baseMetrics.macroF1;
  const arrow = delta > 0.005 ? " ✓" : delta < -0.005 ? " ✗" : "";

  console.log(`  ${"nomic-embed-text (768d)".padEnd(35)} ${String(mcs).padStart(4)} ${baseMetrics.macroF1.toFixed(4).padStart(7)} ${String(baseMetrics.clusters).padStart(9)} ${(baseMetrics.noiseRate * 100).toFixed(1).padStart(6)}%`);
  console.log(`  ${(NEW_MODEL + ` (${EMBED_DIM}d)`).padEnd(35)} ${String(mcs).padStart(4)} ${newMetrics.macroF1.toFixed(4).padStart(7)} ${String(newMetrics.clusters).padStart(9)} ${(newMetrics.noiseRate * 100).toFixed(1).padStart(6)}%  Δ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}${arrow}`);
  console.log();

  // Show per-collection comparison at EVAL_MCS
  if (mcs === EVAL_MCS) {
    console.log("  Per-collection F1 (mcs=15):");
    const allColls = [...new Set([...Object.keys(baseMetrics.perColl), ...Object.keys(newMetrics.perColl)])];
    allColls.sort((a, b) => (newMetrics.perColl[b]?.f1 || 0) - (newMetrics.perColl[a]?.f1 || 0));
    for (const coll of allColls.slice(0, 20)) {
      const b = baseMetrics.perColl[coll];
      const n = newMetrics.perColl[coll];
      if (!b && !n) continue;
      const bf1 = b?.f1?.toFixed(3) || "  -  ";
      const nf1 = n?.f1?.toFixed(3) || "  -  ";
      const d = (n?.f1 || 0) - (b?.f1 || 0);
      const arr = d > 0.01 ? "↑" : d < -0.01 ? "↓" : "=";
      console.log(`    ${coll.padEnd(20)} ${bf1} → ${nf1}  ${arr}  (${b?.n || n?.n || 0} items)`);
    }
    console.log();
  }
}

// ── LLM Evaluation at EVAL_MCS ────────────────────────────────

console.log("=".repeat(70));
console.log(`\nLLM Evaluation (mcs=${EVAL_MCS}) — does the LLM agree with cluster assignments?\n`);

const baseLabelsEval = baseResult.batch[String(EVAL_MCS)];
const newLabelsEval = newResult.batch[String(EVAL_MCS)];

const baseEval = await evaluateClusters(baseLabelsEval, baseIds, cache, "nomic");

// For qwen3, build a temporary cache overlay with the new topics from the original cache
// (topics were generated from nomic embeddings but the text content is the same)
const newEval = await evaluateClusters(newLabelsEval, newIds, cache, "qwen3");

console.log(`\n  ${"Metric".padEnd(25)} ${"nomic".padStart(10)} ${"qwen3".padStart(10)} ${"Delta".padStart(10)}`);
console.log("  " + "-".repeat(58));

function fmtPct(v) { return (v * 100).toFixed(1) + "%"; }
function fmtDelta(a, b) {
  const d = b - a;
  const arrow = d > 0.005 ? " ✓" : d < -0.005 ? " ✗" : "";
  return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%${arrow}`;
}

console.log(`  ${"LLM Confirmed".padEnd(25)} ${fmtPct(baseEval.confirmRate).padStart(10)} ${fmtPct(newEval.confirmRate).padStart(10)} ${fmtDelta(baseEval.confirmRate, newEval.confirmRate).padStart(10)}`);
console.log(`  ${"LLM Reassigned".padEnd(25)} ${fmtPct(baseEval.reassignRate).padStart(10)} ${fmtPct(newEval.reassignRate).padStart(10)} ${fmtDelta(baseEval.reassignRate, newEval.reassignRate).padStart(10)}`);
console.log(`  ${"LLM Misc (no fit)".padEnd(25)} ${fmtPct(baseEval.miscRate).padStart(10)} ${fmtPct(newEval.miscRate).padStart(10)} ${fmtDelta(baseEval.miscRate, newEval.miscRate).padStart(10)}`);
console.log(`  ${"Noise (unassigned)".padEnd(25)} ${String(baseEval.noise).padStart(10)} ${String(newEval.noise).padStart(10)}`);
console.log(`  ${"Clusters".padEnd(25)} ${String(baseEval.clusters).padStart(10)} ${String(newEval.clusters).padStart(10)}`);

console.log(`\n  Raw counts:`);
console.log(`  nomic:  ${baseEval.confirmed} confirmed, ${baseEval.reassigned} reassigned, ${baseEval.misc} misc`);
console.log(`  qwen3:  ${newEval.confirmed} confirmed, ${newEval.reassigned} reassigned, ${newEval.misc} misc`);
