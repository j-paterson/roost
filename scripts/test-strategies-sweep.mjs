#!/usr/bin/env node
/**
 * Strategy parameter sweep.
 *
 * Phase 1: Run LLM calls for each prompt type, caching raw responses.
 * Phase 2: Evaluate every (strategy × parameter config) post-hoc.
 *
 * Cached responses persist in .roost/llm-response-cache.json so re-runs
 * with different thresholds are instant.
 *
 * Usage:
 *   node scripts/test-strategies-sweep.mjs [testSize] [--fast]
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const OLLAMA_URL = "http://localhost:11434";
const FAST_MODEL = "llama3.2:3b";
const BIG_MODEL = "gemma4:e4b";
const MAX_TOP_K = 7;
const SEED = 42;

const TEST_SIZE = parseInt(process.argv[2] || "200");
const NEGATIVE_RATIO = 0.25;  // fraction of test items that are unsorted (no collection)
const FAST_ONLY = process.argv.includes("--fast");
const CACHE_ARG = process.argv.find(a => a.startsWith("--cache="));
const CACHE_FILE = CACHE_ARG ? CACHE_ARG.split("=")[1] : "embedding-cache.json";

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

// ── Load data ──

console.log("Loading data...");
console.log(`  Cache file: ${CACHE_FILE}`);
const cache = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, CACHE_FILE), "utf8"));
const contrastiveDescs = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "collection-descriptions-contrastive.json"), "utf8"));
let notDescsRaw = {};
for (const variant of ["collection-not-descriptions.json", "collection-not-descriptions-llama3-2-3b.json"]) {
  try { notDescsRaw = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, variant), "utf8")); console.log(`  NOT descriptions: ${variant}`); break; } catch {}
}
const notDescs = new Map(Object.entries(notDescsRaw));
function flattenNot(notObj) {
  if (typeof notObj === "string") return notObj;
  if (typeof notObj === "object" && notObj) return Object.values(notObj).join("; ");
  return "";
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
  const desc = contrastiveDescs[name] || name;
  const notDesc = notDescs.get(name) || "";
  const notFlat = flattenNot(notDesc);
  categoryDefs.push({ name, centroid: computeCentroid(vecs), vecCount: vecs.length, description: desc, notDescription: notFlat, notPerNeighbor: typeof notDesc === "object" ? notDesc : null, memberIds: ids });
}
console.log(`  ${categoryDefs.length} collections with centroids`);

// Pre-compute per-collection member similarity percentiles (Phase 2 strategy I)
// Uses leave-one-out centroids: for each member, subtract its own contribution
// before computing similarity, matching what the evaluation does for test items.
const collectionThresholds = new Map();
for (const cat of categoryDefs) {
  const memberVecs = cat.memberIds.filter(id => cache[id]?.vec).map(id => cache[id].vec);
  const n = memberVecs.length;
  if (n < 2) continue;
  const memberSims = memberVecs
    .map(vec => {
      const looCentroid = cat.centroid.map((c, i) => (c * n - vec[i]) / (n - 1));
      return cosineSim(vec, looCentroid);
    })
    .sort((a, b) => a - b);
  const pct = (p) => memberSims[Math.floor(p * memberSims.length / 100)] || 0;
  collectionThresholds.set(cat.name, { p5: pct(5), p10: pct(10), p20: pct(20), p30: pct(30), count: n });
}

// ── Pick test items (positives + negatives) ──

const rng = mulberry32(SEED);
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Build set of all IDs that belong to a collection
const allCollectionIds = new Set();
for (const ids of collectionItems.values()) for (const id of ids) allCollectionIds.add(id);

const negativeTarget = Math.round(TEST_SIZE * NEGATIVE_RATIO);
const positiveTarget = TEST_SIZE - negativeTarget;

// Positive examples: items from known collections
const positivePool = [];
for (const [name, ids] of collectionItems) {
  const withVec = ids.filter(id => cache[id]?.vec);
  if (withVec.length < 3) continue;
  const shuffled = shuffle([...withVec]);
  const take = Math.max(1, Math.ceil(positiveTarget / categoryDefs.length));
  for (const id of shuffled.slice(0, take)) {
    positivePool.push({ id, groundTruth: name });
  }
}
const positiveEntries = shuffle(positivePool).slice(0, positiveTarget);

// Negative examples: items NOT in any collection
const negativePool = Object.keys(cache)
  .filter(id => !allCollectionIds.has(id) && cache[id]?.vec);
const negativeEntries = shuffle(negativePool).slice(0, negativeTarget)
  .map(id => ({ id, groundTruth: "No match" }));

const testEntries = shuffle([...positiveEntries, ...negativeEntries]);
const N = testEntries.length;
const nPos = positiveEntries.length;
const nNeg = negativeEntries.length;
console.log(`  Test set: ${N} items (${nPos} positive from ${new Set(positiveEntries.map(e => e.groundTruth)).size} collections, ${nNeg} negative)`);

// Pre-compute unsorted centroid (Phase 2 strategy J — exclude test negatives to avoid bias)
const testNegativeIds = new Set(negativeEntries.map(e => e.id));
const unsortedPool = Object.keys(cache)
  .filter(id => !allCollectionIds.has(id) && !testNegativeIds.has(id) && cache[id]?.vec);
const unsortedSample = shuffle([...unsortedPool]).slice(0, 2000);
const unsortedVecs = unsortedSample.map(id => cache[id].vec);
const unsortedCentroid = unsortedVecs.length > 0 ? computeCentroid(unsortedVecs) : null;
console.log(`  Unsorted centroid: ${unsortedSample.length} items sampled (${unsortedPool.length} available, test negatives excluded)`);

// Pre-compute candidates at MAX_TOP_K for each item (leave-one-out centroids)
const testItems = testEntries.map(e => {
  const entry = cache[e.id];
  const summary = stripPreamble((entry.summary || entry.vision?.slice(0, 100) || e.id)).slice(0, 120);
  const allCandidates = categoryDefs
    .map(cat => {
      let centroid = cat.centroid;
      // Leave-one-out: if this item contributed to this centroid, remove it
      if (e.groundTruth === cat.name && cat.vecCount > 1) {
        const n = cat.vecCount;
        centroid = centroid.map((c, i) => (c * n - entry.vec[i]) / (n - 1));
      }
      return { name: cat.name, sim: cosineSim(entry.vec, centroid), description: cat.description, notDescription: cat.notDescription, notPerNeighbor: cat.notPerNeighbor };
    })
    .sort((a, b) => b.sim - a.sim)
    .slice(0, MAX_TOP_K);
  const unsortedSim = unsortedCentroid ? cosineSim(entry.vec, unsortedCentroid) : 0;
  return { id: e.id, summary, allCandidates, groundTruth: e.groundTruth, unsortedSim };
});

// ═══════════════════════════════════════════════════════════════
// Phase 1: LLM calls with persistent cache
// ═══════════════════════════════════════════════════════════════

const LLM_CACHE_PATH = path.join(ROOST_DIR, "llm-response-cache.json");
let llmCache = {};
try { llmCache = JSON.parse(fs.readFileSync(LLM_CACHE_PATH, "utf8")); } catch {}
let cacheHits = 0, cacheMisses = 0;

function saveLlmCache() {
  fs.writeFileSync(LLM_CACHE_PATH, JSON.stringify(llmCache));
}

function cacheKey(model, prompt) {
  return crypto.createHash("md5").update(model + "|" + prompt).digest("hex");
}

async function llm(model, prompt) {
  const key = cacheKey(model, prompt);
  if (llmCache[key]) { cacheHits++; return llmCache[key]; }
  cacheMisses++;
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  const json = await res.json();
  const response = (json.response || "").trim();
  llmCache[key] = response;
  if (cacheMisses % 10 === 0) saveLlmCache(); // periodic save
  return response;
}

// ── Prompt builders ──

function buildBinaryPrompt(summary, candidate) {
  const short = candidate.description.split(/[.!]\s/)[0].slice(0, 100);
  const notLine = candidate.notDescription ? `\nNOT about: ${candidate.notDescription.split(/[.!]\s/)[0].slice(0, 80)}` : "";
  return `Does this item belong in the "${candidate.name}" collection?
${candidate.name}: ${short}${notLine}

Item: ${summary}

Reply YES or NO, then a brief reason.`;
}

function buildMCPrompt(summary, candidates) {
  const catLines = candidates.map((c, j) => {
    const short = c.description.split(/[.!]\s/)[0].slice(0, 100);
    let line = `${j + 1}. ${c.name}: ${short}`;
    if (c.notDescription) {
      const notShort = c.notDescription.split(/[.!]\s/)[0].slice(0, 80);
      line += `\n   NOT: ${notShort}`;
    }
    return line;
  }).join("\n");

  return `Which category best fits this item? Rate the fit 1-10 (1=poor, 10=perfect).
The item may not belong to any of these categories — only assign it if there is a genuine fit.

Item: ${summary}

Categories:
${catLines}

Reply with the category number, fit score, and a brief reason.
Example: 2 8 Strong focus on cooking techniques
If none fit well, reply: 0 0 No match`;
}

function buildTwoPassPrompt(summary, candidate) {
  const desc = candidate.description.split(/[.!]\s/)[0].slice(0, 120);
  let notLines = "";
  if (candidate.notPerNeighbor) {
    notLines = Object.entries(candidate.notPerNeighbor)
      .map(([nb, phrase]) => `- NOT "${nb}" content: ${phrase}`)
      .join("\n");
  }
  return `Does this item belong in the "${candidate.name}" collection?

"${candidate.name}": ${desc}
${notLines ? `\nThis item does NOT belong in "${candidate.name}" if it is about:\n${notLines}\n` : ""}
Item: ${summary}

Reply YES or NO, then a fit score 1-10 and a brief reason.
Example: YES 8 Clearly about cooking techniques
Example: NO 2 This is about cocktail mixing, not cooking`;
}

// ── Response parsers ──

function parseBinary(response) {
  const isYes = /^yes/i.test(response);
  return { isYes, reason: response.slice(0, 100) };
}

function parseMC(response, numCandidates) {
  const m = response.match(/^(\d+)\s+(\d+)/);
  if (!m) return { catIdx: -1, score: 0, reason: response.slice(0, 100) };
  const idx = parseInt(m[1]);
  const score = parseInt(m[2]);
  if (idx === 0 || idx > numCandidates) return { catIdx: -1, score: 0, reason: response.slice(0, 100) };
  return { catIdx: idx - 1, score, reason: response.slice(0, 100) };
}

function parseTwoPass(response) {
  const isYes = /^yes/i.test(response);
  const scoreMatch = response.match(/(?:YES|NO)\s+(\d+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : (isYes ? 7 : 0);
  return { isYes, score, reason: response.slice(0, 100) };
}

// ── Run all LLM calls ──

console.log("\nPhase 1: LLM calls...");

// Store raw responses indexed by item
const rawResponses = {
  binaryLlama: new Array(N),   // parseBinary result per item
  binaryGemma: new Array(N),
  twoPassGemma: new Array(N),  // parseTwoPass result per item
  mc: {},                       // mc[topK][itemIdx] = parseMC result
};

// 1a. Binary (llama) — all items, top-1 candidate
console.log("  Binary (llama3.2:3b) on top-1...");
const t1a = Date.now();
for (let i = 0; i < N; i++) {
  const item = testItems[i];
  const top = item.allCandidates[0];
  const prompt = buildBinaryPrompt(item.summary, top);
  const response = await llm(FAST_MODEL, prompt);
  rawResponses.binaryLlama[i] = { ...parseBinary(response), candidateName: top.name, sim: top.sim };
}
console.log(`    ${N} calls, ${((Date.now() - t1a) / 1000).toFixed(1)}s`);

// 1b. Binary (gemma) — all items, top-1 candidate
if (!FAST_ONLY) {
  console.log("  Binary (gemma4:e4b) on top-1...");
  const t1b = Date.now();
  for (let i = 0; i < N; i++) {
    const item = testItems[i];
    const top = item.allCandidates[0];
    const prompt = buildBinaryPrompt(item.summary, top);
    const response = await llm(BIG_MODEL, prompt);
    rawResponses.binaryGemma[i] = { ...parseBinary(response), candidateName: top.name, sim: top.sim };
  }
  console.log(`    ${N} calls, ${((Date.now() - t1b) / 1000).toFixed(1)}s`);
}

// 1c. Two-pass verify (gemma) — all items, top-1 candidate
if (!FAST_ONLY) {
  console.log("  Two-pass verify (gemma4:e4b) on top-1...");
  const t1c = Date.now();
  for (let i = 0; i < N; i++) {
    const item = testItems[i];
    const top = item.allCandidates[0];
    const prompt = buildTwoPassPrompt(item.summary, top);
    const response = await llm(BIG_MODEL, prompt);
    rawResponses.twoPassGemma[i] = { ...parseTwoPass(response), candidateName: top.name, sim: top.sim };
  }
  console.log(`    ${N} calls, ${((Date.now() - t1c) / 1000).toFixed(1)}s`);
}

// 1d. Multi-choice (gemma) at TOP_K = 3, 5, 7
const TOP_K_VALUES = FAST_ONLY ? [5] : [3, 5, 7];
for (const topK of TOP_K_VALUES) {
  console.log(`  Multi-choice (gemma4:e4b) at TOP_K=${topK}...`);
  const t1d = Date.now();
  rawResponses.mc[topK] = new Array(N);
  for (let i = 0; i < N; i++) {
    const item = testItems[i];
    const candidates = item.allCandidates.slice(0, topK);
    const prompt = buildMCPrompt(item.summary, candidates);
    const response = await llm(BIG_MODEL, prompt);
    const parsed = parseMC(response, topK);
    rawResponses.mc[topK][i] = {
      ...parsed,
      pickedName: parsed.catIdx >= 0 ? candidates[parsed.catIdx].name : "No match",
      topSim: candidates[0].sim,
    };
  }
  console.log(`    ${N} calls, ${((Date.now() - t1d) / 1000).toFixed(1)}s`);
}

saveLlmCache();
console.log(`  Cache: ${cacheHits} hits, ${cacheMisses} misses`);

// ═══════════════════════════════════════════════════════════════
// Phase 2: Post-hoc evaluation across parameter grids
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 2: Evaluating parameter configs...");

function score(picks) {
  let tp = 0;          // positive item → correct collection
  let wrongCat = 0;    // positive item → wrong collection
  let missed = 0;      // positive item → "No match" (false negative)
  let falseAssign = 0; // negative item → some collection (false positive)
  let trueReject = 0;  // negative item → "No match" (true negative)

  for (let i = 0; i < N; i++) {
    const gt = testItems[i].groundTruth;
    const pick = picks[i];
    const isNeg = gt === "No match";
    const assigned = pick !== "No match" && pick !== "???";

    if (isNeg) {
      if (assigned) falseAssign++;
      else trueReject++;
    } else {
      if (pick === gt) tp++;
      else if (!assigned) missed++;
      else wrongCat++;
    }
  }

  const totalAssigned = tp + wrongCat + falseAssign;
  const totalPositive = tp + wrongCat + missed;  // all items with a true collection
  const totalNegative = trueReject + falseAssign; // all items with no collection

  const precision = totalAssigned > 0 ? tp / totalAssigned * 100 : 100;
  const recall = totalPositive > 0 ? tp / totalPositive * 100 : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const fpr = totalNegative > 0 ? falseAssign / totalNegative * 100 : 0;
  const accuracy = (tp + trueReject) / N * 100;

  return { tp, wrongCat, missed, falseAssign, trueReject,
           precision, recall, f1, fpr, accuracy, picks };
}

const allConfigs = [];

// ── A. Embedding-only: sweep sim_threshold ──
for (const thresh of [0.65, 0.70, 0.72, 0.75, 0.78, 0.80, 0.85]) {
  const picks = testItems.map(item => {
    const top = item.allCandidates[0];
    return top.sim >= thresh ? top.name : "No match";
  });
  const s = score(picks);
  allConfigs.push({
    family: "Embedding-only",
    params: { sim_threshold: thresh },
    label: `sim≥${thresh}`,
    ...s,
  });
}

// ── B. Binary (llama): no threshold to sweep, just report ──
if (rawResponses.binaryLlama[0]) {
  const picks = rawResponses.binaryLlama.map(r => r.isYes ? r.candidateName : "No match");
  const s = score(picks);
  allConfigs.push({
    family: "Binary (llama3)",
    params: {},
    label: "top-1 yes/no",
    ...s,
  });
}

// ── C. Binary (gemma): no threshold to sweep ──
if (rawResponses.binaryGemma[0]) {
  const picks = rawResponses.binaryGemma.map(r => r.isYes ? r.candidateName : "No match");
  const s = score(picks);
  allConfigs.push({
    family: "Binary (gemma4)",
    params: {},
    label: "top-1 yes/no",
    ...s,
  });
}

// ── D. Tiered (llama): sweep auto_threshold × margin ──
if (rawResponses.binaryLlama[0]) {
  for (const autoThresh of [0.78, 0.80, 0.82, 0.85]) {
    for (const margin of [0.02, 0.04, 0.06]) {
      const picks = testItems.map((item, i) => {
        const top = item.allCandidates[0];
        const second = item.allCandidates[1];
        const m = top.sim - second.sim;
        // Auto-accept if high sim + clear margin
        if (top.sim >= autoThresh && m >= margin) return top.name;
        // Otherwise use cached binary response
        return rawResponses.binaryLlama[i].isYes ? rawResponses.binaryLlama[i].candidateName : "No match";
      });
      const s = score(picks);
      allConfigs.push({
        family: "Tiered (llama3)",
        params: { auto_threshold: autoThresh, margin },
        label: `auto≥${autoThresh} margin≥${margin}`,
        ...s,
      });
    }
  }
}

// ── E. Tiered (gemma): sweep auto_threshold × margin ──
if (rawResponses.binaryGemma[0]) {
  for (const autoThresh of [0.78, 0.80, 0.82, 0.85]) {
    for (const margin of [0.02, 0.04, 0.06]) {
      const picks = testItems.map((item, i) => {
        const top = item.allCandidates[0];
        const second = item.allCandidates[1];
        const m = top.sim - second.sim;
        if (top.sim >= autoThresh && m >= margin) return top.name;
        return rawResponses.binaryGemma[i].isYes ? rawResponses.binaryGemma[i].candidateName : "No match";
      });
      const s = score(picks);
      allConfigs.push({
        family: "Tiered (gemma4)",
        params: { auto_threshold: autoThresh, margin },
        label: `auto≥${autoThresh} margin≥${margin}`,
        ...s,
      });
    }
  }
}

// ── F. Multi-choice: sweep TOP_K × score_threshold ──
for (const topK of TOP_K_VALUES) {
  if (!rawResponses.mc[topK]) continue;
  for (const scoreThresh of [3, 5, 6, 7, 8]) {
    const picks = rawResponses.mc[topK].map(r => {
      if (r.catIdx < 0 || r.score < scoreThresh) return "No match";
      return r.pickedName;
    });
    const s = score(picks);
    allConfigs.push({
      family: "Multi-choice (gemma4)",
      params: { top_k: topK, score_threshold: scoreThresh },
      label: `K=${topK} score≥${scoreThresh}`,
      ...s,
    });
  }
}

// ── G. Two-pass: sweep sim_threshold × score_threshold ──
if (rawResponses.twoPassGemma[0]) {
  for (const simThresh of [0.65, 0.68, 0.70, 0.72, 0.75, 0.78]) {
    for (const scoreThresh of [3, 5, 6, 7, 8]) {
      const picks = testItems.map((item, i) => {
        const top = item.allCandidates[0];
        if (top.sim < simThresh) return "No match";
        const r = rawResponses.twoPassGemma[i];
        if (!r.isYes || r.score < scoreThresh) return "No match";
        return r.candidateName;
      });
      const s = score(picks);
      allConfigs.push({
        family: "Two-pass NOT (gemma4)",
        params: { sim_threshold: simThresh, score_threshold: scoreThresh },
        label: `sim≥${simThresh} score≥${scoreThresh}`,
        ...s,
      });
    }
  }
}

// ── H. Combined: sweep accept_sim × margin × reject_floor × score_threshold ──
if (rawResponses.twoPassGemma[0]) {
  for (const acceptSim of [0.80, 0.82, 0.85]) {
    for (const margin of [0.02, 0.04, 0.06]) {
      for (const rejectFloor of [0.68, 0.70, 0.72, 0.75]) {
        for (const scoreThresh of [3, 5, 7]) {
          const picks = testItems.map((item, i) => {
            const top = item.allCandidates[0];
            const second = item.allCandidates[1];
            const m = top.sim - second.sim;
            // Auto-accept
            if (top.sim >= acceptSim && m >= margin) return top.name;
            // Auto-reject
            if (top.sim < rejectFloor) return "No match";
            // LLM verify
            const r = rawResponses.twoPassGemma[i];
            if (!r.isYes || r.score < scoreThresh) return "No match";
            return r.candidateName;
          });
          const s = score(picks);
          allConfigs.push({
            family: "Combined (gemma4)",
            params: { accept_sim: acceptSim, margin, reject_floor: rejectFloor, score_threshold: scoreThresh },
            label: `acc≥${acceptSim} m≥${margin} rej<${rejectFloor} sc≥${scoreThresh}`,
            ...s,
          });
        }
      }
    }
  }
}

// ── I. Per-collection thresholds: reject based on collection-specific sim percentiles ──
for (const percentile of [5, 10, 20, 30]) {
  const pKey = `p${percentile}`;
  // Pure per-collection threshold
  const picks = testItems.map(item => {
    const top = item.allCandidates[0];
    const thresh = collectionThresholds.get(top.name)?.[pKey] || 0;
    return top.sim >= thresh ? top.name : "No match";
  });
  const s = score(picks);
  allConfigs.push({
    family: "Per-collection threshold",
    params: { percentile },
    label: `member-p${percentile}`,
    ...s,
  });

  // Per-collection threshold + global floor
  for (const floor of [0.68, 0.70, 0.72]) {
    const picks2 = testItems.map(item => {
      const top = item.allCandidates[0];
      const thresh = collectionThresholds.get(top.name)?.[pKey] || 0;
      const effectiveThresh = Math.max(thresh, floor);
      return top.sim >= effectiveThresh ? top.name : "No match";
    });
    const s2 = score(picks2);
    allConfigs.push({
      family: "Per-collection threshold",
      params: { percentile, global_floor: floor },
      label: `member-p${percentile} floor≥${floor}`,
      ...s2,
    });
  }
}

// ── J. Unsorted centroid: reject if unsorted centroid is closer or ratio too low ──
if (unsortedCentroid) {
  // J1: reject if unsorted centroid is closer than top collection
  {
    const picks = testItems.map(item => {
      const top = item.allCandidates[0];
      return top.sim > item.unsortedSim ? top.name : "No match";
    });
    const s = score(picks);
    allConfigs.push({
      family: "Unsorted centroid",
      params: { method: "closer" },
      label: "unsorted-closer",
      ...s,
    });
  }

  // J2: reject if top_sim / unsorted_sim < ratio threshold
  for (const ratio of [1.00, 1.02, 1.05, 1.08, 1.10]) {
    const picks = testItems.map(item => {
      const top = item.allCandidates[0];
      const r = top.sim / (item.unsortedSim || 0.001);
      return r >= ratio ? top.name : "No match";
    });
    const s = score(picks);
    allConfigs.push({
      family: "Unsorted centroid",
      params: { method: "ratio", ratio_threshold: ratio },
      label: `ratio≥${ratio}`,
      ...s,
    });
  }

  // J3: combined — auto-accept high, auto-reject low, ratio test in middle
  for (const acceptSim of [0.78, 0.80]) {
    for (const rejectFloor of [0.68, 0.70]) {
      for (const ratio of [1.02, 1.05, 1.08]) {
        const picks = testItems.map(item => {
          const top = item.allCandidates[0];
          if (top.sim >= acceptSim) return top.name;
          if (top.sim < rejectFloor) return "No match";
          const r = top.sim / (item.unsortedSim || 0.001);
          return r >= ratio ? top.name : "No match";
        });
        const s = score(picks);
        allConfigs.push({
          family: "Unsorted centroid",
          params: { method: "combined", accept_sim: acceptSim, reject_floor: rejectFloor, ratio_threshold: ratio },
          label: `acc≥${acceptSim} rej<${rejectFloor} ratio≥${ratio}`,
          ...s,
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: Report + output
// ═══════════════════════════════════════════════════════════════

console.log(`\nEvaluated ${allConfigs.length} configs across ${new Set(allConfigs.map(c => c.family)).size} strategy families\n`);

// Find best config per family
const families = new Map();
for (const cfg of allConfigs) {
  if (!families.has(cfg.family)) families.set(cfg.family, []);
  families.get(cfg.family).push(cfg);
}

console.log("═".repeat(130));
console.log(`BEST CONFIG PER STRATEGY FAMILY  (test set: ${nPos} positive + ${nNeg} negative = ${N} items, leave-one-out centroids)`);
console.log("═".repeat(130));

const bestPerFamily = [];
for (const [family, configs] of families) {
  // Sort by F1 (balances precision + recall), break ties with accuracy
  configs.sort((a, b) => b.f1 - a.f1 || b.accuracy - a.accuracy);
  const best = configs[0];
  const worst = configs[configs.length - 1];
  bestPerFamily.push(best);
  console.log(`\n${family} (${configs.length} configs):`);
  console.log(`  Best:  ${best.label.padEnd(40)} F1=${best.f1.toFixed(1)} prec=${best.precision.toFixed(0)}% rec=${best.recall.toFixed(0)}% FPR=${best.fpr.toFixed(0)}%`);
  console.log(`  Worst: ${worst.label.padEnd(40)} F1=${worst.f1.toFixed(1)} prec=${worst.precision.toFixed(0)}% rec=${worst.recall.toFixed(0)}% FPR=${worst.fpr.toFixed(0)}%`);
  console.log(`  Range: ${(best.f1 - worst.f1).toFixed(1)} F1 spread`);
}

// Rank best configs across families
bestPerFamily.sort((a, b) => b.f1 - a.f1 || b.accuracy - a.accuracy);
console.log(`\n${"═".repeat(130)}`);
console.log("STRATEGY RANKING (best config per family, sorted by F1)");
console.log("═".repeat(130));
const colW = 10;
const nameW = 28;
const cfgW = 42;
console.log(
  "Strategy".padEnd(nameW) + "Config".padEnd(cfgW) +
  "TP".padStart(colW) + "WrongC".padStart(colW) + "FalseA".padStart(colW) +
  "Missed".padStart(colW) + "TrueRj".padStart(colW) +
  "Prec".padStart(colW) + "Recall".padStart(colW) + "F1".padStart(colW) + "FPR".padStart(colW)
);
console.log("─".repeat(nameW + cfgW + colW * 9));
for (const b of bestPerFamily) {
  console.log(
    b.family.slice(0, nameW - 2).padEnd(nameW) + b.label.padEnd(cfgW) +
    `${b.tp}`.padStart(colW) + `${b.wrongCat}`.padStart(colW) + `${b.falseAssign}`.padStart(colW) +
    `${b.missed}`.padStart(colW) + `${b.trueReject}`.padStart(colW) +
    `${b.precision.toFixed(0)}%`.padStart(colW) + `${b.recall.toFixed(0)}%`.padStart(colW) +
    `${b.f1.toFixed(1)}`.padStart(colW) + `${b.fpr.toFixed(0)}%`.padStart(colW)
  );
}

// Embedding ceilings
console.log("─".repeat(nameW + cfgW + colW * 9));
// Positive-only ceiling: of items with a collection, how many have GT as top-1?
const posItems = testItems.filter(item => item.groundTruth !== "No match");
const top1Correct = posItems.filter(item => item.allCandidates[0].name === item.groundTruth).length;
const topKCorrect = posItems.filter(item => item.allCandidates.some(c => c.name === item.groundTruth)).length;
console.log(`Embedding ceiling — positive items only (${posItems.length}):`);
console.log(`  Top-1 = ground truth:    ${top1Correct}/${posItems.length} (${(top1Correct/posItems.length*100).toFixed(0)}%)`);
console.log(`  GT in top-${MAX_TOP_K}:             ${topKCorrect}/${posItems.length} (${(topKCorrect/posItems.length*100).toFixed(0)}%)`);

// Full ceiling including negatives (what if we always assign top-1?)
const ceilingPicks = testItems.map(item => item.allCandidates[0].name);
const ceiling = score(ceilingPicks);
console.log(`Always-assign ceiling (all ${N} items): F1=${ceiling.f1.toFixed(1)} prec=${ceiling.precision.toFixed(0)}% rec=${ceiling.recall.toFixed(0)}% FPR=${ceiling.fpr.toFixed(0)}%`);
// ── Save JSON for dashboard ──

const output = {
  generated: new Date().toISOString(),
  testSize: N,
  positiveCount: nPos,
  negativeCount: nNeg,
  seed: SEED,
  maxTopK: MAX_TOP_K,
  fastOnly: FAST_ONLY,
  leaveOneOut: true,
  embeddingCeiling: { top1Positive: top1Correct, topKPositive: topKCorrect, totalPositive: posItems.length, alwaysAssign: ceiling },
  testItems: testItems.map(item => ({
    id: item.id,
    summary: item.summary,
    groundTruth: item.groundTruth,
    isNegative: item.groundTruth === "No match",
    top1: { name: item.allCandidates[0].name, sim: item.allCandidates[0].sim },
    unsortedSim: item.unsortedSim,
    gtInTopK: item.groundTruth !== "No match" && item.allCandidates.some(c => c.name === item.groundTruth),
  })),
  families: [...families.entries()].map(([family, configs]) => ({
    family,
    configs: configs.map(c => ({
      label: c.label,
      params: c.params,
      tp: c.tp,
      wrongCat: c.wrongCat,
      missed: c.missed,
      falseAssign: c.falseAssign,
      trueReject: c.trueReject,
      precision: c.precision,
      recall: c.recall,
      f1: c.f1,
      fpr: c.fpr,
      accuracy: c.accuracy,
      picks: c.picks,
    })),
    bestConfig: configs[0].label,
    bestF1: configs[0].f1,
    bestPrecision: configs[0].precision,
    bestRecall: configs[0].recall,
    worstF1: configs[configs.length - 1].f1,
    f1Sensitivity: configs[0].f1 - configs[configs.length - 1].f1,
  })),
  rawResponses: {
    binaryLlama: rawResponses.binaryLlama?.map(r => r ? { isYes: r.isYes, candidateName: r.candidateName, sim: r.sim, reason: r.reason } : null),
    binaryGemma: rawResponses.binaryGemma?.map(r => r ? { isYes: r.isYes, candidateName: r.candidateName, sim: r.sim, reason: r.reason } : null),
    twoPassGemma: rawResponses.twoPassGemma?.map(r => r ? { isYes: r.isYes, score: r.score, candidateName: r.candidateName, sim: r.sim, reason: r.reason } : null),
    mc: Object.fromEntries(TOP_K_VALUES.map(k => [k, (rawResponses.mc[k] || []).map(r => r ? { pickedName: r.pickedName, score: r.score, topSim: r.topSim, reason: r.reason } : null)])),
  },
};

const jsonPath = path.join(ROOST_DIR, "strategy-results.json");
fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
console.log(`\nSaved ${allConfigs.length} configs to: ${jsonPath}`);
console.log(`LLM cache: ${Object.keys(llmCache).length} entries in ${LLM_CACHE_PATH}`);
