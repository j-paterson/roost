/**
 * Auto-taxonomy — cluster category strings to normalize fragmented Ollama labels.
 *
 * Two-phase design for slider integration:
 * 1. embedCategories() — expensive (~14s), cached in .roost/category-embeddings.json
 * 2. clusterCategories() — cheap (<100ms), re-runs on slider change with varying epsilon
 *
 * Higher epsilon = more aggressive merging (broad). Lower = granular (specific).
 */
import { HDBSCAN } from "hdbscan-ts";
import { Vault } from "obsidian";
import type { EmbeddingCacheEntry } from "@/types/roost";
import type { Embedder } from "@/lib/embedder";
import { vaultBasePath } from "@/lib/vault-utils";
import { cachePath, cacheDir } from "@/lib/roost-paths";
import { EMBED_CONCURRENCY, TAXONOMY_MIN_CLUSTER_SIZE } from "@/config";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface CategoryTaxonomy {
  mapping: Record<string, string>;
  hash: string;
}

export interface CategoryEmbeddings {
  catStrings: string[];
  catVectors: number[][];
  catCounts: Record<string, number>;
  hash: string;
}

function normalizeCategory(c: string | null | undefined): string {
  return (c || "").trim().replace(/\.+$/, "").toLowerCase();
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function hashCategories(categories: string[]): string {
  const sorted = [...categories].sort();
  return crypto.createHash("md5").update(sorted.join("\n")).digest("hex");
}

function loadCategoryEmbeddings(vault: Vault): CategoryEmbeddings | null {
  const vaultPath = vaultBasePath(vault);
  const cp = cachePath(vaultPath, "category-embeddings.json");
  try {
    if (fs.existsSync(cp)) {
      return JSON.parse(fs.readFileSync(cp, "utf8"));
    }
  } catch { /* miss */ }
  return null;
}

function saveCategoryEmbeddings(vault: Vault, cache: CategoryEmbeddings): void {
  const vaultPath = vaultBasePath(vault);
  const dir = cacheDir(vaultPath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(vaultPath, "category-embeddings.json"), JSON.stringify(cache));
  } catch (e: unknown) {
    console.warn("[roost] Failed to save category embeddings cache:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Resolve a raw category string through the taxonomy.
 */
export function resolveTaxonomy(taxonomy: CategoryTaxonomy | null, rawCategory: string | null | undefined): string {
  if (!rawCategory) return "";
  const norm = normalizeCategory(rawCategory);
  if (!norm) return "";
  if (taxonomy?.mapping[norm]) return taxonomy.mapping[norm];
  return titleCase(norm);
}

/**
 * Phase 1: Embed category strings. Expensive (~14s), cached on disk.
 * Call once at pipeline start — result is reused across slider changes.
 */
export async function embedCategories(
  embeddingCache: Record<string, EmbeddingCacheEntry>,
  vault: Vault,
  onLog?: (msg: string) => void,
  embedder?: Embedder,
): Promise<CategoryEmbeddings> {
  const log = onLog || (() => {});

  // Collect and normalize all categories
  const catCountsMap = new Map<string, number>();
  for (const entry of Object.values(embeddingCache)) {
    if (!entry?.vec) continue;
    const norm = normalizeCategory(entry.category);
    if (norm) catCountsMap.set(norm, (catCountsMap.get(norm) || 0) + 1);
  }

  // Filter to categories with ≥2 occurrences
  const categories = [...catCountsMap.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  const currentHash = hashCategories(categories.map(([c]) => c));

  // Check cache
  const existing = loadCategoryEmbeddings(vault);
  if (existing && existing.hash === currentHash) {
    log(`Category embeddings cache hit (${existing.catStrings.length} categories)`);
    return {
      catStrings: existing.catStrings,
      catVectors: existing.catVectors,
      catCounts: existing.catCounts,
      hash: currentHash,
    };
  }

  log(`Embedding ${categories.length} category names (${catCountsMap.size} total unique)`);

  if (categories.length === 0) {
    return { catStrings: [], catVectors: [], catCounts: {}, hash: currentHash };
  }

  const catStrings = categories.map(([c]) => c);
  const catVectors: number[][] = [];

  for (let i = 0; i < catStrings.length; i += EMBED_CONCURRENCY) {
    const batch = catStrings.slice(i, i + EMBED_CONCURRENCY);
    const vecs = await embedder!.embed(batch);
    for (const vec of vecs) catVectors.push(vec || new Array(768).fill(0));
    if ((i + EMBED_CONCURRENCY) % 30 === 0 || i + EMBED_CONCURRENCY >= catStrings.length) {
      log(`  Embedded ${Math.min(i + EMBED_CONCURRENCY, catStrings.length)}/${catStrings.length} categories`);
    }
  }

  const catCounts: Record<string, number> = {};
  for (const [cat, count] of catCountsMap) catCounts[cat] = count;

  // Save cache
  saveCategoryEmbeddings(vault, { hash: currentHash, catStrings, catVectors, catCounts });
  log(`Category embeddings cached (${catStrings.length} categories)`);

  return { catStrings, catVectors, catCounts, hash: currentHash };
}

/**
 * Cosine similarity between two vectors.
 */
function cosSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Phase 2: Cluster pre-embedded categories with a given epsilon.
 * Cheap (<100ms), safe to re-run on every slider change.
 *
 * Epsilon controls post-HDBSCAN merging: after initial clustering,
 * any two clusters whose centroids are within (1 - epsilon) cosine
 * similarity get merged. Higher epsilon = more aggressive merging.
 */
export function clusterCategories(
  embeddings: CategoryEmbeddings,
  epsilon: number = 0,
  onLog?: (msg: string) => void,
): CategoryTaxonomy {
  const log = onLog || (() => {});
  const { catStrings, catVectors, catCounts, hash } = embeddings;

  if (catStrings.length === 0) {
    return { mapping: {}, hash };
  }

  // Step 1: Base HDBSCAN clustering
  const hdbscan = new HDBSCAN({ minClusterSize: TAXONOMY_MIN_CLUSTER_SIZE });
  const labels = hdbscan.fit(catVectors);

  // Collect cluster members
  const clusterMembers = new Map<number, number[]>(); // label → indices
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] < 0) continue;
    if (!clusterMembers.has(labels[i])) clusterMembers.set(labels[i], []);
    clusterMembers.get(labels[i])!.push(i);
  }

  const noiseCount = labels.filter(l => l < 0).length;
  log(`Taxonomy HDBSCAN: ${clusterMembers.size} clusters, ${noiseCount} noise categories (of ${catStrings.length} total)`);

  // Step 2: Post-merge clusters within epsilon distance
  // Compute centroid for each cluster, then merge pairs that are close enough
  // NOTE: we run this block even when HDBSCAN found only 1 cluster — the
  // union-merge loop becomes a no-op but the noise-absorption pass below
  // still pulls stray noise categories into that single cluster.
  if (epsilon > 0 && clusterMembers.size >= 1) {
    const clusterIds = [...clusterMembers.keys()];
    const centroids = new Map<number, number[]>();
    for (const [id, indices] of clusterMembers) {
      const dim = catVectors[0].length;
      const avg = new Array(dim).fill(0);
      for (const idx of indices) for (let d = 0; d < dim; d++) avg[d] += catVectors[idx][d];
      for (let d = 0; d < dim; d++) avg[d] /= indices.length;
      centroids.set(id, avg);
    }

    // Union-find for merging
    const parent = new Map<number, number>();
    for (const id of clusterIds) parent.set(id, id);
    function find(x: number): number {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
      return x;
    }
    function union(a: number, b: number) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    // Merge clusters whose centroids have cosine similarity > (1 - epsilon)
    const threshold = 1 - epsilon;
    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        const sim = cosSim(centroids.get(clusterIds[i])!, centroids.get(clusterIds[j])!);
        if (sim > threshold) {
          union(clusterIds[i], clusterIds[j]);
        }
      }
    }

    // Rebuild merged clusters
    const mergedClusters = new Map<number, number[]>();
    for (const [id, indices] of clusterMembers) {
      const root = find(id);
      if (!mergedClusters.has(root)) mergedClusters.set(root, []);
      mergedClusters.get(root)!.push(...indices);
    }
    clusterMembers.clear();
    for (const [root, indices] of mergedClusters) {
      clusterMembers.set(root, indices);
    }

    // Also absorb noise items that are close to a merged cluster centroid
    // Recompute centroids after merge
    const mergedCentroids = new Map<number, number[]>();
    for (const [id, indices] of clusterMembers) {
      const dim = catVectors[0].length;
      const avg = new Array(dim).fill(0);
      for (const idx of indices) for (let d = 0; d < dim; d++) avg[d] += catVectors[idx][d];
      for (let d = 0; d < dim; d++) avg[d] /= indices.length;
      mergedCentroids.set(id, avg);
    }
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] >= 0) continue; // already clustered
      let bestCluster = -1, bestSim = -Infinity;
      for (const [id, centroid] of mergedCentroids) {
        const sim = cosSim(catVectors[i], centroid);
        if (sim > bestSim) { bestSim = sim; bestCluster = id; }
      }
      if (bestSim > threshold) {
        clusterMembers.get(bestCluster)!.push(i);
        labels[i] = bestCluster; // mark as absorbed
      }
    }
  }

  // Step 3: Build mapping — most frequent category per cluster = canonical
  const mapping: Record<string, string> = {};
  const mergedGroups: { canonical: string; members: string[]; totalItems: number }[] = [];

  for (const [_, indices] of clusterMembers) {
    const members = indices.map(i => ({ cat: catStrings[i], count: catCounts[catStrings[i]] || 0 }));
    members.sort((a, b) => b.count - a.count);
    const canonical = titleCase(members[0].cat);
    for (const m of members) {
      mapping[m.cat] = canonical;
    }
    if (members.length > 1) {
      mergedGroups.push({
        canonical,
        members: members.map(m => m.cat),
        totalItems: members.reduce((sum, m) => sum + m.count, 0),
      });
    }
  }

  if (mergedGroups.length > 0) {
    mergedGroups.sort((a, b) => b.totalItems - a.totalItems);
    log(`Taxonomy merged ${mergedGroups.length} synonym groups:`);
    for (const g of mergedGroups.slice(0, 20)) {
      const others = g.members.filter(m => titleCase(m) !== g.canonical).slice(0, 5).join(", ");
      log(`  ${g.canonical} (${g.totalItems} items) ← ${others}`);
    }
    if (mergedGroups.length > 20) log(`  ... and ${mergedGroups.length - 20} more`);
  } else {
    log("Taxonomy: no synonym groups found");
  }

  // Noise → self (Title Cased)
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] < 0 && !mapping[catStrings[i]]) {
      mapping[catStrings[i]] = titleCase(catStrings[i]);
    }
  }

  // Rare categories not in the embeddings → self
  for (const cat of Object.keys(catCounts)) {
    if (!mapping[cat]) {
      mapping[cat] = titleCase(cat);
    }
  }

  return { mapping, hash };
}
