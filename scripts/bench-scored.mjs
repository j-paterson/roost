#!/usr/bin/env node
/**
 * Scored classification: for each item, find top 5 candidate categories
 * by embedding centroid distance, then ask Gemma 4 to score the item
 * against each candidate (1-5). Assign to highest score or Misc.
 *
 * Usage: node scripts/bench-scored.mjs
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");
const LLM_CACHE_PATH = path.join(VAULT_PATH, ".roost", "llm-scored-cache.json");
const DESC_CACHE_PATH = path.join(VAULT_PATH, ".roost", "collection-descriptions-contrastive.json");
const OLLAMA = "http://localhost:11434";
const EVAL_MODEL = "gemma4:e4b";
const TOP_K = 5; // candidate categories per item
const FIT_THRESHOLD = 3; // score >= this to assign, below = Misc
const BATCH_SIZE = 20; // items per LLM call

// ── Caching ───────────────────────────────────────────────────

let llmCache = {};
try { llmCache = JSON.parse(fs.readFileSync(LLM_CACHE_PATH, "utf8")); } catch {}
let cacheHits = 0, cacheMisses = 0;
function saveLlmCache() { fs.writeFileSync(LLM_CACHE_PATH, JSON.stringify(llmCache)); }

// ── Load data ─────────────────────────────────────────────────

console.log("Loading data...");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

let descCache = {};
try { descCache = JSON.parse(fs.readFileSync(DESC_CACHE_PATH, "utf8")); } catch {
  console.log("No contrastive descriptions found. Run bench-llm-contrastive.mjs first.");
  process.exit(1);
}

const collectionItems = new Map();
const itemSummaries = new Map();

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
    const collections = [];
    const tagSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
    if (tagSection) for (const line of tagSection[1].split("\n")) {
      const t = line.match(/^\s+-\s+collection\/(.+)/);
      if (t) collections.push(t[1].trim());
    }
    const cm = fm.match(/^collection:\s*"?([^\n"]+)"?/m);
    if (cm) collections.push(cm[1].trim());
    if (collections.length > 0) {
      for (const c of collections) {
        if (!collectionItems.has(c)) collectionItems.set(c, new Set());
        collectionItems.get(c).add(id);
      }
      const e = cache[id];
      itemSummaries.set(id, (e?.summary || e?.vision?.slice(0, 100) || id).slice(0, 120));
    }
  }
}
walkVault(path.join(VAULT_PATH, "Bookmarks"));

const allIds = [...itemSummaries.keys()];
const categoryNames = [...collectionItems.keys()].sort((a, b) =>
  (collectionItems.get(b)?.size || 0) - (collectionItems.get(a)?.size || 0)
);
console.log(`${allIds.length} items, ${categoryNames.length} collections\n`);

// ── Compute category centroids ────────────────────────────────

console.log("Computing category centroids...");
const centroids = new Map();
for (const [name, ids] of collectionItems) {
  const vecs = [...ids].filter(id => cache[id]?.vec).map(id => cache[id].vec);
  if (vecs.length === 0) continue;
  const dim = vecs[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vecs) for (let d = 0; d < dim; d++) avg[d] += v[d];
  for (let d = 0; d < dim; d++) avg[d] /= vecs.length;
  centroids.set(name, avg);
}

function cosSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── For each item, find top K candidate categories ────────────

console.log(`Finding top ${TOP_K} candidates per item...\n`);

const itemCandidates = new Map(); // id → [{ name, desc }]
for (const id of allIds) {
  const vec = cache[id]?.vec;
  if (!vec) continue;
  const sims = categoryNames
    .filter(n => centroids.has(n))
    .map(n => ({ name: n, sim: cosSim(vec, centroids.get(n)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K);
  itemCandidates.set(id, sims.map(s => s.name));
}

// ── Score items against their candidates ──────────────────────

console.log("Scoring items against candidates...\n");

const verdicts = new Map(); // id → { category, score } or null (Misc)
const startTime = Date.now();

// Process items one at a time — each item gets one LLM call with its 5 candidates
let processed = 0, fromCache = 0;

for (const id of allIds) {
  const candidates = itemCandidates.get(id);
  if (!candidates) continue;
  const summary = itemSummaries.get(id);
  const cacheKey = `${id}|${candidates.join(",")}`;

  // Check cache
  if (llmCache[cacheKey] !== undefined) {
    verdicts.set(id, llmCache[cacheKey]);
    fromCache++;
    processed++;
    continue;
  }

  // Build scoring prompt — just 5 categories, very focused
  const catLines = candidates.map((name, i) => {
    const desc = descCache[name] || name;
    const short = desc.split(/[.!]\s/)[0].slice(0, 100);
    return `${i + 1}. ${name}: ${short}`;
  }).join("\n");

  const prompt = `Rate how well this item fits each category (1-5 where 1=poor fit, 5=perfect fit).

Item: ${summary}

Categories:
${catLines}

Respond with ONLY the number and score, one per line:
1: 4
2: 2
(etc.)`;

  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
    });
    const raw = (await res.json()).response?.trim() || "";

    let bestCat = null, bestScore = 0;
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*(\d+)\b.*?\b([1-5])\s*$/);
      if (!match) continue;
      const catIdx = parseInt(match[1], 10) - 1;
      const score = parseInt(match[2], 10);
      if (catIdx >= 0 && catIdx < candidates.length && score > bestScore) {
        bestScore = score;
        bestCat = candidates[catIdx];
      }
    }

    const verdict = bestScore >= FIT_THRESHOLD ? { category: bestCat, score: bestScore } : null;
    verdicts.set(id, verdict);
    llmCache[cacheKey] = verdict;
    cacheMisses++;
  } catch {
    verdicts.set(id, null);
  }

  processed++;
  if (processed % 50 === 0 || processed === allIds.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  ${processed}/${allIds.length} (${fromCache} cached, ${elapsed}s)`);
    saveLlmCache();
  }
}
saveLlmCache();

// ── Compute metrics ──────────────────────────────────────────

const ACCEPTABLE = new Set([
  "Places|Want to go", "Want to go|Places",
  "Relationships|Rizz", "Rizz|Relationships",
  "Quotes|Kaizen", "Kaizen|Quotes",
  "Recipes|Drinks", "Drinks|Recipes",
]);

let strict_correct = 0, strict_wrong = 0;
let relaxed_correct = 0, relaxed_wrong = 0;
let misc = 0, noVerdict = 0;
const perCollection = {};
const confusions = new Map();

for (const [collName, collIds] of collectionItems) {
  let cc = 0, cw = 0, cm = 0, nv = 0;
  for (const id of collIds) {
    const v = verdicts.get(id);
    if (v === undefined) { nv++; noVerdict++; continue; }
    if (v === null) { cm++; misc++; continue; }
    if (v.category === collName) {
      cc++; strict_correct++; relaxed_correct++;
    } else if (ACCEPTABLE.has(`${collName}|${v.category}`)) {
      cw++; strict_wrong++; relaxed_correct++;
    } else {
      cw++; strict_wrong++; relaxed_wrong++;
      confusions.set(`${collName}→${v.category}`, (confusions.get(`${collName}→${v.category}`) || 0) + 1);
    }
  }
  const total = cc + cw + cm;
  perCollection[collName] = { correct: cc, wrong: cw, misc: cm, total: collIds.size, evaluated: total, acc: total > 0 ? cc / total : 0 };
}

const evaluated = strict_correct + strict_wrong + misc;
console.log("\n" + "=".repeat(60));
console.log("\nScored Classification (top-5 candidates × Gemma 4 scoring)\n");
console.log(`  Strict correct:  ${strict_correct} (${(strict_correct / evaluated * 100).toFixed(1)}%)`);
console.log(`  Relaxed correct: ${relaxed_correct} (${(relaxed_correct / evaluated * 100).toFixed(1)}%)`);
console.log(`  Wrong (relaxed): ${relaxed_wrong} (${(relaxed_wrong / evaluated * 100).toFixed(1)}%)`);
console.log(`  Misc:            ${misc} (${(misc / evaluated * 100).toFixed(1)}%)`);
console.log(`  No verdict:      ${noVerdict}`);

console.log(`\nPer-collection:`);
const sorted = Object.entries(perCollection).sort((a, b) => b[1].acc - a[1].acc);
console.log(`  ${"Collection".padEnd(22)} ${"Acc".padStart(6)} ${"Right".padStart(6)} ${"Wrong".padStart(6)} ${"Misc".padStart(5)} ${"Eval".padStart(5)} ${"Total".padStart(6)}`);
console.log("  " + "-".repeat(58));
for (const [name, m] of sorted) {
  if (m.evaluated === 0) continue;
  console.log(`  ${name.padEnd(22)} ${(m.acc * 100).toFixed(0).padStart(5)}% ${String(m.correct).padStart(6)} ${String(m.wrong).padStart(6)} ${String(m.misc).padStart(5)} ${String(m.evaluated).padStart(5)} ${String(m.total).padStart(6)}`);
}

console.log(`\nTop confusions:`);
const topConf = [...confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [key, count] of topConf) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}

// F1
const assignments = new Map();
for (const [id, v] of verdicts) {
  if (v) assignments.set(id, categoryNames.indexOf(v.category));
}
let f1Sum = 0, f1n = 0;
for (const [collName, collIds] of collectionItems) {
  if (collIds.size < 3) continue;
  const collIdx = categoryNames.indexOf(collName);
  const clusterIds = [...assignments.entries()].filter(([, v]) => v === collIdx).map(([id]) => id);
  if (clusterIds.length === 0) { f1n++; continue; }
  const cs = new Set(clusterIds);
  const overlap = [...collIds].filter(id => cs.has(id)).length;
  const p = overlap / clusterIds.length, r = overlap / collIds.size;
  f1Sum += p + r > 0 ? 2 * p * r / (p + r) : 0;
  f1n++;
}
console.log(`\n  Collection Recovery F1: ${(f1Sum / f1n).toFixed(4)}`);
console.log(`  (Compare: Strategy B=0.347, contrastive batch=broken)`);
console.log(`\nCache: ${fromCache} hits, ${cacheMisses} misses`);
