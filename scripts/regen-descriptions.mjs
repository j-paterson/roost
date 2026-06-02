#!/usr/bin/env node
/**
 * Regenerate contrastive + NOT descriptions using bidirectional neighbors.
 * Writes to collection-descriptions-contrastive.json and collection-not-descriptions.json
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const OLLAMA_URL = "http://localhost:11434";
const EVAL_MODEL = process.argv[2] || "gemma4:e4b";
const TOP_N = 5;
const suffix = EVAL_MODEL === "gemma4:e4b" ? "" : `-${EVAL_MODEL.replace(/[:.]/g, "-")}`;
console.log(`Using model: ${EVAL_MODEL}${suffix ? ` (output suffix: ${suffix})` : ""}\n`);

// ── Load data ──

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

/** Pick the N member IDs closest to a centroid. */
function pickNearestIds(memberIds, centroid, n) {
  return memberIds
    .filter(id => cache[id]?.vec)
    .map(id => ({ id, sim: cosineSim(cache[id].vec, centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, n)
    .map(x => x.id);
}

// ── Build collection data from vault frontmatter ──

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

console.log(`Found ${collectionItems.size} collections`);

// Build centroids
const clusters = [];
const centroids = new Map();
for (const [name, ids] of collectionItems) {
  const vecs = ids.filter(id => cache[id]?.vec).map(id => cache[id].vec);
  if (vecs.length === 0) continue;
  const centroid = computeCentroid(vecs);
  centroids.set(name, centroid);
  clusters.push({ name, memberIds: ids, centroid });
}
console.log(`${clusters.length} collections with centroids`);

// ── Build bidirectional neighbors ──

const forwardNeighbors = new Map();
for (const cluster of clusters) {
  const ranked = clusters
    .filter(c => c.name !== cluster.name)
    .map(c => ({ name: c.name, sim: cosineSim(cluster.centroid, c.centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_N);
  forwardNeighbors.set(cluster.name, ranked);
}

// Merge forward + reverse
const biNeighbors = new Map();
for (const [name, fwd] of forwardNeighbors) {
  if (!biNeighbors.has(name)) biNeighbors.set(name, new Map());
  const map = biNeighbors.get(name);
  for (const nb of fwd) map.set(nb.name, Math.max(map.get(nb.name) || 0, nb.sim));
}
for (const [name, fwd] of forwardNeighbors) {
  for (const nb of fwd) {
    if (!biNeighbors.has(nb.name)) biNeighbors.set(nb.name, new Map());
    const map = biNeighbors.get(nb.name);
    if (!map.has(name)) {
      map.set(name, cosineSim(centroids.get(nb.name), centroids.get(name)));
    }
  }
}

// Show neighbor counts
let extraCount = 0;
for (const [name, nbMap] of biNeighbors) {
  const fwd = forwardNeighbors.get(name) || [];
  const fwdNames = new Set(fwd.map(n => n.name));
  for (const [nbName] of nbMap) {
    if (!fwdNames.has(nbName)) extraCount++;
  }
}
console.log(`Bidirectional neighbors added ${extraCount} extra edges\n`);

// ── Generate descriptions ──

const descriptions = {};
const notDescriptions = {};
let i = 0;

for (const cluster of clusters) {
  i++;
  const nbMap = biNeighbors.get(cluster.name);
  if (!nbMap || nbMap.size === 0) { descriptions[cluster.name] = cluster.name; continue; }

  const neighbors = [...nbMap.entries()]
    .map(([name, sim]) => ({ name, sim }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_N);

  const sampleIds = pickNearestIds(cluster.memberIds, cluster.centroid, 8);
  const sampleTopics = sampleIds.map(id => stripPreamble((cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id)).slice(0, 120));

  const counterLines = [];
  for (const nb of neighbors) {
    const nbCluster = clusters.find(c => c.name === nb.name);
    if (!nbCluster) continue;
    const nbSampleIds = pickNearestIds(nbCluster.memberIds, nbCluster.centroid, 3);
    const nbSamples = nbSampleIds
      .map(id => stripPreamble(cache[id]?.summary || "").slice(0, 80))
      .filter(Boolean);
    if (nbSamples.length > 0) {
      counterLines.push(`  [${nb.name}]: ${nbSamples.join(" | ")}`);
    }
  }

  const neighborNames = neighbors.map(n => `"${n.name}"`).join(", ");
  let prompt = `A bookmark collection called "${cluster.name}" with ${cluster.memberIds.length} items.\n\nItems IN "${cluster.name}":\n${sampleTopics.map((t, j) => `  ${j + 1}. ${t}`).join("\n")}\n`;
  if (counterLines.length > 0) {
    prompt += `\nItems NOT in "${cluster.name}" but in similar collections:\n${counterLines.join("\n")}\n`;
  }
  const notLines = neighbors.map(n => `NOT ${n.name}: <short phrase describing what belongs in "${n.name}" but NOT in "${cluster.name}">`);
  prompt += `\nAnswer these questions about "${cluster.name}" vs its neighbors:

1. DESCRIPTION: What specifically distinguishes "${cluster.name}"? Mention concrete content types, not abstract qualities. One sentence.
${notLines.map((l, j) => `${j + 2}. ${l}`).join("\n")}

Reply in exactly this format:
DESCRIPTION: <one sentence>
${neighbors.map(n => `NOT ${n.name}: <short phrase>`).join("\n")}`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EVAL_MODEL, prompt, stream: false }),
    });
    const json = await res.json();
    const raw = (json.response || "").trim();

    const descMatch = raw.match(/DESCRIPTION:\s*(.+)/i);
    const desc = descMatch ? descMatch[1].trim().slice(0, 250) : cluster.name;
    descriptions[cluster.name] = desc;

    // Parse per-neighbor NOT lines
    const perNeighborNot = {};
    for (const nb of neighbors) {
      const re = new RegExp(`NOT\\s+${nb.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)`, "i");
      const m = raw.match(re);
      if (m) perNeighborNot[nb.name] = m[1].trim().slice(0, 150);
    }
    if (Object.keys(perNeighborNot).length > 0) {
      notDescriptions[cluster.name] = perNeighborNot;
      console.log(`[${i}/${clusters.length}] ${cluster.name}`);
      console.log(`  DESC: ${desc.slice(0, 100)}`);
      for (const [nb, phrase] of Object.entries(perNeighborNot)) {
        console.log(`  NOT ${nb}: ${phrase.slice(0, 70)}`);
      }
    } else {
      console.log(`[${i}/${clusters.length}] ${cluster.name}: ${desc.slice(0, 100)}`);
    }
  } catch (e) {
    descriptions[cluster.name] = cluster.name;
    console.log(`[${i}/${clusters.length}] ${cluster.name}: FAILED (${e.message})`);
  }
}

// Write to cache files (with suffix for non-default models)
const descPath = path.join(ROOST_DIR, `collection-descriptions-contrastive${suffix}.json`);
const notPath = path.join(ROOST_DIR, `collection-not-descriptions${suffix}.json`);
fs.writeFileSync(descPath, JSON.stringify(descriptions, null, 2));
fs.writeFileSync(notPath, JSON.stringify(notDescriptions, null, 2));
console.log(`\nWrote ${Object.keys(descriptions).length} descriptions + ${Object.keys(notDescriptions).length} NOT descriptions`);
console.log(`  → ${descPath}`);
console.log(`  → ${notPath}`);
