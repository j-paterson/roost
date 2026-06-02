#!/usr/bin/env node
/**
 * Test different scoring strategies on the same 20 items.
 * Compares accuracy, speed, and agreement with the "best" model.
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const OLLAMA_URL = "http://localhost:11434";
const FAST_MODEL = "llama3.2:3b";
const BIG_MODEL = "gemma4:e4b";
const TOP_K = 5;
const SEED = 42; // Fixed seed for reproducibility

// ── Load data ──

const cache = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "embedding-cache.json"), "utf8"));
const contrastiveDescs = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "collection-descriptions-contrastive.json"), "utf8"));
let notDescsRaw = {};
for (const variant of ["collection-not-descriptions.json", "collection-not-descriptions-llama3-2-3b.json"]) {
  try { notDescsRaw = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, variant), "utf8")); console.log(`Loaded NOT descriptions from ${variant}`); break; } catch {}
}
const notDescs = new Map(Object.entries(notDescsRaw));
// Per-neighbor NOTs are objects like { "Drinks": "cocktail prep", "Austin": "local reviews" }
// Flatten to a single string for strategies that need the old format
function flattenNot(notObj) {
  if (typeof notObj === "string") return notObj;
  if (typeof notObj === "object" && notObj) return Object.values(notObj).join("; ");
  return "";
}

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

// Seeded PRNG (simple mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Build collection data ──

console.log("Building collection centroids...");
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
  categoryDefs.push({ name, centroid: computeCentroid(vecs), description: desc, notDescription: notFlat, notPerNeighbor: typeof notDesc === "object" ? notDesc : null, memberIds: ids });
}
console.log(`${categoryDefs.length} collections with centroids\n`);

// ── Pick N deterministic labeled items (ground truth = their collection) ──

const TEST_SIZE = parseInt(process.argv[2] || "50");

// Build a pool: sample from each collection proportionally, at least 1 per collection
const rng = mulberry32(SEED);
const testPool = [];
for (const [name, ids] of collectionItems) {
  const withVec = ids.filter(id => cache[id]?.vec);
  if (withVec.length < 3) continue; // skip tiny collections — need items left for centroid
  // Shuffle deterministically
  const shuffled = [...withVec];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Take up to 3 per collection (or proportional for larger test sets)
  const take = Math.max(1, Math.min(3, Math.ceil(TEST_SIZE / categoryDefs.length)));
  for (const id of shuffled.slice(0, take)) {
    testPool.push({ id, groundTruth: name });
  }
}
// Shuffle the pool and take TEST_SIZE
for (let i = testPool.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [testPool[i], testPool[j]] = [testPool[j], testPool[i]];
}
const testEntries = testPool.slice(0, TEST_SIZE);
const testIds = testEntries.map(e => e.id);
const groundTruth = Object.fromEntries(testEntries.map(e => [e.id, e.groundTruth]));

console.log(`Test set: ${testEntries.length} labeled items from ${new Set(testEntries.map(e => e.groundTruth)).size} collections\n`);

// Pre-compute candidates for each test item
const testItems = testIds.map(id => {
  const entry = cache[id];
  const summary = stripPreamble((entry.summary || entry.vision?.slice(0, 100) || id)).slice(0, 120);
  const candidates = categoryDefs
    .map(cat => ({ ...cat, sim: cosineSim(entry.vec, cat.centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K);
  return { id, summary, candidates, ollamaCategory: entry.category, groundTruth: groundTruth[id] };
});

console.log(`Testing ${testItems.length} items\n`);

// ── Helper: call Ollama ──

async function llm(model, prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  const json = await res.json();
  return (json.response || "").trim();
}

// ── Helper: build multi-choice prompt ──

function buildMultiChoicePrompt(summary, candidates, shuffle = false) {
  const ordered = shuffle ? [...candidates] : candidates;
  if (shuffle) {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
  }
  const catLines = ordered.map((c, j) => {
    const short = c.description.split(/[.!]\s/)[0].slice(0, 100);
    let line = `${j + 1}. ${c.name}: ${short}`;
    if (c.notDescription) {
      const notShort = c.notDescription.split(/[.!]\s/)[0].slice(0, 80);
      line += `\n   NOT: ${notShort}`;
    }
    return line;
  }).join("\n");

  const prompt = `Which category best fits this item? Rate the fit 1-10 (1=poor, 10=perfect).
The item may not belong to any of these categories — only assign it if there is a genuine fit.

Item: ${summary}

Categories:
${catLines}

Reply with the category number, fit score, and a brief reason.
Example: 2 8 Strong focus on cooking techniques
If none fit well, reply: 0 0 No match`;

  return { prompt, ordered };
}

function parseMultiChoice(response, ordered) {
  const m = response.match(/^(\d+)\s+(\d+)/);
  if (!m) return { name: "???", score: 0 };
  const idx = parseInt(m[1]);
  const score = parseInt(m[2]);
  if (idx === 0) return { name: "No match", score: 0 };
  return { name: ordered[idx - 1]?.name || "???", score };
}

// ── Strategy 1: Embedding-only ──

async function strategyEmbeddingOnly() {
  const THRESHOLD = 0.75;
  const results = [];
  for (const item of testItems) {
    const top = item.candidates[0];
    const assigned = top.sim >= THRESHOLD ? top.name : "No match";
    results.push({ id: item.id, pick: assigned, score: top.sim, reason: `sim=${top.sim.toFixed(3)}` });
  }
  return results;
}

// ── Strategy 2: Binary yes/no with fast model ──

async function strategyBinaryFast() {
  const results = [];
  for (const item of testItems) {
    const top = item.candidates[0];
    const short = top.description.split(/[.!]\s/)[0].slice(0, 100);
    const notLine = top.notDescription ? `\nNOT about: ${top.notDescription.split(/[.!]\s/)[0].slice(0, 80)}` : "";
    const prompt = `Does this item belong in the "${top.name}" collection?
${top.name}: ${short}${notLine}

Item: ${item.summary}

Reply YES or NO, then a brief reason.`;
    const response = await llm(FAST_MODEL, prompt);
    const isYes = /^yes/i.test(response);
    results.push({ id: item.id, pick: isYes ? top.name : "No match", score: isYes ? 1 : 0, reason: response.slice(0, 80) });
  }
  return results;
}

// ── Strategy 3: Binary yes/no with big model ──

async function strategyBinaryBig() {
  const results = [];
  for (const item of testItems) {
    const top = item.candidates[0];
    const short = top.description.split(/[.!]\s/)[0].slice(0, 100);
    const notLine = top.notDescription ? `\nNOT about: ${top.notDescription.split(/[.!]\s/)[0].slice(0, 80)}` : "";
    const prompt = `Does this item belong in the "${top.name}" collection?
${top.name}: ${short}${notLine}

Item: ${item.summary}

Reply YES or NO, then a brief reason.`;
    const response = await llm(BIG_MODEL, prompt);
    const isYes = /^yes/i.test(response);
    results.push({ id: item.id, pick: isYes ? top.name : "No match", score: isYes ? 1 : 0, reason: response.slice(0, 80) });
  }
  return results;
}

// ── Strategy 4: Tiered (auto-assign high confidence, binary check for rest) ──

async function strategyTiered() {
  const AUTO_THRESHOLD = 0.82;
  const MARGIN_THRESHOLD = 0.04;
  const results = [];
  for (const item of testItems) {
    const top = item.candidates[0];
    const second = item.candidates[1];
    const margin = top.sim - second.sim;

    if (top.sim >= AUTO_THRESHOLD && margin >= MARGIN_THRESHOLD) {
      results.push({ id: item.id, pick: top.name, score: 10, reason: `auto: sim=${top.sim.toFixed(3)} margin=${margin.toFixed(3)}` });
      continue;
    }

    // Binary check with fast model
    const short = top.description.split(/[.!]\s/)[0].slice(0, 100);
    const notLine = top.notDescription ? `\nNOT about: ${top.notDescription.split(/[.!]\s/)[0].slice(0, 80)}` : "";
    const prompt = `Does this item belong in the "${top.name}" collection?
${top.name}: ${short}${notLine}

Item: ${item.summary}

Reply YES or NO, then a brief reason.`;
    const response = await llm(FAST_MODEL, prompt);
    const isYes = /^yes/i.test(response);
    results.push({ id: item.id, pick: isYes ? top.name : "No match", score: isYes ? 1 : 0, reason: `llm: ${response.slice(0, 60)}` });
  }
  return results;
}

// ── Strategy 5: Batched multi-choice with big model (5 items per call) ──

async function strategyBatched() {
  const BATCH_SIZE = 5;
  const results = [];

  for (let b = 0; b < testItems.length; b += BATCH_SIZE) {
    const batch = testItems.slice(b, b + BATCH_SIZE);
    const itemBlocks = batch.map((item, bi) => {
      const shuffled = [...item.candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Store shuffled order for parsing
      item._shuffled = shuffled;

      const catLines = shuffled.map((c, j) => {
        const short = c.description.split(/[.!]\s/)[0].slice(0, 100);
        let line = `  ${j + 1}. ${c.name}: ${short}`;
        if (c.notDescription) {
          const notShort = c.notDescription.split(/[.!]\s/)[0].slice(0, 80);
          line += `\n     NOT: ${notShort}`;
        }
        return line;
      }).join("\n");

      return `Item ${String.fromCharCode(65 + bi)}: ${item.summary}\nCategories:\n${catLines}`;
    }).join("\n\n");

    const prompt = `For each item below, pick the best-fitting category and rate 1-10 (1=poor, 10=perfect).
Only assign if there is a genuine fit.

${itemBlocks}

Reply with one line per item in this format:
A: <number> <score> <brief reason>
If none fit: A: 0 0 No match`;

    const response = await llm(BIG_MODEL, prompt);

    // Parse each line
    for (let bi = 0; bi < batch.length; bi++) {
      const item = batch[bi];
      const letter = String.fromCharCode(65 + bi);
      const lineMatch = response.match(new RegExp(`${letter}:\\s*(\\d+)\\s+(\\d+)\\s*(.*)`, "i"));
      if (lineMatch) {
        const idx = parseInt(lineMatch[1]);
        const score = parseInt(lineMatch[2]);
        const reason = lineMatch[3] || "";
        const name = idx === 0 ? "No match" : (item._shuffled[idx - 1]?.name || "???");
        results.push({ id: item.id, pick: name, score, reason: reason.slice(0, 80) });
      } else {
        results.push({ id: item.id, pick: "???", score: 0, reason: "parse fail" });
      }
    }
  }
  return results;
}

// ── Strategy 6: Baseline — multi-choice shuffled with big model ──

async function strategyBaseline() {
  const results = [];
  for (const item of testItems) {
    const { prompt, ordered } = buildMultiChoicePrompt(item.summary, item.candidates, true);
    const response = await llm(BIG_MODEL, prompt);
    const parsed = parseMultiChoice(response, ordered);
    results.push({ id: item.id, pick: parsed.name, score: parsed.score, reason: response.split("\n")[0].slice(0, 80) });
  }
  return results;
}

// ── Strategy 7: Two-pass — embedding pick + per-neighbor NOT verification ──

async function strategyTwoPass() {
  const SIM_THRESHOLD = 0.72;
  const results = [];
  for (const item of testItems) {
    const top = item.candidates[0];
    if (top.sim < SIM_THRESHOLD) {
      results.push({ id: item.id, pick: "No match", score: 0, reason: `sim=${top.sim.toFixed(3)} below threshold` });
      continue;
    }

    // Build verification prompt using per-neighbor NOTs
    const desc = top.description.split(/[.!]\s/)[0].slice(0, 120);
    let notLines = "";
    if (top.notPerNeighbor) {
      notLines = Object.entries(top.notPerNeighbor)
        .map(([nb, phrase]) => `- NOT "${nb}" content: ${phrase}`)
        .join("\n");
    }

    const prompt = `Does this item belong in the "${top.name}" collection?

"${top.name}": ${desc}
${notLines ? `\nThis item does NOT belong in "${top.name}" if it is about:\n${notLines}\n` : ""}
Item: ${item.summary}

Reply YES or NO, then a fit score 1-10 and a brief reason.
Example: YES 8 Clearly about cooking techniques
Example: NO 2 This is about cocktail mixing, not cooking`;

    const response = await llm(BIG_MODEL, prompt);
    const isYes = /^yes/i.test(response);
    const scoreMatch = response.match(/(?:YES|NO)\s+(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : (isYes ? 7 : 0);
    results.push({ id: item.id, pick: isYes ? top.name : "No match", score, reason: response.split("\n")[0].slice(0, 80) });
  }
  return results;
}

// ── Strategy 8: Combined — auto-accept high, auto-reject low, gemma4+NOTs for middle ──

async function strategyCombined() {
  const AUTO_ACCEPT_SIM = 0.82;
  const AUTO_ACCEPT_MARGIN = 0.04;
  const REJECT_FLOOR = 0.72;
  const results = [];
  let autoAccept = 0, autoReject = 0, llmCalls = 0;

  for (const item of testItems) {
    const top = item.candidates[0];
    const second = item.candidates[1];
    const margin = top.sim - second.sim;

    // Auto-accept: high similarity + clear margin
    if (top.sim >= AUTO_ACCEPT_SIM && margin >= AUTO_ACCEPT_MARGIN) {
      autoAccept++;
      results.push({ id: item.id, pick: top.name, score: 10, reason: `auto-accept: sim=${top.sim.toFixed(3)} margin=${margin.toFixed(3)}` });
      continue;
    }

    // Auto-reject: below floor
    if (top.sim < REJECT_FLOOR) {
      autoReject++;
      results.push({ id: item.id, pick: "No match", score: 0, reason: `auto-reject: sim=${top.sim.toFixed(3)}` });
      continue;
    }

    // Middle band: verify with gemma4 + per-neighbor NOTs
    llmCalls++;
    const desc = top.description.split(/[.!]\s/)[0].slice(0, 120);
    let notLines = "";
    if (top.notPerNeighbor) {
      notLines = Object.entries(top.notPerNeighbor)
        .map(([nb, phrase]) => `- NOT "${nb}" content: ${phrase}`)
        .join("\n");
    }

    const prompt = `Does this item belong in the "${top.name}" collection?

"${top.name}": ${desc}
${notLines ? `\nThis item does NOT belong in "${top.name}" if it is about:\n${notLines}\n` : ""}
Item: ${item.summary}

Reply YES or NO, then a fit score 1-10 and a brief reason.
Example: YES 8 Clearly about cooking techniques
Example: NO 2 This is about cocktail mixing, not cooking`;

    const response = await llm(BIG_MODEL, prompt);
    const isYes = /^yes/i.test(response);
    const scoreMatch = response.match(/(?:YES|NO)\s+(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : (isYes ? 7 : 0);
    results.push({ id: item.id, pick: isYes ? top.name : "No match", score, reason: `llm: ${response.split("\n")[0].slice(0, 70)}` });
  }

  console.log(`  Auto-accepted: ${autoAccept}, Auto-rejected: ${autoReject}, LLM calls: ${llmCalls}`);
  return results;
}

// ── Run all strategies ──

const FAST_ONLY = process.argv.includes("--fast");
const allStrategies = [
  { name: "1. Embedding-only (threshold=0.75)", fn: strategyEmbeddingOnly, fast: true },
  { name: "2. Binary yes/no (llama3.2:3b)", fn: strategyBinaryFast, fast: true },
  { name: "3. Binary yes/no (gemma4:e4b)", fn: strategyBinaryBig, fast: false },
  { name: "4. Tiered (auto+binary llama3.2:3b)", fn: strategyTiered, fast: true },
  { name: "5. Batched multi-choice (gemma4:e4b)", fn: strategyBatched, fast: false },
  { name: "6. Baseline: multi-choice shuffled (gemma4:e4b)", fn: strategyBaseline, fast: false },
  { name: "7. Two-pass: embed+NOT verify (gemma4:e4b)", fn: strategyTwoPass, fast: false },
  { name: "8. Combined: auto+reject+NOT verify (gemma4:e4b)", fn: strategyCombined, fast: false },
];
const strategies = FAST_ONLY ? allStrategies.filter(s => s.fast) : allStrategies;
console.log(`Running ${strategies.length} strategies${FAST_ONLY ? " (fast only)" : ""}\n`);

const allResults = {};

for (const strat of strategies) {
  console.log(`${"═".repeat(80)}`);
  console.log(`Running: ${strat.name}`);
  console.log(`${"═".repeat(80)}`);
  const start = Date.now();
  const results = await strat.fn();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  allResults[strat.name] = { results, elapsed };
  console.log(`  Completed in ${elapsed}s\n`);
}

// ── Score against ground truth ──

const N = testItems.length;

console.log(`\n${"═".repeat(130)}`);
console.log("RESULTS vs GROUND TRUTH");
console.log(`${"═".repeat(130)}\n`);

// Score each strategy
function scoreStrategy(name, results) {
  let correct = 0, wrong = 0, noMatch = 0, parseFail = 0;
  // Track if ground truth was in top-K candidates (embedding ceiling)
  let gtInTopK = 0;
  let gtIsTop1 = 0;

  for (let i = 0; i < N; i++) {
    const item = testItems[i];
    const r = results[i];
    const gt = item.groundTruth;

    if (r.pick === "No match") { noMatch++; }
    else if (r.pick === "???") { parseFail++; }
    else if (r.pick === gt) { correct++; }
    else { wrong++; }

    if (item.candidates[0]?.name === gt) gtIsTop1++;
    if (item.candidates.some(c => c.name === gt)) gtInTopK++;
  }

  const assigned = correct + wrong;
  const precision = assigned > 0 ? (correct / assigned * 100) : 0;
  const recall = (correct / N * 100);
  const accuracy = ((correct) / N * 100);

  return { correct, wrong, noMatch, parseFail, precision, recall, accuracy, gtInTopK, gtIsTop1 };
}

// Summary table
const colW = 14;
const nameW = 48;
console.log(
  "Strategy".padEnd(nameW) +
  "Correct".padStart(colW) +
  "Wrong".padStart(colW) +
  "No match".padStart(colW) +
  "Failed".padStart(colW) +
  "Precision".padStart(colW) +
  "Accuracy".padStart(colW) +
  "Time".padStart(colW)
);
console.log("─".repeat(nameW + colW * 7));

for (const strat of strategies) {
  const s = scoreStrategy(strat.name, allResults[strat.name].results);
  console.log(
    strat.name.padEnd(nameW) +
    `${s.correct}/${N}`.padStart(colW) +
    `${s.wrong}`.padStart(colW) +
    `${s.noMatch}`.padStart(colW) +
    `${s.parseFail}`.padStart(colW) +
    `${s.precision.toFixed(0)}%`.padStart(colW) +
    `${s.accuracy.toFixed(0)}%`.padStart(colW) +
    `${allResults[strat.name].elapsed}s`.padStart(colW)
  );
}

// Embedding ceiling
const ceiling = scoreStrategy("ceiling", testItems.map(item => ({ pick: item.candidates[0]?.name || "???", score: 0, reason: "" })));
console.log("─".repeat(nameW + colW * 7));
console.log(`Embedding ceiling (top-1 = ground truth): ${ceiling.correct}/${N} (${ceiling.accuracy.toFixed(0)}%)`);
const topKHits = testItems.filter(item => item.candidates.some(c => c.name === item.groundTruth)).length;
console.log(`Embedding ceiling (top-${TOP_K} contains ground truth): ${topKHits}/${N} (${(topKHits/N*100).toFixed(0)}%)`);

// Per-item detail (show mismatches)
console.log(`\n${"═".repeat(130)}`);
console.log("PER-ITEM DETAIL (mismatches highlighted)");
console.log(`${"═".repeat(130)}\n`);

for (let i = 0; i < N; i++) {
  const item = testItems[i];
  const gt = item.groundTruth;
  const top1 = item.candidates[0];

  // Collect picks from all strategies
  const picks = strategies.map(s => {
    const r = allResults[s.name].results[i];
    const marker = r.pick === gt ? "✓" : (r.pick === "No match" || r.pick === "???") ? "○" : "✗";
    return `${marker}${r.pick}`;
  });

  const anyWrong = strategies.some(s => {
    const r = allResults[s.name].results[i];
    return r.pick !== gt && r.pick !== "No match" && r.pick !== "???";
  });

  // Only show items where at least one strategy got it wrong (or all for small sets)
  if (N <= 60 || anyWrong) {
    console.log(`  [${String(i+1).padStart(2)}] ${item.summary.slice(0, 55).padEnd(55)} GT: ${gt.padEnd(16)} top1: ${top1.name}(${top1.sim.toFixed(3)})`);
    console.log(`       ${picks.join("  ")}`);
  }
}

// Error analysis: what collections get confused most?
// Use the last strategy run as the focus for confusion analysis
const focusStrat = strategies[strategies.length - 1];
console.log(`\n${"═".repeat(130)}`);
console.log(`CONFUSION ANALYSIS (${focusStrat.name})`);
console.log(`${"═".repeat(130)}\n`);

const twoPassResults = allResults[focusStrat.name].results;
const confusions = new Map();
for (let i = 0; i < N; i++) {
  const gt = testItems[i].groundTruth;
  const pick = twoPassResults[i].pick;
  if (pick !== gt && pick !== "No match" && pick !== "???") {
    const key = `${gt} → ${pick}`;
    confusions.set(key, (confusions.get(key) || 0) + 1);
  }
}
const sortedConfusions = [...confusions.entries()].sort((a, b) => b[1] - a[1]);
if (sortedConfusions.length > 0) {
  console.log("Most common misclassifications:");
  for (const [pair, count] of sortedConfusions.slice(0, 15)) {
    console.log(`  ${String(count).padStart(3)}x  ${pair}`);
  }
} else {
  console.log("No misclassifications!");
}

// No-match analysis
const noMatchItems = [];
for (let i = 0; i < N; i++) {
  if (twoPassResults[i].pick === "No match") {
    noMatchItems.push({ gt: testItems[i].groundTruth, summary: testItems[i].summary, sim: testItems[i].candidates[0].sim });
  }
}
if (noMatchItems.length > 0) {
  console.log(`\nOver-rejected (${noMatchItems.length} items said "No match" but had a ground truth):`);
  for (const item of noMatchItems) {
    console.log(`  ${item.gt.padEnd(16)} sim=${item.sim.toFixed(3)}  ${item.summary.slice(0, 60)}`);
  }
}

// ── Save results to JSON for dashboard ──

const jsonOutput = {
  generated: new Date().toISOString(),
  testSize: N,
  seed: SEED,
  topK: TOP_K,
  fastOnly: FAST_ONLY,
  embeddingCeiling: {
    top1: ceiling.correct,
    topK: topKHits,
    total: N,
  },
  testItems: testItems.map(item => ({
    id: item.id,
    summary: item.summary,
    groundTruth: item.groundTruth,
    ollamaCategory: item.ollamaCategory,
    top1: { name: item.candidates[0]?.name, sim: item.candidates[0]?.sim },
    gtInTopK: item.candidates.some(c => c.name === item.groundTruth),
  })),
  strategies: strategies.map(strat => {
    const s = scoreStrategy(strat.name, allResults[strat.name].results);
    return {
      name: strat.name,
      elapsed: allResults[strat.name].elapsed,
      correct: s.correct,
      wrong: s.wrong,
      noMatch: s.noMatch,
      parseFail: s.parseFail,
      precision: s.precision,
      recall: s.recall,
      accuracy: s.accuracy,
      picks: allResults[strat.name].results.map(r => ({
        pick: r.pick,
        score: r.score,
        reason: (r.reason || "").slice(0, 100),
      })),
    };
  }),
};

const jsonPath = path.join(ROOST_DIR, "strategy-results.json");
fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2));
console.log(`\nSaved results to: ${jsonPath}`);
