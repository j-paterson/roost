/**
 * Full pipeline test — Python UMAP+HDBSCAN → JS c-TF-IDF naming → purity report.
 * Runs the same naming logic as production cluster.ts.
 *
 * Usage: node test/full-pipeline.mjs [sample-size] [min-cluster-size]
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const SAMPLE_SIZE = parseInt(process.argv[2]) || 0; // 0 = all
const MIN_CLUSTER_SIZE = parseInt(process.argv[3]) || 15;
const HOME = process.env.HOME;
const VAULT_CACHE = path.join(HOME, "ObsidianBookmarks/.roost/embedding-cache.json");
const APP_CACHE = path.join(HOME, "Library/Application Support/roost-app/.embedding-cache-tiktok.json");
const PYTHON = path.join(import.meta.dirname, ".venv/bin/python3");
const SCRIPT = path.join(import.meta.dirname, "cluster-python.py");

// ── Load cache ──
const cacheFile = fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : APP_CACHE;
console.log(`Loading cache: ${cacheFile}`);
const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

// ── Run Python clustering ──
const sampleArg = SAMPLE_SIZE > 0 ? `--sample ${SAMPLE_SIZE}` : "";
console.log(`Running Python UMAP + HDBSCAN (mcs=${MIN_CLUSTER_SIZE})...\n`);
const pyResult = execSync(
  `"${PYTHON}" "${SCRIPT}" ${sampleArg} --min-cluster-size ${MIN_CLUSTER_SIZE}`,
  { maxBuffer: 500 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] }
);
const data = JSON.parse(pyResult.toString());
const ids = data.ids;
const labels = data.labels;

// ── Group items by cluster ──
const clusterMap = new Map(); // label → [id, ...]
const noiseIds = [];
for (let i = 0; i < ids.length; i++) {
  if (labels[i] === -1) {
    noiseIds.push(ids[i]);
  } else {
    if (!clusterMap.has(labels[i])) clusterMap.set(labels[i], []);
    clusterMap.get(labels[i]).push(ids[i]);
  }
}
const clusterLabels = [...clusterMap.keys()].sort((a, b) => a - b);
console.log(`\n${clusterLabels.length} clusters, ${noiseIds.length} noise items\n`);

// ── Stopwords (same as production shared.ts) ──
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
  "does","done","like","make","know","look","way","use","get","see","day",
  "image","video","post","shows","features","social","media","person","people","using","text",
  "wearing","standing","sitting","holding","near","white","black","large","small","inside",
  "indoors","outdoors","front","camera","facing","looking","surrounded","featuring","showing",
  "placed","photo","photograph","picture","view","close","shot","scene","background",
  "subject","showcases","captures","depicts","describes","discusses","highlights","presents",
  "displays","illustrates","content","creating","sharing","various","different","specific",
  "young","woman","man","user","creator","someone","individual","setting","foreground",
  "appears","shown","seen","life","personal","another","something","visible","overlay",
  "around","behind","beside","toward","along","onto","down","seems","several","together",
  "group","dark","bright","light","color","hand","hands","head","body","face","eyes","shirt",
  "backdrop","items","area","side","next","blue","green","brown","gray","pink","yellow",
  "room","floor","wall","table","door","window","surface","space","right","left","center",
  "middle","bottom",
]);

// ── Term extraction (same as production shared.ts getItemTerms) ──
function getItemTerms(id) {
  const terms = [];
  const seen = new Set();
  const entry = cache[id];
  if (!entry) return terms;

  // Priority 1: Ollama category (3x boost)
  if (entry.category) {
    const cat = entry.category.toLowerCase().replace(/[^a-z]/g, "");
    if (cat.length >= 3 && !STOPWORDS.has(cat)) { terms.push(cat, cat, cat); seen.add(cat); }
  }

  // Priority 2: Ollama topic sentence
  if (entry.topic) {
    const words = entry.topic.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w));
    for (const w of words) { if (!seen.has(w)) { seen.add(w); terms.push(w); } }
  }

  return terms;
}

// ── Build global IDF ──
const itemIDF = new Map();
let idfItemCount = 0;
for (const id of ids) {
  if (!cache[id]?.vec) continue;
  idfItemCount++;
  const seen = new Set();
  for (const t of getItemTerms(id)) {
    if (!seen.has(t)) { seen.add(t); itemIDF.set(t, (itemIDF.get(t) || 0) + 1); }
  }
}

// ── Name clusters (same logic as production cluster.ts nameAllClusters) ──
const usedNames = new Set();

function nameCluster(memberIds, ci) {
  const tf = new Map();
  for (const id of memberIds) {
    for (const t of getItemTerms(id)) tf.set(t, (tf.get(t) || 0) + 1);
  }
  const totalTerms = Array.from(tf.values()).reduce((a, b) => a + b, 0) || 1;
  const scored = [];
  for (const [term, count] of tf) {
    const tfNorm = count / totalTerms;
    const df = itemIDF.get(term) || 1;
    const idf = Math.log(1 + idfItemCount / df);
    scored.push({ term, score: tfNorm * idf });
  }
  scored.sort((a, b) => b.score - a.score);
  const topWords = scored.slice(0, 8).map(s => s.term.charAt(0).toUpperCase() + s.term.slice(1));
  const topTermsLower = scored.slice(0, 15).map(s => s.term.toLowerCase());

  // Category consensus (≥40%)
  let categoryConsensus = null;
  const catCounts = new Map();
  for (const id of memberIds) {
    const cat = cache[id]?.category;
    if (cat) catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  }
  if (catCounts.size > 0) {
    const sorted = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted[0][1] >= memberIds.length * 0.4) {
      categoryConsensus = sorted[0][0].charAt(0).toUpperCase() + sorted[0][0].slice(1);
    }
  }

  // Pick name: consensus > c-TF-IDF > combo > fallback
  let picked = null;
  if (categoryConsensus && !usedNames.has(categoryConsensus.toLowerCase())) {
    picked = categoryConsensus;
  }
  if (!picked) {
    for (const w of topWords) { if (!usedNames.has(w.toLowerCase())) { picked = w; break; } }
  }
  if (!picked && topWords.length >= 2) {
    for (let a = 0; a < topWords.length && !picked; a++) {
      for (let b = a + 1; b < topWords.length && !picked; b++) {
        const combo = `${topWords[a]} ${topWords[b]}`;
        if (!usedNames.has(combo.toLowerCase())) picked = combo;
      }
    }
  }
  if (!picked) { let n = 1; while (usedNames.has(`unnamed ${n}`)) n++; picked = `Unnamed ${n}`; }
  usedNames.add(picked.toLowerCase());

  const nameSource = categoryConsensus && picked === categoryConsensus ? "consensus"
    : "tfidf";

  return {
    name: picked,
    source: nameSource,
    altNames: [picked, ...topWords.filter(w => w !== picked)].slice(0, 6),
    topTerms: scored.slice(0, 8).map(s => s.term),
    catCounts: [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

// ── Cohesion (cosine similarity on original 768d vectors) ──
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function computeCentroid(vecs) {
  const dim = vecs[0].length, avg = new Array(dim).fill(0);
  for (const v of vecs) for (let d = 0; d < dim; d++) avg[d] += v[d];
  for (let d = 0; d < dim; d++) avg[d] /= vecs.length;
  return avg;
}

// ── Name and display all clusters ──
console.log("═══════════════════════════════════════════════");
console.log("NAMED CLUSTERS (c-TF-IDF + category consensus)");
console.log("═══════════════════════════════════════════════\n");

const results = [];
for (const cl of clusterLabels) {
  const memberIds = clusterMap.get(cl);
  const naming = nameCluster(memberIds, cl);

  // Cohesion
  const memberVecs = memberIds.filter(id => cache[id]?.vec).map(id => cache[id].vec);
  let cohesion = 1;
  if (memberVecs.length > 1) {
    const centroid = computeCentroid(memberVecs);
    let sum = 0;
    for (const v of memberVecs) sum += cosineSimilarity(v, centroid);
    cohesion = sum / memberVecs.length;
  }

  // Purity
  const topCat = naming.catCounts[0];
  const purity = topCat ? topCat[1] / memberIds.length : 0;

  results.push({
    label: cl,
    name: naming.name,
    source: naming.source,
    count: memberIds.length,
    purity,
    cohesion,
    topCategory: topCat ? topCat[0] : "(none)",
    catCounts: naming.catCounts,
    altNames: naming.altNames,
    topTerms: naming.topTerms,
  });
}

// Sort by size
results.sort((a, b) => b.count - a.count);

for (const r of results) {
  const puritySym = r.purity >= 0.5 ? "✓" : r.purity >= 0.3 ? "~" : "✗";
  console.log(`${puritySym} "${r.name}" (${r.count} items, ${r.source}) — ${r.topCategory} ${(r.purity * 100).toFixed(0)}% purity, ${(r.cohesion * 100).toFixed(1)}% cohesion`);
  console.log(`    Categories: ${r.catCounts.map(([c, n]) => `${c}(${n})`).join(", ")}`);
  console.log(`    Alt names: ${r.altNames.slice(1).join(", ")}`);
  console.log(`    Top terms: ${r.topTerms.join(", ")}`);

  // Show sample topics from this cluster
  const samples = clusterMap.get(r.label).slice(0, 3)
    .map(id => cache[id]?.topic?.slice(0, 70) || "(no topic)");
  for (const s of samples) console.log(`    → ${s}`);
  console.log();
}

// ── Summary ──
const avgPurity = results.reduce((s, r) => s + r.purity, 0) / results.length;
const avgCohesion = results.reduce((s, r) => s + r.cohesion, 0) / results.length;
const highPurity = results.filter(r => r.purity >= 0.4).length;
const clusteredItems = results.reduce((s, r) => s + r.count, 0);

console.log("═══════════════════════════════════════════════");
console.log("SUMMARY");
console.log("═══════════════════════════════════════════════");
console.log(`Total items: ${ids.length}`);
console.log(`Clustered: ${clusteredItems} (${(clusteredItems / ids.length * 100).toFixed(1)}%)`);
console.log(`Noise: ${noiseIds.length} (${(noiseIds.length / ids.length * 100).toFixed(1)}%)`);
console.log(`Clusters: ${results.length}`);
console.log(`Avg purity: ${(avgPurity * 100).toFixed(1)}%`);
console.log(`Avg cohesion: ${(avgCohesion * 100).toFixed(1)}%`);
console.log(`High purity (≥40%): ${highPurity}/${results.length} clusters`);
console.log(`Cluster sizes: ${results.map(r => r.count).join(", ")}`);

// Noise category breakdown
console.log(`\nNoise top categories:`);
const noiseCats = new Map();
for (const id of noiseIds) {
  const cat = cache[id]?.category || "(none)";
  noiseCats.set(cat, (noiseCats.get(cat) || 0) + 1);
}
for (const [cat, count] of [...noiseCats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(count).padStart(5)}  ${cat}`);
}
