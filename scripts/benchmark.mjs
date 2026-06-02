#!/usr/bin/env node
/**
 * Benchmark script — evaluates clustering quality against ground truth.
 *
 * Runs the full pipeline (UMAP + HDBSCAN + bisecting k-means + c-TF-IDF naming)
 * on all embedded bookmarks and measures how well the clusters recover the 39
 * user-curated collections (2,248 items with collection tags).
 *
 * Usage:
 *   node scripts/benchmark.mjs                           # run benchmark
 *   node scripts/benchmark.mjs --compare test/prev.json  # compare to previous
 *   node scripts/benchmark.mjs --mcs 20                  # different min_cluster_size
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawn } from "child_process";

// ── Config ──

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const CACHE_PATH = path.join(ROOST_DIR, "embedding-cache.json");
const BOOKMARKS_DIR = path.join(VAULT_PATH, "Bookmarks");
const PYTHON_PATH = path.join(ROOST_DIR, "venv", "bin", "python3");
const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const CLUSTER_SCRIPT = path.join(PROJECT_DIR, "scripts", "roost-cluster.py");
const TEST_DIR = path.join(PROJECT_DIR, "test");

// ── CLI args ──

const args = process.argv.slice(2);
let MIN_CLUSTER_SIZE = 15;
let comparePath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mcs" && args[i + 1]) {
    MIN_CLUSTER_SIZE = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--compare" && args[i + 1]) {
    comparePath = args[i + 1];
    i++;
  }
}

// ── Stopwords (from src/pipeline/shared.ts) ──

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

// ── Math (reimplemented from src/pipeline/shared.ts) ──

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

function euclideanCohesion(vectors, centroid) {
  if (vectors.length === 0) return 1;
  let sumDist = 0;
  for (const v of vectors) sumDist += euclideanDistance(v, centroid);
  const avgDist = sumDist / vectors.length;
  return 1 / (1 + avgDist);
}

function computeCentroid(vectors) {
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) for (let d = 0; d < dim; d++) avg[d] += v[d];
  for (let d = 0; d < dim; d++) avg[d] /= vectors.length;
  return avg;
}

function computeCohesionCosine(vectors, centroid) {
  if (vectors.length === 0) return 1;
  let sum = 0;
  for (const v of vectors) sum += cosineSimilarity(v, centroid);
  return sum / vectors.length;
}

// ── Bisecting k-means (Euclidean, for UMAP-reduced vectors) ──

function bisectKMeans(vectors, maxIter = 30) {
  const n = vectors.length;
  const c0 = vectors[Math.floor(Math.random() * n)].slice();
  let maxDist = -1, farthest = 0;
  for (let i = 0; i < n; i++) {
    const d = euclideanDistance(vectors[i], c0);
    if (d > maxDist) { maxDist = d; farthest = i; }
  }
  const c1 = vectors[farthest].slice();
  const centroids = [c0, c1];
  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    const newAssign = new Array(n);
    for (let i = 0; i < n; i++) {
      newAssign[i] = euclideanDistance(vectors[i], centroids[0]) <= euclideanDistance(vectors[i], centroids[1]) ? 0 : 1;
    }
    let changed = false;
    for (let i = 0; i < n; i++) if (newAssign[i] !== assignments[i]) { changed = true; break; }
    assignments = newAssign;
    if (!changed) break;
    const dim = vectors[0].length;
    for (let ki = 0; ki < 2; ki++) {
      const avg = new Array(dim).fill(0);
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (assignments[i] === ki) { for (let d = 0; d < dim; d++) avg[d] += vectors[i][d]; count++; }
      }
      if (count > 0) { for (let d = 0; d < dim; d++) avg[d] /= count; centroids[ki] = avg; }
    }
  }
  return assignments;
}

function bisectingKMeansLabels(vectors, maxLeaves, minClusterSize = 5) {
  const n = vectors.length;
  if (n === 0) return [];

  const allIndices = Array.from({ length: n }, (_, i) => i);
  let leaves = [{
    indices: allIndices,
    cohesion: euclideanCohesion(allIndices.map(i => vectors[i]), computeCentroid(allIndices.map(i => vectors[i]))),
  }];

  while (leaves.length < maxLeaves) {
    let bestIdx = -1, bestPri = -Infinity;
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].indices.length < minClusterSize * 2) continue;
      if (leaves[i].cohesion >= 0.95) continue;
      const pri = leaves[i].indices.length * (1 - leaves[i].cohesion);
      if (pri > bestPri) { bestPri = pri; bestIdx = i; }
    }
    if (bestIdx === -1) break;

    const target = leaves[bestIdx];
    const subVecs = target.indices.map(i => vectors[i]);
    const assign = bisectKMeans(subVecs, 30);
    const left = [], right = [];
    for (let i = 0; i < assign.length; i++) {
      (assign[i] === 0 ? left : right).push(target.indices[i]);
    }
    if (left.length < minClusterSize || right.length < minClusterSize) break;

    const leftVecs = left.map(i => vectors[i]);
    const rightVecs = right.map(i => vectors[i]);
    leaves.splice(bestIdx, 1,
      { indices: left, cohesion: euclideanCohesion(leftVecs, computeCentroid(leftVecs)) },
      { indices: right, cohesion: euclideanCohesion(rightVecs, computeCentroid(rightVecs)) },
    );
  }

  const labels = new Array(n).fill(0);
  leaves.forEach((leaf, ci) => {
    for (const i of leaf.indices) labels[i] = ci;
  });
  return labels;
}

// ── Term extraction / naming (reimplemented from shared.ts + cluster.ts) ──

function getItemTerms(id, cache) {
  const terms = [];
  const seen = new Set();
  const entry = cache[id];

  if (entry?.category) {
    const cat = entry.category.toLowerCase().replace(/[^a-z]/g, "");
    if (cat.length >= 3 && !STOPWORDS.has(cat)) { terms.push(cat, cat, cat); seen.add(cat); }
  }
  if (entry?.summary) {
    const words = entry.summary.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w));
    for (const w of words) { if (!seen.has(w)) { seen.add(w); terms.push(w); } }
  }
  return terms;
}

function nameAllClusters(clusters, cache, itemIDF, totalItems) {
  const clusterTermFreqs = [];
  for (const cluster of clusters) {
    const tf = new Map();
    for (const id of cluster.memberIds) {
      for (const t of getItemTerms(id, cache)) tf.set(t, (tf.get(t) || 0) + 1);
    }
    clusterTermFreqs.push(tf);
  }

  const usedNames = new Set();
  const namingSources = { consensus: 0, tfidf: 0 };

  return {
    names: clusters.map((cluster, ci) => {
      const tf = clusterTermFreqs[ci];
      const totalTerms = Array.from(tf.values()).reduce((a, b) => a + b, 0) || 1;
      const scored = [];
      for (const [term, count] of tf) {
        const tfNorm = count / totalTerms;
        const df = itemIDF.get(term) || 1;
        const idf = Math.log(1 + totalItems / df);
        scored.push({ term, score: tfNorm * idf });
      }
      scored.sort((a, b) => b.score - a.score);
      const topWords = scored.slice(0, 8).map(s => s.term.charAt(0).toUpperCase() + s.term.slice(1));

      // Category consensus (>=40%)
      let categoryConsensus = null;
      const catCounts = new Map();
      for (const id of cluster.memberIds) {
        const cat = cache[id]?.category;
        if (cat) {
          const norm = cat.toLowerCase().trim();
          catCounts.set(norm, (catCounts.get(norm) || 0) + 1);
        }
      }
      if (catCounts.size > 0) {
        const sorted = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);
        const [topCat, topCount] = sorted[0];
        if (topCount >= cluster.memberIds.length * 0.4) {
          categoryConsensus = topCat.charAt(0).toUpperCase() + topCat.slice(1);
        }
      }

      let picked = null;
      let source = "tfidf";
      if (categoryConsensus && !usedNames.has(categoryConsensus.toLowerCase())) {
        picked = categoryConsensus;
        source = "consensus";
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
      if (!picked) {
        let n = 1;
        while (usedNames.has(`unnamed ${n}`)) n++;
        picked = `Unnamed ${n}`;
      }
      usedNames.add(picked.toLowerCase());
      namingSources[source] = (namingSources[source] || 0) + 1;

      return { suggestedName: picked, source };
    }),
    namingSources,
  };
}

// ── Python subprocess ──

function runPython(input, recluster = false) {
  return new Promise((resolve, reject) => {
    const tmpInput = path.join(os.tmpdir(), `roost-bench-input-${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify(input));

    const pyArgs = [CLUSTER_SCRIPT, "--input", tmpInput];
    if (recluster) pyArgs.push("--recluster");

    const proc = spawn(PYTHON_PATH, pyArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    proc.on("close", code => {
      try { fs.unlinkSync(tmpInput); } catch {}
      if (code !== 0) {
        reject(new Error(`Python failed (exit ${code}):\n${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${stdout.slice(0, 300)}`));
      }
    });
    proc.on("error", err => reject(err));
  });
}

// ── Load vault notes ──

function loadVaultNotes() {
  const collections = new Map(); // roost_id -> collection name
  const platforms = ["TikTok", "X"];
  let totalNotes = 0;

  for (const platform of platforms) {
    const dir = path.join(BOOKMARKS_DIR, platform);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      totalNotes++;
      const content = fs.readFileSync(path.join(dir, file), "utf8");

      // Parse frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];

      // Extract roost_id
      const idMatch = fm.match(/^roost_id:\s*"?([^\s"]+)"?\s*$/m);
      if (!idMatch) continue;
      const roostId = idMatch[1];

      // Extract collection from `collection:` field
      const collFieldMatch = fm.match(/^collection:\s*(.+)$/m);
      if (collFieldMatch) {
        const coll = collFieldMatch[1].trim().replace(/^["']|["']$/g, "");
        if (coll) collections.set(roostId, coll);
      }

      // Extract collection from tags list (collection/Xxx)
      const tagMatches = fm.matchAll(/^\s*-\s*collection\/(.+)$/gm);
      for (const tm of tagMatches) {
        const coll = tm[1].trim();
        if (coll) collections.set(roostId, coll);
      }
    }
  }

  return { collections, totalNotes };
}

// ── Metrics ──

function computeCollectionRecoveryF1(clusters, collectionMap) {
  // collectionMap: roost_id -> collection name
  // clusters: array of { memberIds: string[] }

  // Group items by collection
  const collGroups = new Map(); // collection name -> Set<roost_id>
  for (const [id, coll] of collectionMap) {
    if (!collGroups.has(coll)) collGroups.set(coll, new Set());
    collGroups.get(coll).add(id);
  }

  // Build reverse: roost_id -> cluster index
  const itemToCluster = new Map();
  for (let ci = 0; ci < clusters.length; ci++) {
    for (const id of clusters[ci].memberIds) {
      itemToCluster.set(id, ci);
    }
  }

  let totalF1 = 0;
  let count = 0;
  const perCollection = [];

  for (const [collName, collIds] of collGroups) {
    if (collIds.size < 3) continue; // skip tiny collections

    // Find cluster with max overlap
    const clusterOverlap = new Map(); // cluster idx -> count of matching items
    for (const id of collIds) {
      const ci = itemToCluster.get(id);
      if (ci !== undefined) {
        clusterOverlap.set(ci, (clusterOverlap.get(ci) || 0) + 1);
      }
    }

    if (clusterOverlap.size === 0) {
      perCollection.push({ collection: collName, size: collIds.size, bestCluster: -1, precision: 0, recall: 0, f1: 0 });
      count++;
      continue;
    }

    let bestCluster = -1, bestOverlap = 0;
    for (const [ci, ov] of clusterOverlap) {
      if (ov > bestOverlap) { bestOverlap = ov; bestCluster = ci; }
    }

    const clusterSize = clusters[bestCluster].memberIds.length;
    const precision = bestOverlap / clusterSize;
    const recall = bestOverlap / collIds.size;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

    perCollection.push({ collection: collName, size: collIds.size, bestCluster, precision: round4(precision), recall: round4(recall), f1: round4(f1) });
    totalF1 += f1;
    count++;
  }

  perCollection.sort((a, b) => b.f1 - a.f1);

  return {
    macroF1: round4(count > 0 ? totalF1 / count : 0),
    collectionCount: count,
    perCollection,
  };
}

function computeClusterPurity(clusters, cache) {
  let totalPurity = 0;
  const purities = [];

  for (const cluster of clusters) {
    const catCounts = new Map();
    for (const id of cluster.memberIds) {
      const cat = cache[id]?.category?.toLowerCase()?.trim() || "_unknown";
      catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
    }
    const maxCount = Math.max(...catCounts.values());
    const purity = maxCount / cluster.memberIds.length;
    purities.push(purity);
    totalPurity += purity;
  }

  return {
    mean: round4(totalPurity / clusters.length),
    median: round4(median(purities)),
    min: round4(Math.min(...purities)),
    max: round4(Math.max(...purities)),
  };
}

function computeCohesionDistribution(clusters, cache) {
  const cohesions = [];

  for (const cluster of clusters) {
    const vecs = cluster.memberIds.filter(id => cache[id]?.vec).map(id => cache[id].vec);
    if (vecs.length < 2) { cohesions.push(1); continue; }
    const centroid = computeCentroid(vecs);
    cohesions.push(computeCohesionCosine(vecs, centroid));
  }

  return {
    mean: round4(mean(cohesions)),
    median: round4(median(cohesions)),
    min: round4(Math.min(...cohesions)),
    max: round4(Math.max(...cohesions)),
  };
}

// ── Helpers ──

function round4(n) { return Math.round(n * 10000) / 10000; }

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function delta(curr, prev, higherIsBetter = true) {
  const diff = curr - prev;
  if (Math.abs(diff) < 0.0001) return "  (=)";
  const arrow = higherIsBetter ? (diff > 0 ? " ^" : " v") : (diff < 0 ? " ^" : " v");
  return `${arrow} ${diff > 0 ? "+" : ""}${round4(diff)}`;
}

// ── Compare mode ──

function showComparison(curr, prev) {
  console.log("\n========================================");
  console.log("  COMPARISON WITH PREVIOUS BENCHMARK");
  console.log("========================================\n");

  console.log(`  Previous: mcs=${prev.params.minClusterSize}, ${prev.params.totalItems} items`);
  console.log(`  Current:  mcs=${curr.params.minClusterSize}, ${curr.params.totalItems} items\n`);

  console.log("  Collection Recovery F1:  " +
    `${prev.collectionRecovery.macroF1} -> ${curr.collectionRecovery.macroF1}` +
    delta(curr.collectionRecovery.macroF1, prev.collectionRecovery.macroF1));

  console.log("  Cluster Purity (mean):  " +
    `${prev.clusterPurity.mean} -> ${curr.clusterPurity.mean}` +
    delta(curr.clusterPurity.mean, prev.clusterPurity.mean));

  console.log("  Cohesion (mean):        " +
    `${prev.cohesion.mean} -> ${curr.cohesion.mean}` +
    delta(curr.cohesion.mean, prev.cohesion.mean));

  console.log("  Noise Rate:             " +
    `${prev.noiseRate} -> ${curr.noiseRate}` +
    delta(curr.noiseRate, prev.noiseRate, false));

  console.log("  Cluster Count:          " +
    `${prev.clusterCount} -> ${curr.clusterCount}`);

  // Per-collection F1 changes
  const prevByName = new Map(prev.collectionRecovery.perCollection.map(c => [c.collection, c]));
  const changes = [];
  for (const c of curr.collectionRecovery.perCollection) {
    const p = prevByName.get(c.collection);
    if (p) {
      const diff = c.f1 - p.f1;
      if (Math.abs(diff) >= 0.01) changes.push({ collection: c.collection, prev: p.f1, curr: c.f1, diff });
    }
  }
  if (changes.length > 0) {
    changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    console.log("\n  Biggest F1 changes per collection:");
    for (const c of changes.slice(0, 10)) {
      const arrow = c.diff > 0 ? "^" : "v";
      console.log(`    ${arrow} ${c.collection}: ${c.prev} -> ${c.curr} (${c.diff > 0 ? "+" : ""}${round4(c.diff)})`);
    }
  }

  console.log("");
}

// ── Main ──

async function main() {
  const t0 = Date.now();
  console.log(`Roost Benchmark — min_cluster_size=${MIN_CLUSTER_SIZE}\n`);

  // 1. Load data
  console.log("Loading embedding cache...");
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const ids = Object.keys(cache).filter(id => cache[id]?.vec);
  console.log(`  ${ids.length} items with embeddings`);

  console.log("Loading vault notes...");
  const { collections, totalNotes } = loadVaultNotes();
  const collectionNames = new Set(collections.values());
  console.log(`  ${totalNotes} notes, ${collections.size} with collections (${collectionNames.size} categories)`);

  // 2. Run UMAP + HDBSCAN via Python
  console.log("\nRunning UMAP + HDBSCAN via Python...");
  const vectors = ids.map(id => cache[id].vec);

  const pyResult = await runPython({
    ids,
    vectors,
    min_cluster_sizes: [MIN_CLUSTER_SIZE],
  });

  const labels = pyResult.labels;
  const reduced = pyResult.reduced;
  console.log(`  UMAP: ${vectors[0].length}d -> ${reduced[0].length}d`);

  // Count HDBSCAN results
  const noiseCount = labels.filter(l => l === -1).length;
  const hdbscanClusterCount = new Set(labels.filter(l => l >= 0)).size;
  console.log(`  HDBSCAN: ${hdbscanClusterCount} clusters, ${noiseCount} noise`);

  // 3. Bisecting k-means on reduced vectors (for noise items)
  console.log("\nRunning bisecting k-means on UMAP-reduced vectors...");

  // Collect non-noise cluster members
  const hdbscanClusters = new Map(); // label -> [indices]
  const noiseIndices = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === -1) {
      noiseIndices.push(i);
    } else {
      if (!hdbscanClusters.has(labels[i])) hdbscanClusters.set(labels[i], []);
      hdbscanClusters.get(labels[i]).push(i);
    }
  }

  // Build final clusters from HDBSCAN labels
  const finalClusters = [];
  for (const [label, indices] of [...hdbscanClusters.entries()].sort((a, b) => a[0] - b[0])) {
    finalClusters.push({
      memberIds: indices.map(i => ids[i]),
      reducedVecs: indices.map(i => reduced[i]),
    });
  }

  // Optionally bisect large clusters
  const MAX_BISECT_LEAVES = 200;
  const allReducedForBisect = [];
  const allIdsForBisect = [];
  for (let i = 0; i < ids.length; i++) {
    allReducedForBisect.push(reduced[i]);
    allIdsForBisect.push(ids[i]);
  }

  const bisectLabels = bisectingKMeansLabels(allReducedForBisect, MAX_BISECT_LEAVES, MIN_CLUSTER_SIZE);
  const bisectClusters = new Map();
  for (let i = 0; i < bisectLabels.length; i++) {
    const cl = bisectLabels[i];
    if (!bisectClusters.has(cl)) bisectClusters.set(cl, []);
    bisectClusters.get(cl).push(i);
  }
  const bisectFinal = [];
  for (const [, indices] of [...bisectClusters.entries()].sort((a, b) => a[0] - b[0])) {
    bisectFinal.push({ memberIds: indices.map(i => ids[i]) });
  }
  console.log(`  Bisecting k-means: ${bisectFinal.length} clusters`);

  // We evaluate BOTH approaches and report on both
  // Primary evaluation: HDBSCAN clusters (the production pipeline)
  console.log(`\n${"=".repeat(50)}`);
  console.log("  HDBSCAN CLUSTERS");
  console.log("=".repeat(50));

  // 4. Name HDBSCAN clusters using c-TF-IDF
  console.log("\nNaming HDBSCAN clusters via c-TF-IDF...");
  const itemIDF = new Map();
  let idfCount = 0;
  for (const id of ids) {
    idfCount++;
    const terms = getItemTerms(id, cache);
    const seen = new Set();
    for (const t of terms) { if (!seen.has(t)) { seen.add(t); itemIDF.set(t, (itemIDF.get(t) || 0) + 1); } }
  }

  const { names: hdbNames, namingSources: hdbNamingSources } = nameAllClusters(finalClusters, cache, itemIDF, idfCount);
  for (let i = 0; i < finalClusters.length; i++) {
    finalClusters[i].name = hdbNames[i].suggestedName;
    finalClusters[i].nameSource = hdbNames[i].source;
  }

  // 5. Compute metrics for HDBSCAN
  console.log("\nComputing metrics...\n");

  const hdbRecovery = computeCollectionRecoveryF1(finalClusters, collections);
  const hdbPurity = computeClusterPurity(finalClusters, cache);
  const hdbCohesion = computeCohesionDistribution(finalClusters, cache);
  const hdbNoiseRate = round4(noiseCount / ids.length);

  console.log("  Collection Recovery (F1):");
  console.log(`    Macro F1:     ${hdbRecovery.macroF1}`);
  console.log(`    Collections:  ${hdbRecovery.collectionCount}`);
  console.log("");
  console.log("  Top 10 collections by F1:");
  for (const c of hdbRecovery.perCollection.slice(0, 10)) {
    console.log(`    ${c.collection.padEnd(20)} F1=${c.f1}  P=${c.precision}  R=${c.recall}  (n=${c.size})`);
  }
  console.log("  Bottom 5:");
  for (const c of hdbRecovery.perCollection.slice(-5)) {
    console.log(`    ${c.collection.padEnd(20)} F1=${c.f1}  P=${c.precision}  R=${c.recall}  (n=${c.size})`);
  }

  console.log("");
  console.log("  Cluster Purity:");
  console.log(`    Mean:    ${hdbPurity.mean}`);
  console.log(`    Median:  ${hdbPurity.median}`);
  console.log(`    Range:   ${hdbPurity.min} - ${hdbPurity.max}`);

  console.log("");
  console.log("  Cohesion (cosine, 768d):");
  console.log(`    Mean:    ${hdbCohesion.mean}`);
  console.log(`    Median:  ${hdbCohesion.median}`);
  console.log(`    Range:   ${hdbCohesion.min} - ${hdbCohesion.max}`);

  console.log("");
  console.log("  Naming Quality:");
  console.log(`    Consensus: ${hdbNamingSources.consensus}`);
  console.log(`    TF-IDF:    ${hdbNamingSources.tfidf}`);

  console.log("");
  console.log(`  Noise Rate:     ${hdbNoiseRate} (${noiseCount} / ${ids.length})`);
  console.log(`  Cluster Count:  ${finalClusters.length}`);

  // Secondary: bisecting k-means
  console.log(`\n${"=".repeat(50)}`);
  console.log("  BISECTING K-MEANS CLUSTERS");
  console.log("=".repeat(50));

  const { names: bkmNames, namingSources: bkmNamingSources } = nameAllClusters(bisectFinal, cache, itemIDF, idfCount);
  const bkmRecovery = computeCollectionRecoveryF1(bisectFinal, collections);
  const bkmPurity = computeClusterPurity(bisectFinal, cache);
  const bkmCohesion = computeCohesionDistribution(bisectFinal, cache);

  console.log(`\n  Collection Recovery F1: ${bkmRecovery.macroF1}`);
  console.log(`  Cluster Purity (mean): ${bkmPurity.mean}`);
  console.log(`  Cohesion (mean):       ${bkmCohesion.mean}`);
  console.log(`  Cluster Count:         ${bisectFinal.length}`);
  console.log(`  Naming: consensus=${bkmNamingSources.consensus} tfidf=${bkmNamingSources.tfidf}`);

  // 6. Save results
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nBenchmark completed in ${elapsed}s`);

  const results = {
    timestamp: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsed),
    params: {
      minClusterSize: MIN_CLUSTER_SIZE,
      totalItems: ids.length,
      itemsWithCollections: collections.size,
      collectionCategories: collectionNames.size,
    },
    // Primary: HDBSCAN
    collectionRecovery: hdbRecovery,
    clusterPurity: hdbPurity,
    cohesion: hdbCohesion,
    namingQuality: hdbNamingSources,
    noiseRate: hdbNoiseRate,
    noiseCount,
    clusterCount: finalClusters.length,
    // Secondary: bisecting k-means
    bisectingKMeans: {
      collectionRecovery: bkmRecovery,
      clusterPurity: bkmPurity,
      cohesion: bkmCohesion,
      namingQuality: bkmNamingSources,
      clusterCount: bisectFinal.length,
    },
  };

  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  const outPath = path.join(TEST_DIR, `benchmark-${timestamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${outPath}`);

  // 7. Compare
  if (comparePath) {
    const absPath = path.isAbsolute(comparePath) ? comparePath : path.resolve(process.cwd(), comparePath);
    if (fs.existsSync(absPath)) {
      const prev = JSON.parse(fs.readFileSync(absPath, "utf8"));
      showComparison(results, prev);
    } else {
      console.error(`\nComparison file not found: ${absPath}`);
    }
  }
}

main().catch(err => {
  console.error("\nBenchmark failed:", err.message);
  process.exit(1);
});
