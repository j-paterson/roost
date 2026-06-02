#!/usr/bin/env node
/**
 * Parameter sweep — test UMAP + HDBSCAN configurations and report metrics.
 * Runs benchmark at multiple param combos to find optimal settings.
 *
 * Usage: node scripts/param-sweep.mjs
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

// ── Load data ─────────────────────────────────────────────────

console.log("Loading data...");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

// Gather items with vectors
const orderedIds = [];
const vectors = [];
for (const [id, entry] of Object.entries(cache)) {
  if (entry.vec?.length === 768) {
    orderedIds.push(id);
    vectors.push(entry.vec);
  }
}
console.log(`${orderedIds.length} items with vectors`);

// Load ground truth (collection tags)
const collectionItems = new Map(); // collection name → Set<roost_id>
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
    // Collection from tags
    const tagSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
    if (tagSection) {
      for (const line of tagSection[1].split("\n")) {
        const t = line.match(/^\s+-\s+collection\/(.+)/);
        if (t) {
          const name = t[1].trim();
          if (!collectionItems.has(name)) collectionItems.set(name, new Set());
          collectionItems.get(name).add(id);
        }
      }
    }
    // Collection from field
    const collMatch = fm.match(/^collection:\s*"?([^\n"]+)"?/m);
    if (collMatch) {
      const name = collMatch[1].trim();
      if (!collectionItems.has(name)) collectionItems.set(name, new Set());
      collectionItems.get(name).add(id);
    }
  }
}
walkVault(path.join(VAULT_PATH, "Bookmarks"));
const gtTotal = [...collectionItems.values()].reduce((n, s) => n + s.size, 0);
console.log(`Ground truth: ${gtTotal} items in ${collectionItems.size} collections\n`);

// ── Helper: run Python clustering ─────────────────────────────

function runPython(params) {
  const inputPath = path.join(os.tmpdir(), `roost-sweep-${crypto.randomUUID()}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(params));
  try {
    const stdout = execFileSync(PYTHON, [CLUSTER_SCRIPT, "--input", inputPath], {
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 1024 * 1024 * 500,
    });
    return JSON.parse(stdout);
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
  }
}

// ── Helper: compute collection recovery F1 ────────────────────

function computeF1(labels, ids, mcs) {
  // Group items by cluster label
  const clusters = new Map();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === -1) continue;
    if (!clusters.has(label)) clusters.set(label, []);
    clusters.get(label).push(ids[i]);
  }

  const noiseCount = labels.filter(l => l === -1).length;
  const clusterCount = clusters.size;

  // For each collection, find best-matching cluster
  let f1Sum = 0, collCount = 0;
  for (const [collName, collIds] of collectionItems) {
    if (collIds.size < 3) continue;
    let bestF1 = 0;
    for (const [, clusterIds] of clusters) {
      const clusterSet = new Set(clusterIds);
      const overlap = [...collIds].filter(id => clusterSet.has(id)).length;
      if (overlap === 0) continue;
      const precision = overlap / clusterIds.length;
      const recall = overlap / collIds.size;
      const f1 = 2 * precision * recall / (precision + recall);
      if (f1 > bestF1) bestF1 = f1;
    }
    f1Sum += bestF1;
    collCount++;
  }

  return {
    f1: collCount > 0 ? f1Sum / collCount : 0,
    clusters: clusterCount,
    noise: noiseCount,
    noiseRate: noiseCount / labels.length,
  };
}

// ── Sweep configurations ──────────────────────────────────────

const configs = [
  // Vary n_neighbors (local vs global structure)
  { n_neighbors: 5,  min_dist: 0.1, n_components: 15, label: "nn=5" },
  { n_neighbors: 10, min_dist: 0.1, n_components: 15, label: "nn=10" },
  { n_neighbors: 15, min_dist: 0.1, n_components: 15, label: "nn=15 (current)" },
  { n_neighbors: 30, min_dist: 0.1, n_components: 15, label: "nn=30" },
  { n_neighbors: 50, min_dist: 0.1, n_components: 15, label: "nn=50" },

  // Vary min_dist (tighter vs looser clusters)
  { n_neighbors: 15, min_dist: 0.0,  n_components: 15, label: "md=0.0" },
  { n_neighbors: 15, min_dist: 0.05, n_components: 15, label: "md=0.05" },
  { n_neighbors: 15, min_dist: 0.2,  n_components: 15, label: "md=0.2" },
  { n_neighbors: 15, min_dist: 0.5,  n_components: 15, label: "md=0.5" },

  // Vary dimensions
  { n_neighbors: 15, min_dist: 0.1, n_components: 5,  label: "dim=5" },
  { n_neighbors: 15, min_dist: 0.1, n_components: 10, label: "dim=10" },
  { n_neighbors: 15, min_dist: 0.1, n_components: 20, label: "dim=20" },
  { n_neighbors: 15, min_dist: 0.1, n_components: 30, label: "dim=30" },

  // Promising combos
  { n_neighbors: 30, min_dist: 0.0,  n_components: 15, label: "nn=30 md=0.0" },
  { n_neighbors: 30, min_dist: 0.05, n_components: 10, label: "nn=30 md=0.05 dim=10" },
  { n_neighbors: 50, min_dist: 0.0,  n_components: 10, label: "nn=50 md=0.0 dim=10" },
];

const MCS_VALUES = [10, 15, 20, 30];

console.log(`Running ${configs.length} configurations...\n`);
console.log("Config".padEnd(30), "mcs", "F1".padStart(6), "Clusters".padStart(9), "Noise%".padStart(8));
console.log("-".repeat(70));

const results = [];

for (const config of configs) {
  try {
    // Run UMAP + HDBSCAN
    const result = runPython({
      ids: orderedIds,
      vectors,
      min_cluster_sizes: MCS_VALUES,
      umap_n_neighbors: config.n_neighbors,
      umap_min_dist: config.min_dist,
      umap_n_components: config.n_components,
    });

    for (const mcs of MCS_VALUES) {
      const labels = result.batch[String(mcs)];
      if (!labels) continue;
      const metrics = computeF1(labels, orderedIds, mcs);
      const row = {
        ...config,
        mcs,
        ...metrics,
      };
      results.push(row);
      console.log(
        config.label.padEnd(30),
        String(mcs).padStart(3),
        metrics.f1.toFixed(4).padStart(6),
        String(metrics.clusters).padStart(9),
        (metrics.noiseRate * 100).toFixed(1).padStart(7) + "%"
      );
    }
  } catch (e) {
    console.log(config.label.padEnd(30), "ERROR:", e.message?.slice(0, 50));
  }
}

// Find best config
console.log("\n" + "=".repeat(70));
const best = results.sort((a, b) => b.f1 - a.f1)[0];
console.log(`\nBest: ${best.label} mcs=${best.mcs} → F1=${best.f1.toFixed(4)} (${best.clusters} clusters, ${(best.noiseRate*100).toFixed(1)}% noise)`);

// Save results
const outPath = path.join(SCRIPT_DIR, "..", "test", `sweep-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nResults saved to ${outPath}`);
