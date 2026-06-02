#!/usr/bin/env node
/**
 * Test scoring prompt with and without NOT descriptions on ~20 random items.
 * Shows the full prompt and LLM response for manual evaluation.
 *
 * Usage: node scripts/test-scoring.mjs
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const OLLAMA_URL = "http://localhost:11434";
const SCORE_MODEL = "gemma4:e4b";
const EVAL_MODEL = "gemma4:e4b";
const TOP_K = 5;

// ── Load data ──

const cache = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "embedding-cache.json"), "utf8"));
const contrastiveDescs = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "collection-descriptions-contrastive.json"), "utf8"));

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

// ── Build collection data ──

// Scan vault files recursively for collection/roost_category frontmatter
console.log("Building collection centroids...");

const collectionItems = new Map(); // name -> [id]
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
      // Check both collection and roost_category
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

console.log(`Found ${collectionItems.size} collections from vault frontmatter`);

// Build category defs with centroids
const categoryDefs = [];
for (const [name, ids] of collectionItems) {
  const vecs = ids.filter(id => cache[id]?.vec).map(id => cache[id].vec);
  if (vecs.length === 0) continue;
  const desc = contrastiveDescs[name] || name;
  categoryDefs.push({ name, centroid: computeCentroid(vecs), description: desc, memberIds: ids });
}
console.log(`${categoryDefs.length} collections with centroids\n`);

// ── Generate NOT descriptions (cached) ──

const notDescCachePath = path.join(ROOST_DIR, "test-not-descriptions.json");
let notDescs = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(notDescCachePath, "utf8"));
  for (const [k, v] of Object.entries(raw)) notDescs.set(k, v);
  console.log(`Loaded ${notDescs.size} cached NOT descriptions\n`);
} catch {
  console.log("Generating NOT descriptions for collections...\n");
}

{
  let generated = 0;
  for (const cat of categoryDefs) {
    if (notDescs.has(cat.name)) continue;
    const neighbors = categoryDefs
      .filter(c => c.name !== cat.name)
      .map(c => ({ ...c, sim: cosineSim(cat.centroid, c.centroid) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3);

    if (neighbors.length === 0) continue;

    const sampleIds = cat.memberIds.slice(0, 5);
    const sampleTopics = sampleIds.map(id => stripPreamble((cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id)).slice(0, 100));

    const neighborLines = [];
    for (const nb of neighbors) {
      const nbSamples = nb.memberIds.slice(0, 3)
        .map(id => stripPreamble(cache[id]?.summary || "").slice(0, 80))
        .filter(Boolean);
      if (nbSamples.length > 0) {
        neighborLines.push(`  [${nb.name}]: ${nbSamples.join(" | ")}`);
      }
    }

    const neighborNames = neighbors.map(n => `"${n.name}"`).join(", ");
    const prompt = `"${cat.name}" is a bookmark collection. These similar collections are often confused with it:
${neighborLines.join("\n")}

Items in "${cat.name}":
${sampleTopics.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}

What kinds of items from ${neighborNames} would be wrongly placed in "${cat.name}"? Describe the boundary — what looks similar but does NOT belong.
Reply with one short phrase. Example: Dance choreography, athletic cosplay, or wellness aesthetics
Just the phrase, nothing else.`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
      });
      const json = await res.json();
      const raw = (json.response || "").trim();
      const desc = raw.split("\n")[0].slice(0, 150);
      notDescs.set(cat.name, desc);
      console.log(`  ${cat.name} NOT: ${desc}`);
    } catch (e) {
      console.log(`  ${cat.name}: FAILED (${e.message})`);
    }
  }

  // Cache to disk
  const obj = {};
  for (const [k, v] of notDescs) obj[k] = v;
  fs.writeFileSync(notDescCachePath, JSON.stringify(obj, null, 2));
  console.log(`\nCached ${notDescs.size} NOT descriptions\n`);
}

console.log(`${"=".repeat(80)}\n${notDescs.size} NOT descriptions ready\n${"=".repeat(80)}\n`);

// ── Pick 20 random unsorted items ──

// Build fast lookup of all labeled IDs
const labeledIds = new Set();
for (const [, ids] of collectionItems) for (const id of ids) labeledIds.add(id);

const unsortedIds = [];
for (const [id, entry] of Object.entries(cache)) {
  if (!id.startsWith("tiktok:")) continue;
  if (!entry.vec) continue;
  if (!labeledIds.has(id)) unsortedIds.push(id);
}

// Shuffle and pick 20
for (let i = unsortedIds.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [unsortedIds[i], unsortedIds[j]] = [unsortedIds[j], unsortedIds[i]];
}
const testIds = unsortedIds.slice(0, 20);

console.log(`Testing ${testIds.length} unsorted items\n`);

// ── Score each item ──

for (let idx = 0; idx < testIds.length; idx++) {
  const id = testIds[idx];
  const entry = cache[id];
  const summary = stripPreamble((entry.summary || entry.vision?.slice(0, 100) || id)).slice(0, 120);

  // Find top-K nearest categories (sorted by similarity)
  const candidates = categoryDefs
    .map(cat => ({ ...cat, sim: cosineSim(entry.vec, cat.centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K);

  // Shuffle candidates for prompt (cancel positional bias)
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Build prompt with shuffled order
  const catLines = shuffled.map((c, j) => {
    const short = c.description.split(/[.!]\s/)[0].slice(0, 100);
    let line = `${j + 1}. ${c.name}: ${short}`;
    const notDesc = notDescs.get(c.name);
    if (notDesc) {
      const notShort = notDesc.split(/[.!]\s/)[0].slice(0, 80);
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

  // Call LLM
  let response = "";
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: SCORE_MODEL, prompt, stream: false }),
    });
    const json = await res.json();
    response = (json.response || "").trim();
  } catch (e) {
    response = `ERROR: ${e.message}`;
  }

  // Parse response to map back to category name
  const responseMatch = response.match(/^(\d+)\s+(\d+)\s*(.*)/);
  let pickedName = "???";
  let pickedScore = "?";
  if (responseMatch) {
    const pickedIdx = parseInt(responseMatch[1]);
    pickedScore = responseMatch[2];
    pickedName = pickedIdx === 0 ? "No match" : (shuffled[pickedIdx - 1]?.name || "???");
  }

  // Print results
  console.log(`${"─".repeat(80)}`);
  console.log(`[${idx + 1}/20] ${id}`);
  console.log(`Item: ${summary}`);
  console.log(`Ollama category: ${entry.category}`);
  console.log(`Top-5 by embedding: ${candidates.map(c => `${c.name}(${c.sim.toFixed(3)})`).join(", ")}`);
  console.log(`Options shown (shuffled):`);
  shuffled.forEach((c, j) => {
    const notDesc = notDescs.get(c.name);
    const notShort = notDesc ? ` | NOT: ${notDesc.split(/[.!]\s/)[0].slice(0, 60)}` : "";
    console.log(`  ${j + 1}. ${c.name} (sim=${c.sim.toFixed(3)})${notShort}`);
  });
  console.log(`LLM pick: ${pickedName} (${pickedScore}/10)`);
  console.log(`Response: ${response}`);
  console.log();
}
