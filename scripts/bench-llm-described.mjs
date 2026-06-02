#!/usr/bin/env node
/**
 * LLM baseline with auto-described categories.
 * Step 1: For each user collection, show Gemma 4 sample items and ask for a description.
 * Step 2: Use name + description for classification.
 *
 * Usage: node scripts/bench-llm-described.mjs
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");
const LLM_CACHE_PATH = path.join(VAULT_PATH, ".roost", "llm-eval-cache.json");
const DESC_CACHE_PATH = path.join(VAULT_PATH, ".roost", "collection-descriptions.json");
const OLLAMA = "http://localhost:11434";
const EVAL_MODEL = "gemma4:e4b";
const BATCH_SIZE = 25;

// ── Caching ───────────────────────────────────────────────────

let llmCache = {};
try { llmCache = JSON.parse(fs.readFileSync(LLM_CACHE_PATH, "utf8")); } catch {}
let cacheHits = 0, cacheMisses = 0;
function saveLlmCache() { fs.writeFileSync(LLM_CACHE_PATH, JSON.stringify(llmCache)); }

let descCache = {};
try { descCache = JSON.parse(fs.readFileSync(DESC_CACHE_PATH, "utf8")); } catch {}

// ── Load data ─────────────────────────────────────────────────

console.log("Loading data...");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

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

// ── Step 1: Generate descriptions for each collection ─────────

console.log("Step 1: Generating collection descriptions...\n");

const descriptions = {};

for (const name of categoryNames) {
  // Check description cache
  if (descCache[name]) {
    descriptions[name] = descCache[name];
    continue;
  }

  const ids = [...collectionItems.get(name)];
  // Sample up to 10 items
  const sampleIds = ids.sort(() => Math.random() - 0.5).slice(0, 10);
  const sampleTopics = sampleIds.map(id => itemSummaries.get(id)).filter(Boolean);

  const prompt = `A user has a bookmark collection called "${name}" containing ${ids.length} items. Here are some examples:\n\n${sampleTopics.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nWrite a one-sentence description of what this collection contains. Be specific about the theme and content types. Just the description, nothing else.`;

  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
    });
    const raw = (await res.json()).response?.trim() || "";
    descriptions[name] = raw.split("\n")[0].slice(0, 200);
    descCache[name] = descriptions[name];
    console.log(`  ${name}: ${descriptions[name]}`);
  } catch (e) {
    descriptions[name] = name;
    console.log(`  ${name}: (failed, using name)`);
  }
}

// Save description cache
fs.writeFileSync(DESC_CACHE_PATH, JSON.stringify(descCache, null, 2));
console.log(`\nDescriptions cached to ${DESC_CACHE_PATH}\n`);

// ── Step 2: Classify items using name + description ───────────

console.log("Step 2: Classifying items...\n");

// Build rich category list
const catLines = categoryNames.map((name, i) =>
  `${i + 1}. ${name}: ${descriptions[name] || name}`
);
const catList = catLines.join("\n");
const catHash = crypto.createHash("md5").update(catList).digest("hex").slice(0, 12);

const catListWithMisc = catList + `\n${categoryNames.length + 1}. Misc: Doesn't fit any of the above categories`;

const verdicts = new Map();

// Check cache
const uncachedIds = [];
for (const id of allIds) {
  const key = `${id}|${catHash}`;
  if (llmCache[key] !== undefined) {
    verdicts.set(id, llmCache[key]);
    cacheHits++;
  } else {
    uncachedIds.push(id);
  }
}
if (cacheHits > 0) console.log(`Cache: ${cacheHits} hits, ${uncachedIds.length} to evaluate\n`);

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const startTime = Date.now();

for (let bi = 0; bi < uncachedIds.length; bi += BATCH_SIZE) {
  const batch = uncachedIds.slice(bi, bi + BATCH_SIZE);
  const labels = batch.map((_, i) => i < 26 ? LABELS[i] : `A${LABELS[i - 26]}`);
  const itemLines = batch.map((id, i) => `${labels[i]}. ${itemSummaries.get(id)}`).join("\n");

  const prompt = `Categories:\n${catListWithMisc}\n\nFor each item, pick the BEST fitting category number (1-${categoryNames.length + 1}).\n\nItems:\n${itemLines}\n\nRespond with ONLY the letter and number, one per line:`;

  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
    });
    const raw = (await res.json()).response?.trim() || "";

    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z]{1,2})\s*[.:)\-]\s*(\d+)\s*$/i);
      if (!match) continue;
      const idx = labels.indexOf(match[1].toUpperCase());
      if (idx < 0 || idx >= batch.length) continue;
      const catNum = parseInt(match[2], 10) - 1;
      const verdict = catNum >= categoryNames.length ? -1 : catNum;
      verdicts.set(batch[idx], verdict);
      llmCache[`${batch[idx]}|${catHash}`] = verdict;
      cacheMisses++;
    }
  } catch {}

  if ((bi + BATCH_SIZE) % 100 < BATCH_SIZE || bi + BATCH_SIZE >= uncachedIds.length) {
    const done = Math.min(bi + BATCH_SIZE, uncachedIds.length);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  ${done}/${uncachedIds.length} (${elapsed}s)`);
    saveLlmCache();
  }
}
saveLlmCache();

// ── Compute metrics ──────────────────────────────────────────

let correct = 0, wrong = 0, misc = 0, noVerdict = 0;
const perCollection = {};

// Also track: where do wrong items go?
const confusionCounts = new Map(); // "actual→predicted" → count

for (const [collName, collIds] of collectionItems) {
  let collCorrect = 0, collWrong = 0, collMisc = 0, collNoVerdict = 0;
  const collIdx = categoryNames.indexOf(collName);

  for (const id of collIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined) { noVerdict++; collNoVerdict++; }
    else if (verdict === -1) { misc++; collMisc++; }
    else if (verdict === collIdx) { correct++; collCorrect++; }
    else {
      wrong++; collWrong++;
      const predicted = categoryNames[verdict] || "???";
      const key = `${collName}→${predicted}`;
      confusionCounts.set(key, (confusionCounts.get(key) || 0) + 1);
    }
  }

  perCollection[collName] = {
    correct: collCorrect, wrong: collWrong, misc: collMisc,
    noVerdict: collNoVerdict, total: collIds.size,
    accuracy: collIds.size > 0 ? collCorrect / collIds.size : 0,
  };
}

// ── Results ──────────────────────────────────────────────────

const totalEvaluated = correct + wrong + misc;
console.log("\n" + "=".repeat(60));
console.log("\nLLM Baseline with Described Categories (Gemma 4)\n");
console.log(`  Correct:     ${correct} (${(correct / totalEvaluated * 100).toFixed(1)}%)`);
console.log(`  Wrong:       ${wrong} (${(wrong / totalEvaluated * 100).toFixed(1)}%)`);
console.log(`  Misc:        ${misc} (${(misc / totalEvaluated * 100).toFixed(1)}%)`);
console.log(`  No verdict:  ${noVerdict}`);

const accuracy = correct / (correct + wrong) || 0;
console.log(`\n  Accuracy (excl misc): ${(accuracy * 100).toFixed(1)}%`);
console.log(`  Overall accuracy:     ${(correct / totalEvaluated * 100).toFixed(1)}%`);

console.log(`\nPer-collection:`);
const sorted = Object.entries(perCollection).sort((a, b) => b[1].accuracy - a[1].accuracy);
console.log(`  ${"Collection".padEnd(22)} ${"Acc".padStart(6)} ${"Correct".padStart(8)} ${"Wrong".padStart(6)} ${"Misc".padStart(5)} ${"Total".padStart(6)}`);
console.log("  " + "-".repeat(56));
for (const [name, m] of sorted) {
  console.log(`  ${name.padEnd(22)} ${(m.accuracy * 100).toFixed(0).padStart(5)}% ${String(m.correct).padStart(8)} ${String(m.wrong).padStart(6)} ${String(m.misc).padStart(5)} ${String(m.total).padStart(6)}`);
}

// Top confusions
console.log(`\nTop confusions (actual → predicted):`);
const topConfusions = [...confusionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [key, count] of topConfusions) {
  console.log(`  ${count.toString().padStart(4)}  ${key}`);
}

// F1 for comparison
const assignments = new Map();
for (const [id, verdict] of verdicts) {
  if (verdict >= 0) assignments.set(id, verdict);
}
let f1Sum = 0, f1n = 0;
for (const [collName, collIds] of collectionItems) {
  if (collIds.size < 3) continue;
  const collIdx = categoryNames.indexOf(collName);
  const clusterIds = [...assignments.entries()].filter(([, v]) => v === collIdx).map(([id]) => id);
  if (clusterIds.length === 0) { f1n++; continue; }
  const cs = new Set(clusterIds);
  const overlap = [...collIds].filter(id => cs.has(id)).length;
  const p = overlap / clusterIds.length;
  const r = overlap / collIds.size;
  const f1 = p + r > 0 ? 2 * p * r / (p + r) : 0;
  f1Sum += f1;
  f1n++;
}
console.log(`\n  Collection Recovery F1: ${(f1Sum / f1n).toFixed(4)}`);
console.log(`\n  (Compare: Strategy A=0.255, B=0.347, C=0.330)`);
console.log(`\nCache: ${cacheHits} hits, ${cacheMisses} misses`);
