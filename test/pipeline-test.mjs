/**
 * Miniature pipeline tests — run real algorithms on real data.
 * Usage: node test/pipeline-test.mjs
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { UMAP } = require("umap-js");
const { HDBSCAN } = require("hdbscan-ts");

const HOME = process.env.HOME;
const CACHE_FILE = path.join(HOME, "Library/Application Support/roost-app/.embedding-cache-tiktok.json");
const VAULT_CACHE = path.join(HOME, "ObsidianBookmarks/.roost/embedding-cache.json");
const VAULT_PATH = path.join(HOME, "ObsidianBookmarks");
const OLLAMA = "http://localhost:11434";

let passed = 0, failed = 0;
function assert(name, condition, detail = "") {
  if (condition) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name} ${detail}`); failed++; }
}

// ═══════════════════════════════════════════════
// TEST 1: Load embedding cache
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 1: Load embedding cache");
let cache;
try {
  // Prefer vault-local cache, fall back to roost-app cache
  const cacheFile = fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : CACHE_FILE;
  cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const ids = Object.keys(cache);
  assert("Cache loaded", ids.length > 0, `got ${ids.length} entries`);

  const withVec = ids.filter(id => cache[id]?.vec);
  assert("Has embeddings", withVec.length > 100, `${withVec.length} with vectors`);

  const sample = cache[withVec[0]];
  assert("Vec is 768d or 1024d", sample.vec.length >= 768, `vec length: ${sample.vec.length}`);
  assert("Has topic", typeof sample.topic === "string" && sample.topic.length > 0);
  assert("Has category", typeof sample.category === "string" && sample.category.length > 0);

  console.log(`  📊 ${ids.length} total, ${withVec.length} embedded, sample vec dim: ${sample.vec.length}`);
  console.log(`  📝 Sample topic: "${sample.topic?.slice(0, 60)}..."`);
  console.log(`  🏷️  Sample category: "${sample.category}"`);
} catch (e) {
  assert("Cache loaded", false, e.message);
}

// ═══════════════════════════════════════════════
// TEST 2: Cosine similarity math
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 2: Cosine similarity");
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

assert("Self-similarity = 1", Math.abs(cosineSimilarity([1,2,3], [1,2,3]) - 1) < 0.001);
assert("Orthogonal = 0", Math.abs(cosineSimilarity([1,0,0], [0,1,0])) < 0.001);
assert("Opposite = -1", Math.abs(cosineSimilarity([1,0], [-1,0]) + 1) < 0.001);

// Test on real embeddings
if (cache) {
  const ids = Object.keys(cache).filter(id => cache[id]?.vec);
  const v1 = cache[ids[0]].vec;
  const v2 = cache[ids[1]].vec;
  const sim = cosineSimilarity(v1, v2);
  assert("Real vectors similarity in [-1,1]", sim >= -1 && sim <= 1, `sim=${sim.toFixed(4)}`);
  console.log(`  📊 Similarity between first two items: ${sim.toFixed(4)}`);
}

// ═══════════════════════════════════════════════
// TEST 3: HDBSCAN on raw vectors (library sanity check)
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 3: HDBSCAN on 50 raw vectors (library sanity check)");
console.log("  ℹ️  Note: 768d is too high for good HDBSCAN results — production uses UMAP to 15d first");

if (cache) {
  const ids = Object.keys(cache).filter(id => cache[id]?.vec).slice(0, 50);
  const vectors = ids.map(id => cache[id].vec);
  const t0 = Date.now();
  const hdbscan = new HDBSCAN({ minClusterSize: 3 });
  const labels = hdbscan.fit(vectors);
  const elapsed = Date.now() - t0;

  assert("Labels returned for all items", labels.length === 50, `got ${labels.length}`);

  const uniqueLabels = [...new Set(labels)];
  const clusterLabels = uniqueLabels.filter(l => l >= 0);
  const noiseCount = labels.filter(l => l === -1).length;

  assert("At least 1 cluster or all noise", clusterLabels.length >= 1 || noiseCount === 50,
    `clusters=${clusterLabels.length}, noise=${noiseCount}`);
  assert("Labels are integers", labels.every(l => Number.isInteger(l)));
  assert("Fast enough (<5s)", elapsed < 5000, `${elapsed}ms`);

  console.log(`  📊 ${clusterLabels.length} clusters, ${noiseCount} noise items in ${elapsed}ms`);
  for (const cl of clusterLabels) {
    const count = labels.filter(l => l === cl).length;
    console.log(`    Cluster ${cl}: ${count} items`);
  }
}

// ═══════════════════════════════════════════════
// TEST 4: c-TF-IDF naming on small clusters
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 4: c-TF-IDF naming");

const STOPWORDS = new Set(["the","a","an","is","are","was","were","be","this","that","and","but","or","not","for","with","about","from","into","image","video","post","shows","person","people"]);

function getItemTerms(id) {
  const entry = cache[id];
  const terms = [];
  const seen = new Set();
  if (entry?.category) {
    const cat = entry.category.toLowerCase().replace(/[^a-z]/g, "");
    if (cat.length >= 3 && !STOPWORDS.has(cat)) { terms.push(cat, cat, cat); seen.add(cat); }
  }
  if (entry?.topic) {
    const words = entry.topic.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(w => w.length >= 4 && !STOPWORDS.has(w));
    for (const w of words) { if (!seen.has(w)) { seen.add(w); terms.push(w); } }
  }
  return terms;
}

if (cache) {
  const ids = Object.keys(cache).filter(id => cache[id]?.vec).slice(0, 100);
  // Split into 4 fake clusters
  const clusters = [ids.slice(0, 25), ids.slice(25, 50), ids.slice(50, 75), ids.slice(75, 100)];

  const itemIDF = new Map();
  let idfCount = 0;
  for (const id of ids) {
    idfCount++;
    const seen = new Set();
    for (const t of getItemTerms(id)) { if (!seen.has(t)) { seen.add(t); itemIDF.set(t, (itemIDF.get(t) || 0) + 1); } }
  }

  const names = [];
  const usedNames = new Set();
  for (const cluster of clusters) {
    const tf = new Map();
    for (const id of cluster) for (const t of getItemTerms(id)) tf.set(t, (tf.get(t) || 0) + 1);
    const totalTerms = Array.from(tf.values()).reduce((a, b) => a + b, 0) || 1;
    const scored = [];
    for (const [term, count] of tf) {
      scored.push({ term, score: (count / totalTerms) * Math.log(1 + idfCount / (itemIDF.get(term) || 1)) });
    }
    scored.sort((a, b) => b.score - a.score);
    const topWords = scored.slice(0, 5).map(s => s.term.charAt(0).toUpperCase() + s.term.slice(1));
    let name = null;
    for (const w of topWords) { if (!usedNames.has(w.toLowerCase())) { name = w; break; } }
    if (!name) name = topWords[0] || "Group";
    usedNames.add(name.toLowerCase());
    names.push({ name, topWords });
  }

  assert("4 unique names", new Set(names.map(n => n.name)).size === 4, names.map(n => n.name).join(", "));
  assert("Names are capitalized", names.every(n => n.name[0] === n.name[0].toUpperCase()));
  assert("Names are single words", names.every(n => !n.name.includes(" ")));
  for (const n of names) {
    console.log(`  🏷️  "${n.name}" (alt: ${n.topWords.slice(1, 4).join(", ")})`);
  }
}

// ═══════════════════════════════════════════════
// TEST 5: Vault note parsing
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 5: Vault note parsing");

const sampleNotes = [];
const bookmarksDir = path.join(VAULT_PATH, "Bookmarks");
if (fs.existsSync(bookmarksDir)) {
  const findNotes = (dir, max = 5) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (sampleNotes.length >= max) return;
      if (entry.isDirectory()) findNotes(path.join(dir, entry.name), max);
      else if (entry.name.endsWith(".md")) sampleNotes.push(path.join(dir, entry.name));
    }
  };
  findNotes(bookmarksDir);
}

assert("Found sample notes", sampleNotes.length > 0, `${sampleNotes.length} found`);

for (const notePath of sampleNotes.slice(0, 3)) {
  const content = fs.readFileSync(notePath, "utf8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const hasFrontmatter = !!fmMatch;
  const hasRoostId = /roost_id:/.test(content);
  const hasPlatform = /platform:/.test(content);
  const hasAuthor = /author:/.test(content);
  const hasWikiEmbed = /!\[\[/.test(content);
  const hasInlineTags = /#\w+/.test(content.split("---").pop() || "");

  const basename = path.basename(notePath);
  assert(`${basename.slice(0, 30)}: frontmatter`, hasFrontmatter);
  assert(`${basename.slice(0, 30)}: roost_id`, hasRoostId);
  assert(`${basename.slice(0, 30)}: platform`, hasPlatform);
  assert(`${basename.slice(0, 30)}: author`, hasAuthor);

  if (hasWikiEmbed) console.log(`  📎 Has wiki embed (![[...]])`);
  if (hasInlineTags) console.log(`  🏷️  Has inline #tags`);
}

// ═══════════════════════════════════════════════
// TEST 6: Ollama connectivity
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 6: Ollama connectivity");
try {
  const res = await fetch(`${OLLAMA}/api/tags`);
  const data = await res.json();
  const models = data.models?.map(m => m.name) || [];
  assert("Ollama reachable", true);
  assert("Has nomic-embed-text", models.some(m => m.includes("nomic-embed")), models.join(", "));
  assert("Has llama3.2", models.some(m => m.includes("llama3.2")), models.join(", "));
  console.log(`  📊 Models: ${models.join(", ")}`);

  // Quick embedding test
  const embedRes = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", input: "test bookmark about cooking recipes" }),
  });
  const embedData = await embedRes.json();
  const vec = embedData.embeddings?.[0];
  assert("Embedding returned", vec && vec.length > 0, vec ? `dim=${vec.length}` : "no vector");
  if (vec) console.log(`  📊 Embedding dim: ${vec.length}, first 5: [${vec.slice(0, 5).map(v => v.toFixed(4)).join(", ")}]`);
} catch (e) {
  assert("Ollama reachable", false, e.message);
}

// ═══════════════════════════════════════════════
// TEST 7: Full mini pipeline — UMAP + HDBSCAN (200 items)
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 7: Full mini pipeline — UMAP → HDBSCAN (200 items)");

function computeCentroid(vecs) {
  const dim = vecs[0].length, avg = new Array(dim).fill(0);
  for (const v of vecs) for (let d = 0; d < dim; d++) avg[d] += v[d];
  for (let d = 0; d < dim; d++) avg[d] /= vecs.length;
  return avg;
}
function computeCohesion(vecs, c) {
  let sum = 0;
  for (const v of vecs) sum += cosineSimilarity(v, c);
  return sum / vecs.length;
}

if (cache) {
  const allIds = Object.keys(cache).filter(id => cache[id]?.vec);
  const sampleIds = allIds.slice(0, 200);
  const vectors = sampleIds.map(id => cache[id].vec);

  // Step 1: UMAP reduction
  console.log("  Running UMAP (768d → 15d)...");
  const t0 = Date.now();
  const umap = new UMAP({
    nComponents: 15,
    nNeighbors: 15,
    minDist: 0.1,
  });
  const reduced = umap.fit(vectors);
  const umapElapsed = Date.now() - t0;

  assert("UMAP output has correct count", reduced.length === 200, `got ${reduced.length}`);
  assert("UMAP output is 15d", reduced[0].length === 15, `got ${reduced[0].length}d`);
  assert("UMAP values are finite", reduced.every(v => v.every(x => isFinite(x))));
  assert("UMAP fast enough (<30s)", umapElapsed < 30000, `${umapElapsed}ms`);
  console.log(`  📊 UMAP: ${vectors.length} items, ${vectors[0].length}d → ${reduced[0].length}d in ${umapElapsed}ms`);

  // Step 2: HDBSCAN on reduced vectors
  console.log("  Running HDBSCAN on reduced vectors...");
  const t1 = Date.now();
  const hdbscan = new HDBSCAN({ minClusterSize: 10 });
  const labels = hdbscan.fit(reduced);
  const hdbscanElapsed = Date.now() - t1;

  const uniqueLabels = [...new Set(labels)];
  const clusterLabels = uniqueLabels.filter(l => l >= 0);
  const noiseCount = labels.filter(l => l === -1).length;
  const clusterCount = clusterLabels.length;

  assert("HDBSCAN labels for all items", labels.length === 200, `got ${labels.length}`);
  assert("Produced clusters", clusterCount >= 1, `${clusterCount} clusters`);
  assert("All items accounted for",
    clusterLabels.reduce((s, l) => s + labels.filter(x => x === l).length, 0) + noiseCount === 200,
    `clusters + noise != 200`);
  assert("HDBSCAN fast enough (<2s)", hdbscanElapsed < 2000, `${hdbscanElapsed}ms`);

  console.log(`  📊 HDBSCAN: ${clusterCount} clusters, ${noiseCount} noise in ${hdbscanElapsed}ms`);

  // Step 3: Compute cohesion per cluster using original 768d vectors
  for (const cl of clusterLabels.slice(0, 8)) {
    const memberIndices = labels.map((l, i) => l === cl ? i : -1).filter(i => i >= 0);
    const memberVecs = memberIndices.map(i => vectors[i]);
    const centroid = computeCentroid(memberVecs);
    const cohesion = computeCohesion(memberVecs, centroid);
    console.log(`    Cluster ${cl}: ${memberIndices.length} items, cohesion ${(cohesion * 100).toFixed(1)}%`);
  }

  console.log(`  📊 Total pipeline: ${umapElapsed + hdbscanElapsed}ms`);
}

// ═══════════════════════════════════════════════
// TEST 8: Author notes exist
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 8: Author notes");
const peoplePath = path.join(VAULT_PATH, "People");
if (fs.existsSync(peoplePath)) {
  const authors = fs.readdirSync(peoplePath).filter(f => f.endsWith(".md"));
  assert("Author notes created", authors.length > 0, `${authors.length} authors`);
  if (authors.length > 0) {
    const sample = fs.readFileSync(path.join(peoplePath, authors[0]), "utf8");
    assert("Author has frontmatter", /^---/.test(sample));
    assert("Author has handle", /handle:/.test(sample));
    console.log(`  📊 ${authors.length} author notes. Sample: ${authors[0]}`);
  }
} else {
  assert("People folder exists", false, "not found");
}

// ═══════════════════════════════════════════════
// TEST 9: Slider re-clustering — minClusterSize effect
// ═══════════════════════════════════════════════
console.log("\n🧪 Test 9: Slider re-clustering (minClusterSize effect)");

if (cache) {
  const allIds = Object.keys(cache).filter(id => cache[id]?.vec);
  const sampleIds = allIds.slice(0, 200);
  const vectors = sampleIds.map(id => cache[id].vec);

  // Reduce once (cached in production)
  const umap = new UMAP({ nComponents: 15, nNeighbors: 15, minDist: 0.1 });
  const reduced = umap.fit(vectors);

  // Cluster at different minClusterSize values
  const results = [];
  for (const mcs of [10, 20, 40]) {
    const hdbscan = new HDBSCAN({ minClusterSize: mcs });
    const labels = hdbscan.fit(reduced);
    const clusterCount = [...new Set(labels)].filter(l => l >= 0).length;
    const noiseCount = labels.filter(l => l === -1).length;
    results.push({ mcs, clusterCount, noiseCount });
    console.log(`  minClusterSize=${mcs}: ${clusterCount} clusters, ${noiseCount} noise`);
  }

  // Higher minClusterSize should generally produce fewer clusters
  // Note: noise count isn't strictly monotonic — larger minClusterSize can form fewer
  // but bigger clusters that absorb items previously labeled as noise
  assert("mcs=40 has fewer/equal clusters than mcs=10",
    results[2].clusterCount <= results[0].clusterCount,
    `mcs=10: ${results[0].clusterCount}, mcs=40: ${results[2].clusterCount}`);
  assert("Different minClusterSize produces different results",
    results[0].clusterCount !== results[2].clusterCount || results[0].noiseCount !== results[2].noiseCount,
    "all results identical");

  // Re-clustering should be fast (no UMAP re-run)
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    new HDBSCAN({ minClusterSize: 15 + i * 5 }).fit(reduced);
  }
  const elapsed = Date.now() - t0;
  assert("5x re-cluster fast enough (<2s)", elapsed < 2000, `${elapsed}ms for 5 runs`);
  console.log(`  📊 5 re-clusters on pre-reduced data: ${elapsed}ms (${(elapsed / 5).toFixed(0)}ms avg)`);
}

// ═══════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════
console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
