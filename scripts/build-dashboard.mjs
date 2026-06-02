#!/usr/bin/env node
/**
 * Build an interactive evaluation dashboard for Smart Assign v2.
 * Reads vault data + .roost caches, computes results across parameter ranges,
 * writes a self-contained .roost/dashboard.html.
 *
 * No Ollama calls — purely offline analysis of existing data.
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const BOOKMARKS_DIR = path.join(VAULT_PATH, "Bookmarks");

// ── Math helpers (copied from build-eval.mjs / shared.ts) ──

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
function computeCohesion(vecs, centroid) {
  if (vecs.length === 0) return 1;
  let sum = 0;
  for (const v of vecs) sum += cosineSim(v, centroid);
  return sum / vecs.length;
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
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════════════
// Phase 0: Load shared data
// ═══════════════════════════════════════════════════════════════

console.log("Phase 0: Loading data...");
const t0 = Date.now();

// Embedding cache
let cache;
try {
  cache = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "embedding-cache.json"), "utf8"));
  console.log(`  embedding-cache: ${Object.keys(cache).length} items (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.error("FATAL: Cannot load embedding-cache.json:", e.message);
  process.exit(1);
}

// Score cache
let scoreCache = {};
try {
  scoreCache = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "score-cache.json"), "utf8"));
  console.log(`  score-cache: ${Object.keys(scoreCache).length} entries`);
} catch { console.log("  score-cache: not found (Tab 1 will be empty)"); }

// Collection descriptions
let collectionDescs = {};
try {
  collectionDescs = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "collection-descriptions-contrastive.json"), "utf8"));
  console.log(`  collection-descriptions: ${Object.keys(collectionDescs).length} collections`);
} catch { console.log("  collection-descriptions: not found"); }

// NOT descriptions (llama3)
let notDescsLlama = null;
try {
  notDescsLlama = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "collection-not-descriptions-llama3-2-3b.json"), "utf8"));
  console.log(`  NOT descriptions (llama3): ${Object.keys(notDescsLlama).length} collections`);
} catch { console.log("  NOT descriptions (llama3): not found"); }

// NOT descriptions (gemma4)
let notDescsGemma = null;
try {
  notDescsGemma = JSON.parse(fs.readFileSync(path.join(ROOST_DIR, "collection-not-descriptions.json"), "utf8"));
  console.log(`  NOT descriptions (gemma4): ${Object.keys(notDescsGemma).length} collections`);
} catch { console.log("  NOT descriptions (gemma4): not found"); }

// ── Scan vault frontmatter ──
console.log("  Scanning vault frontmatter...");
const collectionItems = new Map(); // collection name → [itemIds]
const itemCoverPaths = new Map(); // itemId → absolute cover path
const itemCollections = new Map(); // itemId → collection/category name

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

      // Cover path
      const coverMatch = fm.match(/^cover:\s*"?\[\[([^\]]+)\]\]"?/m);
      if (coverMatch) {
        itemCoverPaths.set(id, path.join(VAULT_PATH, coverMatch[1]));
      }

      // Collection / category
      const collMatch = fm.match(/^collection:\s*(.+)/m);
      const catMatch = fm.match(/^roost_category:\s*(.+)/m);
      const cat = (catMatch?.[1] || collMatch?.[1])?.trim()?.replace(/^"|"$/g, "");
      if (cat && cat !== "undefined" && cat !== "null") {
        if (!collectionItems.has(cat)) collectionItems.set(cat, []);
        collectionItems.get(cat).push(id);
        itemCollections.set(id, cat);
      }
    } catch {}
  }
}
scanDir(BOOKMARKS_DIR);
console.log(`  vault: ${collectionItems.size} collections, ${itemCollections.size} assigned items`);

// Cover path fallback
function getCoverPath(id) {
  if (itemCoverPaths.has(id)) return itemCoverPaths.get(id);
  const numId = id.replace(/^tiktok:/, "");
  const fallback = path.join(BOOKMARKS_DIR, "TikTok", `tiktok-${numId}`, "cover.jpg");
  if (fs.existsSync(fallback)) return fallback;
  return "";
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: Score distribution (Tab 1)
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 1: Score distribution...");

let tab1Data = { error: null, histogram: [], thresholds: [], samples: {} };
try {
  // Parse score-cache: keys are "itemId|catHash"
  const catHashCounts = new Map();
  for (const key of Object.keys(scoreCache)) {
    const parts = key.split("|");
    if (parts.length < 2) continue;
    const hash = parts[parts.length - 1];
    catHashCounts.set(hash, (catHashCounts.get(hash) || 0) + 1);
  }

  // Find dominant catHash
  let dominantHash = "";
  let maxCount = 0;
  for (const [hash, count] of catHashCounts) {
    if (count > maxCount) { maxCount = count; dominantHash = hash; }
  }
  console.log(`  Dominant catHash: ${dominantHash} (${maxCount} entries)`);

  // Collect best-score-per-item for the dominant hash
  const bestScores = new Map(); // itemId → { cat, score, reason }
  for (const [key, val] of Object.entries(scoreCache)) {
    if (!key.endsWith("|" + dominantHash)) continue;
    if (!val || typeof val.score !== "number") continue;
    const itemId = key.slice(0, key.length - dominantHash.length - 1);
    const existing = bestScores.get(itemId);
    if (!existing || val.score > existing.score) {
      bestScores.set(itemId, { cat: val.cat, score: val.score, reason: val.reason || "" });
    }
  }

  // Histogram (0–10)
  const histogram = new Array(11).fill(0);
  for (const entry of bestScores.values()) {
    const s = Math.round(Math.max(0, Math.min(10, entry.score)));
    histogram[s]++;
  }

  // Threshold analysis
  const thresholds = [5, 6, 7, 8, 9].map(t => {
    let assigned = 0, rejected = 0;
    for (const entry of bestScores.values()) {
      if (entry.score >= t) assigned++; else rejected++;
    }
    return { threshold: t, assigned, rejected, total: assigned + rejected };
  });

  // Samples per score band
  const rng = mulberry32(42);
  const samples = {};
  for (let score = 0; score <= 10; score++) {
    const ids = [];
    for (const [itemId, entry] of bestScores) {
      if (Math.round(entry.score) === score) ids.push(itemId);
    }
    // Shuffle and take up to 30
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    samples[score] = ids.slice(0, 30).map(id => ({
      id,
      cat: bestScores.get(id).cat,
      score: bestScores.get(id).score,
      reason: bestScores.get(id).reason,
      summary: stripPreamble(cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id).slice(0, 200),
      coverPath: getCoverPath(id),
    }));
  }

  tab1Data = { error: null, histogram, thresholds, samples, dominantHash, totalItems: bestScores.size };
  console.log(`  ${bestScores.size} items scored, histogram built`);
} catch (e) {
  tab1Data.error = e.message;
  console.log(`  ERROR: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: NOT description comparison (Tab 2)
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 2: NOT descriptions...");

let tab2Data = { error: null, descriptions: {}, notDescsLlama: null, notDescsGemma: null, catHashes: [], hashDiffs: [] };
try {
  tab2Data.descriptions = collectionDescs;
  tab2Data.notDescsLlama = notDescsLlama;
  tab2Data.notDescsGemma = notDescsGemma;

  // Group score-cache entries by catHash
  const catHashCounts = new Map();
  for (const key of Object.keys(scoreCache)) {
    const parts = key.split("|");
    if (parts.length < 2) continue;
    const hash = parts[parts.length - 1];
    catHashCounts.set(hash, (catHashCounts.get(hash) || 0) + 1);
  }

  tab2Data.catHashes = [...catHashCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hash, count]) => ({ hash, count }));

  // If there are 2+ catHashes, find items scored under both and compare
  if (tab2Data.catHashes.length >= 2) {
    const hash1 = tab2Data.catHashes[0].hash;
    const hash2 = tab2Data.catHashes[1].hash;

    // Build per-item lookups for each hash
    const scores1 = new Map();
    const scores2 = new Map();
    for (const [key, val] of Object.entries(scoreCache)) {
      if (!val || typeof val.score !== "number") continue;
      const lastPipe = key.lastIndexOf("|");
      if (lastPipe < 0) continue;
      const itemId = key.slice(0, lastPipe);
      const hash = key.slice(lastPipe + 1);
      if (hash === hash1) {
        const existing = scores1.get(itemId);
        if (!existing || val.score > existing.score) scores1.set(itemId, val);
      } else if (hash === hash2) {
        const existing = scores2.get(itemId);
        if (!existing || val.score > existing.score) scores2.set(itemId, val);
      }
    }

    // Find items scored under both hashes
    const diffs = [];
    for (const [itemId, s1] of scores1) {
      const s2 = scores2.get(itemId);
      if (!s2) continue;
      const changed = s1.cat !== s2.cat || Math.abs(s1.score - s2.score) >= 2;
      if (changed) {
        diffs.push({
          id: itemId,
          hash1: { cat: s1.cat, score: s1.score, reason: (s1.reason || "").slice(0, 100) },
          hash2: { cat: s2.cat, score: s2.score, reason: (s2.reason || "").slice(0, 100) },
          summary: stripPreamble(cache[itemId]?.summary || "").slice(0, 150),
        });
      }
    }
    tab2Data.hashDiffs = diffs.slice(0, 100);
    console.log(`  ${scores1.size} items under hash1, ${scores2.size} under hash2, ${diffs.length} diffs`);
  }

  console.log(`  ${Object.keys(collectionDescs).length} descriptions loaded`);
} catch (e) {
  tab2Data.error = e.message;
  console.log(`  ERROR: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: Discovery sweep (Tab 3)
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 3: Discovery category sweep...");

let tab3Data = { error: null, categoryGroups: [], sweepResults: [], unmatchedCount: 0 };
try {
  // Find unmatched items (not in any vault collection)
  const assignedIds = new Set();
  for (const ids of collectionItems.values()) for (const id of ids) assignedIds.add(id);

  const unmatchedIds = [];
  for (const id of Object.keys(cache)) {
    if (!cache[id]?.vec) continue;
    if (assignedIds.has(id)) continue;
    unmatchedIds.push(id);
  }
  tab3Data.unmatchedCount = unmatchedIds.length;
  console.log(`  ${unmatchedIds.length} unmatched items`);

  // Group by Ollama category (same logic as discoverCategories)
  const catGroups = new Map();
  let noCat = 0;
  for (const id of unmatchedIds) {
    const rawCat = cache[id]?.category;
    if (!rawCat) { noCat++; continue; }
    const key = rawCat.replace(/[^a-zA-Z\s]/g, "").trim().replace(/^(.)/, (_, c) => c.toUpperCase());
    if (key.length < 2) { noCat++; continue; }
    if (!catGroups.has(key)) catGroups.set(key, []);
    catGroups.get(key).push(id);
  }
  console.log(`  ${catGroups.size} category groups, ${noCat} without category`);

  // Existing collection names (lowercase) for filtering
  const existingLower = new Set([...collectionItems.keys()].map(n => n.toLowerCase()));

  // Compute centroid + cohesion per group
  const rng = mulberry32(42);
  const COHESION_SAMPLE_CAP = 1000;
  const categoryGroups = [];

  for (const [name, ids] of catGroups) {
    if (existingLower.has(name.toLowerCase())) continue;

    let vecsForCohesion = ids.filter(id => cache[id]?.vec).map(id => cache[id].vec);
    if (vecsForCohesion.length < 2) continue;

    // Cap for large groups
    if (vecsForCohesion.length > COHESION_SAMPLE_CAP) {
      const sampled = [];
      const indices = [...Array(vecsForCohesion.length).keys()];
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      for (let i = 0; i < COHESION_SAMPLE_CAP; i++) sampled.push(vecsForCohesion[indices[i]]);
      vecsForCohesion = sampled;
    }

    const centroid = computeCentroid(vecsForCohesion);
    const cohesion = computeCohesion(vecsForCohesion, centroid);

    // Sample 6 items nearest to centroid
    const nearIds = ids
      .filter(id => cache[id]?.vec)
      .map(id => ({ id, sim: cosineSim(cache[id].vec, centroid) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 6);

    const samples = nearIds.map(({ id }) => ({
      id,
      summary: stripPreamble(cache[id]?.summary || cache[id]?.vision?.slice(0, 100) || id).slice(0, 200),
      coverPath: getCoverPath(id),
    }));

    categoryGroups.push({ name, count: ids.length, cohesion, samples });
  }

  // Sort by count descending
  categoryGroups.sort((a, b) => b.count - a.count);
  tab3Data.categoryGroups = categoryGroups;

  // Compute data-driven cohesion range from actual percentiles
  const allCohesions = categoryGroups.map(g => g.cohesion).sort((a, b) => a - b);
  const p10 = allCohesions[Math.floor(allCohesions.length * 0.10)] || 0;
  const p90 = allCohesions[Math.floor(allCohesions.length * 0.90)] || 1;
  // Build 5 evenly spaced steps between P10 and P90
  const cohStep = (p90 - p10) / 4;
  const derivedCohesions = Array.from({ length: 5 }, (_, i) => Math.round((p10 + cohStep * i) * 100) / 100);
  tab3Data.cohesionRange = derivedCohesions;
  console.log(`  Cohesion range: ${derivedCohesions.map(c => c.toFixed(2)).join(', ')} (P10=${p10.toFixed(3)}, P90=${p90.toFixed(3)})`);

  // Pre-compute sweep results for all (minSize × minCohesion) pairs
  const minSizes = [3, 5, 8, 10, 15];
  const minCohesions = derivedCohesions;

  for (const minSize of minSizes) {
    for (const minCohesion of minCohesions) {
      let passCount = 0, passItems = 0, miscItems = 0;
      for (const group of categoryGroups) {
        if (group.count >= minSize && group.cohesion >= minCohesion) {
          passCount++;
          passItems += group.count;
        } else {
          miscItems += group.count;
        }
      }
      // Also add items without category to misc
      miscItems += noCat;
      tab3Data.sweepResults.push({ minSize, minCohesion, passCount, passItems, miscItems });
    }
  }

  console.log(`  ${categoryGroups.length} candidate groups, ${minSizes.length * minCohesions.length} sweep points`);
} catch (e) {
  tab3Data.error = e.message;
  console.log(`  ERROR: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 4: Raw data sizing (Tab 4)
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 4: Raw data sizing...");

let tab4Data = { error: null, totalFiles: 0, samples: [], fieldSavings: {} };
try {
  const tiktokDir = path.join(BOOKMARKS_DIR, "TikTok");
  const rawFiles = [];

  if (fs.existsSync(tiktokDir)) {
    for (const entry of fs.readdirSync(tiktokDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("tiktok-")) continue;
      const rawPath = path.join(tiktokDir, entry.name, "raw.json");
      if (fs.existsSync(rawPath)) rawFiles.push(rawPath);
    }
  }
  tab4Data.totalFiles = rawFiles.length;
  console.log(`  ${rawFiles.length} raw.json files found`);

  // Fields to drop (common large fields that aren't used)
  const KEEP_FIELDS = new Set([
    "id", "desc", "createTime", "author", "music", "stats",
    "video", "imagePost", "contents", "textExtra",
  ]);

  // Sample 20
  const rng = mulberry32(42);
  const samplePaths = [...rawFiles];
  for (let i = samplePaths.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [samplePaths[i], samplePaths[j]] = [samplePaths[j], samplePaths[i]];
  }
  const selected = samplePaths.slice(0, 20);

  const fieldTotalSizes = {};
  let totalFull = 0, totalTrimmed = 0;

  for (const filePath of selected) {
    const raw = fs.readFileSync(filePath, "utf8");
    const fullSize = Buffer.byteLength(raw);
    totalFull += fullSize;

    try {
      const obj = JSON.parse(raw);
      // Measure each field's contribution
      for (const [key, val] of Object.entries(obj)) {
        const fieldSize = Buffer.byteLength(JSON.stringify(val));
        if (!fieldTotalSizes[key]) fieldTotalSizes[key] = { kept: 0, dropped: 0 };
        if (KEEP_FIELDS.has(key)) {
          fieldTotalSizes[key].kept += fieldSize;
        } else {
          fieldTotalSizes[key].dropped += fieldSize;
        }
      }

      // Compute trimmed size
      const trimmed = {};
      for (const key of KEEP_FIELDS) {
        if (key in obj) trimmed[key] = obj[key];
      }
      const trimmedSize = Buffer.byteLength(JSON.stringify(trimmed));
      totalTrimmed += trimmedSize;

      const dirName = path.basename(path.dirname(filePath));
      tab4Data.samples.push({
        id: dirName,
        fullSize,
        trimmedSize,
        savings: ((1 - trimmedSize / fullSize) * 100).toFixed(1),
      });
    } catch {}
  }

  // Project total savings
  const avgSavingsRatio = totalFull > 0 ? totalTrimmed / totalFull : 1;
  tab4Data.projectedFullMB = (rawFiles.length * (totalFull / selected.length) / 1024 / 1024).toFixed(1);
  tab4Data.projectedTrimmedMB = (rawFiles.length * (totalTrimmed / selected.length) / 1024 / 1024).toFixed(1);
  tab4Data.avgSavingsPercent = ((1 - avgSavingsRatio) * 100).toFixed(1);

  // Field savings breakdown
  tab4Data.fieldSavings = Object.entries(fieldTotalSizes)
    .map(([field, sizes]) => ({ field, ...sizes, total: sizes.kept + sizes.dropped }))
    .sort((a, b) => b.dropped - a.dropped);

  console.log(`  Sample: ${(totalFull / 1024).toFixed(0)}KB full → ${(totalTrimmed / 1024).toFixed(0)}KB trimmed (${tab4Data.avgSavingsPercent}% savings)`);
} catch (e) {
  tab4Data.error = e.message;
  console.log(`  ERROR: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 5: Script inventory (Tab 5)
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 5: Script inventory...");

let tab5Data = { error: null, scripts: [] };
try {
  const scriptDir = path.join(path.dirname(new URL(import.meta.url).pathname), ".");
  const scriptMeta = [
    { name: "build-eval.mjs", desc: "Build HTML evaluation page for 20 test items", tag: "eval", v2: false },
    { name: "build-dashboard.mjs", desc: "Build interactive parameter sweep dashboard", tag: "eval", v2: true },
    { name: "bench-llm-baseline.mjs", desc: "Benchmark baseline LLM scoring (no descriptions)", tag: "bench", v2: false },
    { name: "bench-llm-contrastive.mjs", desc: "Benchmark contrastive description scoring", tag: "bench", v2: true },
    { name: "bench-llm-described.mjs", desc: "Benchmark described-collection scoring", tag: "bench", v2: false },
    { name: "bench-scored.mjs", desc: "Benchmark score-first pipeline end-to-end", tag: "bench", v2: true },
    { name: "bench-strategies.mjs", desc: "Compare all scoring strategies on test set", tag: "bench", v2: false },
    { name: "benchmark.mjs", desc: "Full benchmark suite with multiple metrics", tag: "bench", v2: false },
    { name: "check-neighbors.mjs", desc: "Inspect bidirectional neighbor relationships", tag: "eval", v2: true },
    { name: "embed-compare.mjs", desc: "Compare embedding models and configs", tag: "eval", v2: false },
    { name: "fill-categories.mjs", desc: "Fill missing Ollama category labels in cache", tag: "data-prep", v2: false },
    { name: "fill-frames.mjs", desc: "Extract video frames for vision embedding", tag: "data-prep", v2: false },
    { name: "fill-subtitles.mjs", desc: "Transcribe audio to subtitles with Whisper", tag: "data-prep", v2: false },
    { name: "fill-vision.mjs", desc: "Fill missing vision descriptions in cache", tag: "data-prep", v2: false },
    { name: "fill-whisper.mjs", desc: "Fill missing Whisper transcriptions", tag: "data-prep", v2: false },
    { name: "fix-thumbnails.mjs", desc: "Repair broken thumbnail images", tag: "util", v2: false },
    { name: "migrate-eagle.mjs", desc: "Migrate from Eagle library format", tag: "util", v2: false },
    { name: "normalize-folders.mjs", desc: "Normalize folder names across vault", tag: "util", v2: false },
    { name: "oembed-backfill.mjs", desc: "Backfill oEmbed data for bookmarks", tag: "data-prep", v2: false },
    { name: "param-sweep.mjs", desc: "Parameter sweep for clustering configs", tag: "eval", v2: false },
    { name: "re-embed.mjs", desc: "Re-embed items with updated model/config", tag: "data-prep", v2: false },
    { name: "refresh-frontmatter.mjs", desc: "Refresh vault frontmatter from raw data", tag: "util", v2: false },
    { name: "regen-descriptions.mjs", desc: "Regenerate contrastive collection descriptions", tag: "pipeline", v2: true },
    { name: "regen-nots-only.mjs", desc: "Regenerate per-neighbor NOT descriptions", tag: "pipeline", v2: true },
    { name: "reset-all.mjs", desc: "Reset all assigned categories in vault", tag: "util", v2: false },
    { name: "reset-categories.mjs", desc: "Reset Ollama category labels", tag: "util", v2: false },
    { name: "strip-preambles.mjs", desc: "Strip vision preambles from cache entries", tag: "data-prep", v2: false },
    { name: "test-embed-configs.mjs", desc: "Test different embedding configurations", tag: "eval", v2: false },
    { name: "test-scoring.mjs", desc: "Test score-first pipeline on sample items", tag: "eval", v2: true },
    { name: "test-strategies.mjs", desc: "Test classification strategies on sample set", tag: "eval", v2: false },
    { name: "visualize-clusters.mjs", desc: "Generate cluster visualization HTML", tag: "eval", v2: false },
    { name: "whisper-worker.py", desc: "Whisper transcription worker process", tag: "data-prep", v2: false },
  ];

  for (const meta of scriptMeta) {
    const filePath = path.join(scriptDir, meta.name);
    try {
      const stat = fs.statSync(filePath);
      tab5Data.scripts.push({
        ...meta,
        mtime: stat.mtime.toISOString().slice(0, 10),
        size: (stat.size / 1024).toFixed(1),
      });
    } catch {
      // Script listed but not found (deleted)
    }
  }
  console.log(`  ${tab5Data.scripts.length} scripts inventoried`);
} catch (e) {
  tab5Data.error = e.message;
  console.log(`  ERROR: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 5.5: Strategy comparison (Tab 6)
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 5.5: Strategy results...");

let tab6Data = { error: null, available: false };
try {
  const stratPath = path.join(ROOST_DIR, "strategy-results.json");
  if (fs.existsSync(stratPath)) {
    const raw = JSON.parse(fs.readFileSync(stratPath, "utf8"));
    tab6Data = { ...raw, available: true, error: null };

    // Add cover paths for test items
    if (tab6Data.testItems) {
      for (const item of tab6Data.testItems) {
        item.coverPath = getCoverPath(item.id);
      }
    }
    console.log(`  Loaded: ${raw.strategies?.length} strategies, ${raw.testSize} test items (${raw.generated})`);
  } else {
    console.log("  strategy-results.json not found — run: node scripts/test-strategies.mjs");
  }
} catch (e) {
  tab6Data.error = e.message;
  console.log(`  ERROR: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 6: Write HTML
// ═══════════════════════════════════════════════════════════════

console.log("\nPhase 6: Writing HTML...");

const DASHBOARD_DATA = {
  generated: new Date().toISOString(),
  tab1: tab1Data,
  tab2: tab2Data,
  tab3: tab3Data,
  tab4: tab4Data,
  tab5: tab5Data,
  tab6: tab6Data,
};

// Strip vecs from any data that might reference them (shouldn't be any, but safety)
const dataJson = JSON.stringify(DASHBOARD_DATA, (key, value) => {
  if (key === "vec" && Array.isArray(value) && value.length > 100) return undefined;
  return value;
});

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Smart Assign v2 — Evaluation Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #e0e0e0; }

  /* ── Tab bar ── */
  .tab-bar { display: flex; background: #0f3460; padding: 0 20px; position: sticky; top: 0; z-index: 100; }
  .tab-btn { padding: 14px 20px; cursor: pointer; color: #8888aa; border: none; background: none; font-size: 14px; font-weight: 600; border-bottom: 3px solid transparent; transition: all 0.2s; }
  .tab-btn:hover { color: #ccc; }
  .tab-btn.active { color: #4ea8de; border-bottom-color: #4ea8de; }
  .tab-content { display: none; padding: 24px; max-width: 1400px; margin: 0 auto; }
  .tab-content.active { display: block; }

  /* ── Common ── */
  h2 { color: #fff; margin-bottom: 16px; font-size: 22px; }
  h3 { color: #ccc; margin: 20px 0 12px; font-size: 16px; }
  .error-banner { background: #5a2d0c; border: 1px solid #f97316; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; color: #fed7aa; }
  .warning-banner { background: #5a4d0c; border: 1px solid #eab308; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; color: #fef3c7; }
  .callout { background: #16213e; border-left: 4px solid #4ea8de; padding: 14px 18px; border-radius: 0 10px 10px 0; margin-bottom: 20px; line-height: 1.6; }
  .callout strong { color: #4ea8de; }
  .callout .rec { color: #4ade80; font-weight: 600; }
  .stat-bar { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { background: #16213e; padding: 16px 24px; border-radius: 10px; min-width: 140px; }
  .stat-value { font-size: 28px; font-weight: bold; color: #4ea8de; }
  .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; padding: 10px 12px; color: #4ea8de; border-bottom: 2px solid #333; font-size: 13px; }
  td { padding: 10px 12px; border-bottom: 1px solid #262640; font-size: 14px; }
  tr:hover td { background: #1a1a3e; }
  code { background: #0a0a1a; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .inline-bar { display: inline-block; height: 14px; border-radius: 3px; vertical-align: middle; margin-right: 6px; min-width: 2px; }
  .delta-up { color: #4ade80; font-size: 12px; }
  .delta-down { color: #f87171; font-size: 12px; }
  .delta-neutral { color: #888; font-size: 12px; }

  /* ── Tab 1: Score ── */
  .histogram { display: flex; align-items: flex-end; gap: 4px; height: 200px; margin: 20px 0; padding: 0 10px; }
  .hist-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .hist-bar { width: 100%; min-width: 30px; border-radius: 4px 4px 0 0; transition: all 0.3s; position: relative; cursor: pointer; }
  .hist-bar .count { position: absolute; top: -20px; width: 100%; text-align: center; font-size: 11px; color: #aaa; }
  .hist-label { margin-top: 6px; font-size: 12px; color: #888; }
  .threshold-line { position: absolute; left: 0; right: 0; height: 2px; background: #f97316; z-index: 10; pointer-events: none; }
  .slider-row { display: flex; align-items: center; gap: 16px; margin: 16px 0; }
  .slider-row input[type=range] { flex: 1; max-width: 400px; accent-color: #4ea8de; }
  .slider-row .val { font-size: 18px; font-weight: bold; color: #4ea8de; min-width: 30px; }
  .sample-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .sample-card { background: #16213e; border-radius: 10px; overflow: hidden; }
  .sample-card img { width: 100%; height: 160px; object-fit: cover; background: #0a0a1a; }
  .sample-card .info { padding: 10px 12px; }
  .sample-card .cat { font-size: 12px; color: #4ea8de; font-weight: 600; }
  .sample-card .score-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; margin-left: 6px; }
  .sample-card .summary { font-size: 13px; color: #bbb; margin-top: 4px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .sample-card .reason { font-size: 11px; color: #777; margin-top: 4px; font-style: italic; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  /* ── Tab 2: NOTs ── */
  .accordion { margin-bottom: 8px; }
  .accordion-header { background: #16213e; padding: 12px 16px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
  .accordion-header:hover { background: #1a1a3e; }
  .accordion-header .name { font-weight: 600; color: #e0e0e0; }
  .accordion-header .arrow { color: #666; transition: transform 0.2s; }
  .accordion-header.open .arrow { transform: rotate(90deg); }
  .accordion-body { display: none; padding: 12px 16px; background: #0f1a30; border-radius: 0 0 8px 8px; margin-top: -4px; }
  .accordion-body.open { display: block; }
  .desc-text { color: #aaa; font-size: 13px; line-height: 1.6; margin-bottom: 8px; }
  .not-row { display: flex; gap: 8px; margin: 4px 0; font-size: 13px; }
  .not-label { color: #f97316; font-weight: 600; min-width: 120px; }
  .not-phrase { color: #999; }

  /* ── Tab 3: Discovery ── */
  .dual-slider { display: flex; gap: 32px; flex-wrap: wrap; margin: 16px 0; }
  .dual-slider .slider-group { flex: 1; min-width: 200px; }
  .dual-slider label { font-size: 13px; color: #888; display: block; margin-bottom: 4px; }
  .category-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .cat-card { background: #16213e; border-radius: 10px; padding: 14px; transition: opacity 0.3s; }
  .cat-card.dimmed { opacity: 0.35; }
  .cat-card .cat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .cat-card .cat-name { font-weight: 600; color: #e0e0e0; font-size: 15px; }
  .cat-card .cat-count { color: #888; font-size: 13px; }
  .cohesion-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; }
  .cohesion-high { background: #065f46; color: #6ee7b7; }
  .cohesion-mid { background: #78350f; color: #fde68a; }
  .cohesion-low { background: #7f1d1d; color: #fca5a5; }
  .cat-card .thumb-strip { display: flex; gap: 4px; margin-top: 8px; }
  .cat-card .thumb-strip img { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; background: #0a0a1a; }
  .cat-card .dim-reason { font-size: 11px; color: #777; margin-top: 4px; font-style: italic; }

  /* ── Tab 4: Raw data ── */
  .savings-hero { display: flex; gap: 24px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
  .savings-hero .big-num { font-size: 48px; font-weight: bold; color: #4ade80; }
  .savings-hero .big-label { font-size: 14px; color: #888; }

  /* ── Tab 5: Scripts ── */
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .tag-pipeline { background: #1e3a5f; color: #7dd3fc; }
  .tag-eval { background: #3b1f5e; color: #c4b5fd; }
  .tag-bench { background: #1f3d1f; color: #86efac; }
  .tag-data-prep { background: #5a3d0c; color: #fde68a; }
  .tag-util { background: #3d3d3d; color: #d4d4d4; }
  .v2-badge { display: inline-block; padding: 2px 6px; border-radius: 6px; font-size: 10px; font-weight: 700; background: #4ea8de; color: #0a0a1a; margin-left: 6px; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn { padding: 6px 14px; border-radius: 20px; border: 1px solid #333; background: none; color: #888; cursor: pointer; font-size: 12px; }
  .filter-btn.active { background: #16213e; color: #4ea8de; border-color: #4ea8de; }

  /* ── Tab 6: Strategy ── */
  .strat-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .strat-table th { position: sticky; top: 50px; background: #1a1a2e; z-index: 5; }
  .strat-table td { padding: 8px 10px; text-align: center; }
  .strat-table td:first-child, .strat-table th:first-child { text-align: left; }
  .strat-winner { background: #065f46 !important; }
  .pick-correct { color: #4ade80; }
  .pick-wrong { color: #f87171; }
  .pick-nomatch { color: #666; font-style: italic; }
  .pick-fail { color: #555; }
  .item-row { cursor: pointer; }
  .item-row:hover td { background: #1a1a3e; }
  .item-detail { display: none; background: #0f1a30; }
  .item-detail td { padding: 12px 16px; text-align: left; }
  .detail-grid { display: grid; grid-template-columns: 80px 1fr; gap: 12px; }
  .detail-grid img { width: 80px; height: 142px; object-fit: cover; border-radius: 6px; background: #0a0a1a; }
  .detail-picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 6px; font-size: 12px; }
  .detail-pick { background: #16213e; padding: 6px 10px; border-radius: 6px; }
  .detail-pick .strat-label { color: #888; font-size: 10px; }
</style>
</head>
<body>

<div class="tab-bar">
  <button class="tab-btn active" onclick="switchTab('tab1')">Score Threshold</button>
  <button class="tab-btn" onclick="switchTab('tab2')">NOT Descriptions</button>
  <button class="tab-btn" onclick="switchTab('tab3')">Discovery</button>
  <button class="tab-btn" onclick="switchTab('tab4')">Raw Data Size</button>
  <button class="tab-btn" onclick="switchTab('tab5')">Script Inventory</button>
  <button class="tab-btn" onclick="switchTab('tab6')">Strategy Comparison</button>
</div>

<!-- ═══ Tab 1: Score Threshold ═══ -->
<div class="tab-content active" id="tab1">
  <h2>Score Threshold Analysis</h2>
  <div id="tab1-content"></div>
</div>

<!-- ═══ Tab 2: NOT Descriptions ═══ -->
<div class="tab-content" id="tab2">
  <h2>NOT Description Analysis</h2>
  <div id="tab2-content"></div>
</div>

<!-- ═══ Tab 3: Discovery ═══ -->
<div class="tab-content" id="tab3">
  <h2>Category Discovery Sweep</h2>
  <div id="tab3-content"></div>
</div>

<!-- ═══ Tab 4: Raw Data Size ═══ -->
<div class="tab-content" id="tab4">
  <h2>Raw Data Size Analysis</h2>
  <div id="tab4-content"></div>
</div>

<!-- ═══ Tab 5: Script Inventory ═══ -->
<div class="tab-content" id="tab5">
  <h2>Script Inventory</h2>
  <div id="tab5-content"></div>
</div>

<!-- ═══ Tab 6: Strategy Comparison ═══ -->
<div class="tab-content" id="tab6">
  <h2>Strategy Comparison</h2>
  <div id="tab6-content"></div>
</div>

<script>
const D = ${dataJson};

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', b.getAttribute('onclick').includes(id)));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === id));
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function scoreBg(score) {
  if (score >= 8) return '#065f46';
  if (score >= 6) return '#78350f';
  if (score >= 4) return '#7f1d1d';
  return '#4a1111';
}
function scoreColor(score) {
  if (score >= 8) return '#6ee7b7';
  if (score >= 6) return '#fde68a';
  if (score >= 4) return '#fca5a5';
  return '#f87171';
}

// ═══ Tab 1: Score Threshold ═══

function renderTab1() {
  const t = D.tab1;
  const el = document.getElementById('tab1-content');
  if (t.error) { el.innerHTML = '<div class="error-banner">'+esc(t.error)+'</div>'; return; }

  const maxCount = Math.max(...t.histogram, 1);

  // Dynamic callout — summarize the key tradeoff
  const t7 = t.thresholds.find(r => r.threshold === 7);
  const t6 = t.thresholds.find(r => r.threshold === 6);
  const t8 = t.thresholds.find(r => r.threshold === 8);
  let html = '<div class="callout">At threshold <strong>7</strong> (current default): <strong>'+t7.assigned+'</strong> items assigned, <strong>'+t7.rejected+'</strong> rejected.';
  if (t6 && t8) {
    html += ' Dropping to 6 adds <span class="delta-up">+' + (t6.assigned - t7.assigned) + '</span> items. Raising to 8 removes <span class="delta-down">-' + (t7.assigned - t8.assigned) + '</span> items.';
  }
  html += ' <em style="color:#888">Click histogram bars below to inspect items at each score level.</em></div>';

  html += '<div class="stat-bar">';
  html += '<div class="stat"><div class="stat-value">'+t.totalItems+'</div><div class="stat-label">Items Scored</div></div>';
  html += '<div class="stat"><div class="stat-value" style="font-size:16px">'+t.dominantHash+'</div><div class="stat-label">Active catHash</div></div>';
  html += '</div>';

  // Histogram
  html += '<h3>Score Distribution</h3>';
  html += '<div class="histogram">';
  for (let i = 0; i <= 10; i++) {
    const h = Math.max(2, (t.histogram[i] / maxCount) * 180);
    const barColor = i >= 7 ? '#4ade80' : i >= 5 ? '#fbbf24' : '#f87171';
    html += '<div class="hist-bar-wrap"><div class="hist-bar" style="height:'+h+'px;background:'+barColor+'" data-score="'+i+'" onclick="showScoreSamples('+i+')"><span class="count">'+t.histogram[i]+'</span></div><div class="hist-label">'+i+'</div></div>';
  }
  html += '</div>';

  // Threshold slider
  html += '<div class="slider-row"><span style="color:#888">Threshold:</span><input type="range" min="5" max="9" value="7" id="threshold-slider" oninput="updateThreshold(this.value)"><span class="val" id="threshold-val">7</span></div>';

  // Threshold comparison table with inline bars
  const maxAssigned = Math.max(...t.thresholds.map(r => r.assigned), 1);
  html += '<table id="threshold-table"><tr><th>Threshold</th><th>Assigned</th><th>Rejected</th><th>% Assigned</th><th style="min-width:200px"></th></tr>';
  for (let ti = 0; ti < t.thresholds.length; ti++) {
    const row = t.thresholds[ti];
    const pct = row.total > 0 ? (row.assigned / row.total * 100).toFixed(1) : '0';
    const barW = (row.assigned / maxAssigned * 100).toFixed(0);
    const prevRow = ti > 0 ? t.thresholds[ti - 1] : null;
    const delta = prevRow ? row.assigned - prevRow.assigned : 0;
    const deltaStr = delta !== 0 ? ' <span class="'+(delta > 0 ? 'delta-up' : 'delta-down')+'">'+(delta > 0 ? '+' : '')+delta+'</span>' : '';
    html += '<tr data-thresh="'+row.threshold+'"'+(row.threshold===7?' style="background:#1a1a3e"':'')+'><td>'+row.threshold+'</td><td>'+row.assigned+deltaStr+'</td><td>'+row.rejected+'</td><td>'+pct+'%</td>';
    html += '<td><span class="inline-bar" style="width:'+barW+'%;background:'+(row.threshold >= 7 ? '#4ade80' : '#fbbf24')+'"></span></td></tr>';
  }
  html += '</table>';

  // Sample area
  html += '<h3 id="sample-heading">Click a histogram bar to see samples</h3>';
  html += '<div class="sample-grid" id="score-samples"></div>';

  el.innerHTML = html;
}

function updateThreshold(val) {
  document.getElementById('threshold-val').textContent = val;
  document.querySelectorAll('#threshold-table tr[data-thresh]').forEach(tr => {
    tr.style.background = parseInt(tr.dataset.thresh) === parseInt(val) ? '#1a1a3e' : '';
  });
}

function showScoreSamples(score) {
  const samples = D.tab1.samples[score] || [];
  document.getElementById('sample-heading').textContent = 'Score ' + score + ' samples (' + samples.length + ' shown)';
  const grid = document.getElementById('score-samples');
  grid.innerHTML = samples.map(s =>
    '<div class="sample-card">'
    + (s.coverPath ? '<img src="file://'+esc(s.coverPath)+'" onerror="this.style.background=\\'#333\\'">' : '<div style="height:160px;background:#0a0a1a"></div>')
    + '<div class="info"><span class="cat">'+esc(s.cat)+'</span><span class="score-badge" style="background:'+scoreBg(s.score)+';color:'+scoreColor(s.score)+'">'+s.score+'</span>'
    + '<div class="summary">'+esc(s.summary)+'</div>'
    + '<div class="reason">'+esc(s.reason)+'</div>'
    + '</div></div>'
  ).join('');
}

// ═══ Tab 2: NOT Descriptions ═══

function renderTab2() {
  const t = D.tab2;
  const el = document.getElementById('tab2-content');
  if (t.error) { el.innerHTML = '<div class="error-banner">'+esc(t.error)+'</div>'; return; }

  let html = '';

  // CatHash info
  if (t.catHashes.length > 0) {
    html += '<div class="stat-bar">';
    for (const ch of t.catHashes) {
      html += '<div class="stat"><div class="stat-value">'+ch.count+'</div><div class="stat-label">catHash '+ch.hash+'</div></div>';
    }
    html += '</div>';
  }

  // Gemma4 warning
  if (!t.notDescsGemma) {
    html += '<div class="warning-banner">gemma4 NOT descriptions not found. Run: <code>node scripts/regen-nots-only.mjs gemma4:e4b</code> to generate them for comparison.</div>';
  }

  // Diff table if available
  if (t.hashDiffs && t.hashDiffs.length > 0) {
    html += '<h3>Items with different outcomes across catHashes ('+t.hashDiffs.length+' shown)</h3>';
    html += '<table><tr><th>Item</th><th>Summary</th><th>Hash 1: Cat</th><th>Score</th><th>Hash 2: Cat</th><th>Score</th></tr>';
    for (const d of t.hashDiffs) {
      html += '<tr><td style="font-size:11px;color:#666">'+esc(d.id.slice(0,20))+'</td><td style="font-size:12px;max-width:300px">'+esc(d.summary)+'</td>';
      html += '<td>'+esc(d.hash1.cat)+'</td><td style="color:'+scoreColor(d.hash1.score)+'">'+d.hash1.score+'</td>';
      html += '<td>'+esc(d.hash2.cat)+'</td><td style="color:'+scoreColor(d.hash2.score)+'">'+d.hash2.score+'</td></tr>';
    }
    html += '</table>';
  }

  // Collection descriptions + NOT phrases
  html += '<h3>Collection Descriptions &amp; NOT Phrases</h3>';
  html += '<label style="font-size:13px;color:#888;margin-bottom:8px;display:block"><input type="checkbox" id="not-filter" onchange="filterNots()"> Show only collections with NOT data</label>';

  const collNames = Object.keys(t.descriptions || {}).sort();
  for (const name of collNames) {
    const desc = t.descriptions[name] || '';
    const llama = (t.notDescsLlama || {})[name] || {};
    const gemma = (t.notDescsGemma || {})[name] || {};
    const hasNots = Object.keys(llama).length > 0 || Object.keys(gemma).length > 0;

    html += '<div class="accordion" data-has-nots="'+hasNots+'">';
    html += '<div class="accordion-header" onclick="toggleAccordion(this)"><span class="name">'+esc(name)+'</span><span class="arrow">&#9654;</span></div>';
    html += '<div class="accordion-body">';
    html += '<div class="desc-text"><strong>Description:</strong> '+esc(desc)+'</div>';

    if (Object.keys(llama).length > 0) {
      html += '<div style="margin-top:8px"><strong style="color:#888;font-size:12px">NOT phrases (llama3):</strong>';
      for (const [nb, phrase] of Object.entries(llama)) {
        html += '<div class="not-row"><span class="not-label">NOT '+esc(nb)+':</span><span class="not-phrase">'+esc(phrase)+'</span></div>';
      }
      html += '</div>';
    }

    if (Object.keys(gemma).length > 0) {
      html += '<div style="margin-top:8px"><strong style="color:#888;font-size:12px">NOT phrases (gemma4):</strong>';
      for (const [nb, phrase] of Object.entries(gemma)) {
        html += '<div class="not-row"><span class="not-label">NOT '+esc(nb)+':</span><span class="not-phrase">'+esc(phrase)+'</span></div>';
      }
      html += '</div>';
    }

    if (!hasNots) {
      html += '<div style="color:#666;font-size:12px;font-style:italic">No NOT phrases available</div>';
    }

    html += '</div></div>';
  }

  el.innerHTML = html;
}

function toggleAccordion(header) {
  header.classList.toggle('open');
  header.nextElementSibling.classList.toggle('open');
}

function filterNots() {
  const onlyWithNots = document.getElementById('not-filter').checked;
  document.querySelectorAll('.accordion').forEach(a => {
    if (onlyWithNots && a.dataset.hasNots === 'false') a.style.display = 'none';
    else a.style.display = '';
  });
}

// ═══ Tab 3: Discovery ═══

function renderTab3() {
  const t = D.tab3;
  const el = document.getElementById('tab3-content');
  if (t.error) { el.innerHTML = '<div class="error-banner">'+esc(t.error)+'</div>'; return; }

  // Callout — explain the tradeoff
  const defaultSweep = t.sweepResults.find(s => s.minSize === 5 && Math.abs(s.minCohesion - (t.cohesionRange || [])[2]) < 0.01);
  let html = '<div class="callout">Discovery groups unassigned items by their Ollama category label, then filters by size and cohesion. ';
  if (defaultSweep) {
    html += 'At defaults (size=5, cohesion='+((t.cohesionRange||[])[2]||0.20).toFixed(2)+'): <strong>'+defaultSweep.passCount+'</strong> groups pass covering <strong>'+defaultSweep.passItems+'</strong> items, with <strong>'+defaultSweep.miscItems+'</strong> in misc. ';
  }
  html += 'Use the sliders to find the balance between categorization coverage and group quality.</div>';

  html += '<div class="stat-bar">';
  html += '<div class="stat"><div class="stat-value">'+t.unmatchedCount+'</div><div class="stat-label">Unmatched Items</div></div>';
  html += '<div class="stat"><div class="stat-value">'+t.categoryGroups.length+'</div><div class="stat-label">Category Groups</div></div>';
  html += '</div>';

  // Dual sliders
  html += '<div class="dual-slider">';
  html += '<div class="slider-group"><label>MIN_CATEGORY_SIZE: <strong id="size-val">5</strong></label>';
  html += '<input type="range" min="0" max="4" value="1" id="size-slider" oninput="updateDiscovery()" style="width:100%;accent-color:#4ea8de"><div style="display:flex;justify-content:space-between;font-size:11px;color:#666"><span>3</span><span>5</span><span>8</span><span>10</span><span>15</span></div></div>';
  const cRange = D.tab3.cohesionRange || [0.10, 0.15, 0.20, 0.25, 0.30];
  html += '<div class="slider-group"><label>MIN_DISCOVERY_COHESION: <strong id="cohesion-val">'+cRange[2].toFixed(2)+'</strong></label>';
  html += '<input type="range" min="0" max="4" value="2" id="cohesion-slider" oninput="updateDiscovery()" style="width:100%;accent-color:#4ea8de"><div style="display:flex;justify-content:space-between;font-size:11px;color:#666">'+cRange.map(c => '<span>'+c.toFixed(2)+'</span>').join('')+'</div></div>';
  html += '</div>';

  // Stats bar (updated by JS)
  html += '<div class="stat-bar" id="discovery-stats"></div>';

  // Toggle dimmed
  html += '<label style="font-size:13px;color:#888;margin-bottom:12px;display:block"><input type="checkbox" id="show-dropped" onchange="updateDiscovery()" checked> Show dropped groups (dimmed)</label>';

  // Category cards
  html += '<div class="category-grid" id="category-grid"></div>';

  el.innerHTML = html;
  updateDiscovery();
}

const SIZE_VALUES = [3, 5, 8, 10, 15];
const COHESION_VALUES = D.tab3.cohesionRange || [0.10, 0.15, 0.20, 0.25, 0.30];

function updateDiscovery() {
  const sizeIdx = parseInt(document.getElementById('size-slider').value);
  const cohIdx = parseInt(document.getElementById('cohesion-slider').value);
  const minSize = SIZE_VALUES[sizeIdx];
  const minCohesion = COHESION_VALUES[cohIdx];
  const showDropped = document.getElementById('show-dropped').checked;

  document.getElementById('size-val').textContent = minSize;
  document.getElementById('cohesion-val').textContent = minCohesion.toFixed(2);

  // Find matching sweep result
  const sweep = D.tab3.sweepResults.find(s => s.minSize === minSize && Math.abs(s.minCohesion - minCohesion) < 0.001);

  // Stats
  const statsEl = document.getElementById('discovery-stats');
  if (sweep) {
    statsEl.innerHTML =
      '<div class="stat"><div class="stat-value">'+sweep.passCount+'</div><div class="stat-label">Groups Pass</div></div>' +
      '<div class="stat"><div class="stat-value">'+sweep.passItems+'</div><div class="stat-label">Items Categorized</div></div>' +
      '<div class="stat"><div class="stat-value">'+sweep.miscItems+'</div><div class="stat-label">Items in Misc</div></div>';
  }

  // Render cards
  const grid = document.getElementById('category-grid');
  let cardsHtml = '';
  for (const g of D.tab3.categoryGroups) {
    const passes = g.count >= minSize && g.cohesion >= minCohesion;
    if (!passes && !showDropped) continue;

    const cohClass = g.cohesion >= 0.25 ? 'cohesion-high' : g.cohesion >= 0.15 ? 'cohesion-mid' : 'cohesion-low';
    const reason = !passes ? (g.count < minSize ? 'too small ('+g.count+' < '+minSize+')' : 'low cohesion ('+g.cohesion.toFixed(3)+' < '+minCohesion.toFixed(2)+')') : '';

    cardsHtml += '<div class="cat-card'+(passes?'':' dimmed')+'">';
    cardsHtml += '<div class="cat-header"><span class="cat-name">'+esc(g.name)+'</span><span class="cat-count">'+g.count+' items</span></div>';
    cardsHtml += '<span class="cohesion-badge '+cohClass+'">'+g.cohesion.toFixed(3)+'</span>';
    cardsHtml += '<div class="thumb-strip">';
    for (const s of g.samples) {
      cardsHtml += s.coverPath ? '<img src="file://'+esc(s.coverPath)+'" onerror="this.style.background=\\'#333\\'">' : '<div style="width:48px;height:48px;background:#0a0a1a;border-radius:6px"></div>';
    }
    cardsHtml += '</div>';
    if (reason) cardsHtml += '<div class="dim-reason">'+esc(reason)+'</div>';
    cardsHtml += '</div>';
  }
  grid.innerHTML = cardsHtml;
}

// ═══ Tab 4: Raw Data Size ═══

function renderTab4() {
  const t = D.tab4;
  const el = document.getElementById('tab4-content');
  if (t.error) { el.innerHTML = '<div class="error-banner">'+esc(t.error)+'</div>'; return; }

  let html = '<div class="savings-hero">';
  html += '<div><div class="big-num">'+t.avgSavingsPercent+'%</div><div class="big-label">Average Savings</div></div>';
  html += '<div class="stat"><div class="stat-value">'+t.totalFiles+'</div><div class="stat-label">Total raw.json Files</div></div>';
  html += '<div class="stat"><div class="stat-value">'+t.projectedFullMB+' MB</div><div class="stat-label">Projected Full Size</div></div>';
  html += '<div class="stat"><div class="stat-value">'+t.projectedTrimmedMB+' MB</div><div class="stat-label">Projected Trimmed Size</div></div>';
  html += '</div>';

  // Sample table
  html += '<h3>Sample of 20 Files</h3>';
  html += '<table><tr><th>File</th><th>Full Size</th><th>Trimmed Size</th><th>Savings</th></tr>';
  for (const s of t.samples) {
    html += '<tr><td><code>'+esc(s.id)+'</code></td><td>'+(s.fullSize/1024).toFixed(1)+' KB</td><td>'+(s.trimmedSize/1024).toFixed(1)+' KB</td><td>'+s.savings+'%</td></tr>';
  }
  html += '</table>';

  // Field breakdown
  if (t.fieldSavings && t.fieldSavings.length > 0) {
    html += '<h3>Field Size Breakdown (from sample)</h3>';
    html += '<table><tr><th>Field</th><th>Total Size</th><th>Status</th><th>Dropped Size</th></tr>';
    for (const f of t.fieldSavings) {
      const status = f.dropped > 0 ? '<span style="color:#f87171">Dropped</span>' : '<span style="color:#4ade80">Kept</span>';
      html += '<tr><td><code>'+esc(f.field)+'</code></td><td>'+(f.total/1024).toFixed(1)+' KB</td><td>'+status+'</td><td>'+(f.dropped/1024).toFixed(1)+' KB</td></tr>';
    }
    html += '</table>';
  }

  el.innerHTML = html;
}

// ═══ Tab 5: Script Inventory ═══

let activeTag = 'all';

function renderTab5() {
  const t = D.tab5;
  const el = document.getElementById('tab5-content');
  if (t.error) { el.innerHTML = '<div class="error-banner">'+esc(t.error)+'</div>'; return; }

  const tags = ['all', ...new Set(t.scripts.map(s => s.tag))];

  let html = '<div class="filter-bar">';
  for (const tag of tags) {
    html += '<button class="filter-btn'+(tag === 'all' ? ' active' : '')+'" onclick="filterScripts(\\''+tag+'\\')">'+(tag === 'all' ? 'All' : tag)+'</button>';
  }
  html += '</div>';

  html += '<table id="script-table"><tr><th>Script</th><th>Description</th><th>Tag</th><th>Modified</th><th>Size</th></tr>';
  for (const s of t.scripts) {
    const tagClass = 'tag-' + s.tag.replace(/[^a-z]/g, '-');
    html += '<tr data-tag="'+s.tag+'"><td><code>'+esc(s.name)+'</code>'+(s.v2 ? '<span class="v2-badge">v2</span>':'')+'</td>';
    html += '<td>'+esc(s.desc)+'</td>';
    html += '<td><span class="tag '+tagClass+'">'+esc(s.tag)+'</span></td>';
    html += '<td>'+s.mtime+'</td>';
    html += '<td>'+s.size+' KB</td></tr>';
  }
  html += '</table>';

  el.innerHTML = html;
}

function filterScripts(tag) {
  activeTag = tag;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase() === tag || (tag === 'all' && b.textContent === 'All')));
  document.querySelectorAll('#script-table tr[data-tag]').forEach(tr => {
    tr.style.display = (tag === 'all' || tr.dataset.tag === tag) ? '' : 'none';
  });
}

// ═══ Tab 6: Strategy Comparison ═══

function renderTab6() {
  const t = D.tab6;
  const el = document.getElementById('tab6-content');

  if (!t.available) {
    el.innerHTML = '<div class="warning-banner">Strategy results not found. Run: <code>node scripts/test-strategies.mjs</code> to generate them, then rebuild the dashboard.</div>';
    return;
  }
  if (t.error) { el.innerHTML = '<div class="error-banner">'+esc(t.error)+'</div>'; return; }

  const strats = t.strategies;
  const items = t.testItems;
  const N = items.length;

  // Find best strategy by accuracy
  let bestIdx = 0;
  for (let i = 1; i < strats.length; i++) {
    if (strats[i].accuracy > strats[bestIdx].accuracy) bestIdx = i;
  }

  // Callout — summarize the winner
  const best = strats[bestIdx];
  const embCeiling = (t.embeddingCeiling.top1 / t.embeddingCeiling.total * 100).toFixed(0);
  let html = '<div class="callout">Best strategy: <span class="rec">'+esc(best.name)+'</span> at <strong>'+best.accuracy.toFixed(0)+'% accuracy</strong> ('+best.correct+'/'+N+' correct) in '+best.elapsed+'s. ';
  html += 'Embedding ceiling (top-1 = ground truth): '+embCeiling+'%. ';
  const fast = strats.filter(s => parseFloat(s.elapsed) < 5);
  if (fast.length > 0) {
    const bestFast = fast.reduce((a, b) => a.accuracy > b.accuracy ? a : b);
    if (bestFast !== best) html += 'Fastest competitive: <strong>'+esc(bestFast.name)+'</strong> ('+bestFast.accuracy.toFixed(0)+'% in '+bestFast.elapsed+'s).';
  }
  html += '</div>';

  html += '<div class="stat-bar">';
  html += '<div class="stat"><div class="stat-value">'+N+'</div><div class="stat-label">Test Items</div></div>';
  html += '<div class="stat"><div class="stat-value">'+strats.length+'</div><div class="stat-label">Strategies</div></div>';
  html += '<div class="stat"><div class="stat-value">'+t.embeddingCeiling.top1+'/'+t.embeddingCeiling.total+'</div><div class="stat-label">Embedding Ceiling (top-1)</div></div>';
  html += '<div class="stat"><div class="stat-value">'+t.embeddingCeiling.topK+'/'+t.embeddingCeiling.total+'</div><div class="stat-label">Embedding Ceiling (top-'+t.topK+')</div></div>';
  html += '<div class="stat"><div class="stat-value" style="font-size:14px">'+t.generated.slice(0,16)+'</div><div class="stat-label">Results Generated</div></div>';
  html += '</div>';

  // Summary table with inline accuracy bars
  html += '<h3>Strategy Summary</h3>';
  html += '<table><tr><th>Strategy</th><th>Correct</th><th>Wrong</th><th>No Match</th><th>Precision</th><th>Accuracy</th><th>Time</th><th style="min-width:120px"></th></tr>';
  for (let i = 0; i < strats.length; i++) {
    const s = strats[i];
    const isBest = i === bestIdx;
    const barW = Math.max(2, s.accuracy).toFixed(0);
    const barColor = s.accuracy >= 70 ? '#4ade80' : s.accuracy >= 50 ? '#fbbf24' : '#f87171';
    html += '<tr'+(isBest ? ' class="strat-winner"' : '')+'>';
    html += '<td>'+esc(s.name)+'</td>';
    html += '<td>'+s.correct+'/'+N+'</td>';
    html += '<td>'+(s.wrong > 0 ? '<span style="color:#f87171">'+s.wrong+'</span>' : '0')+'</td>';
    html += '<td>'+s.noMatch+'</td>';
    html += '<td>'+s.precision.toFixed(0)+'%</td>';
    html += '<td style="font-weight:bold;color:'+barColor+'">'+s.accuracy.toFixed(0)+'%</td>';
    html += '<td>'+s.elapsed+'s</td>';
    html += '<td><span class="inline-bar" style="width:'+barW+'%;background:'+barColor+'"></span></td>';
    html += '</tr>';
  }
  html += '</table>';

  // Per-item detail table
  html += '<h3>Per-Item Results <span style="font-size:12px;color:#888">(click rows to expand)</span></h3>';
  html += '<table class="strat-table"><tr><th>#</th><th>Ground Truth</th><th>Summary</th>';
  for (const s of strats) {
    // Short name: just the number prefix
    const short = s.name.match(/^\\d+\\./) ? s.name.split(')')[0].split('(')[0].trim() : s.name.slice(0, 20);
    html += '<th style="font-size:11px;max-width:100px">'+esc(short)+'</th>';
  }
  html += '</tr>';

  for (let i = 0; i < N; i++) {
    const item = items[i];
    const anyWrong = strats.some(s => {
      const p = s.picks[i]?.pick;
      return p && p !== item.groundTruth && p !== 'No match' && p !== '???';
    });

    html += '<tr class="item-row" onclick="toggleItemDetail('+i+')">';
    html += '<td>'+(i+1)+'</td>';
    html += '<td style="color:#4ea8de;font-size:12px">'+esc(item.groundTruth)+'</td>';
    html += '<td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(item.summary.slice(0,60))+'</td>';
    for (const s of strats) {
      const p = s.picks[i];
      if (!p) { html += '<td>-</td>'; continue; }
      let cls = 'pick-nomatch';
      if (p.pick === item.groundTruth) cls = 'pick-correct';
      else if (p.pick === '???' ) cls = 'pick-fail';
      else if (p.pick !== 'No match') cls = 'pick-wrong';
      html += '<td class="'+cls+'" style="font-size:11px">'+esc(p.pick === item.groundTruth ? '\\u2713' : p.pick)+'</td>';
    }
    html += '</tr>';

    // Expandable detail row
    html += '<tr class="item-detail" id="detail-'+i+'"><td colspan="'+(3+strats.length)+'">';
    html += '<div class="detail-grid">';
    html += item.coverPath ? '<img src="file://'+esc(item.coverPath)+'" onerror="this.style.background=\\'#333\\'">' : '<div style="width:80px;height:142px;background:#0a0a1a;border-radius:6px"></div>';
    html += '<div>';
    html += '<div style="margin-bottom:6px"><strong>'+esc(item.summary)+'</strong></div>';
    html += '<div style="font-size:12px;color:#888;margin-bottom:8px">Ground truth: <span style="color:#4ea8de">'+esc(item.groundTruth)+'</span> | Top-1 embed: '+esc(item.top1.name)+' ('+item.top1.sim.toFixed(3)+') | GT in top-'+t.topK+': '+(item.gtInTopK ? '<span style="color:#4ade80">Yes</span>' : '<span style="color:#f87171">No</span>')+'</div>';
    html += '<div class="detail-picks">';
    for (const s of strats) {
      const p = s.picks[i];
      if (!p) continue;
      let cls = 'pick-nomatch';
      if (p.pick === item.groundTruth) cls = 'pick-correct';
      else if (p.pick !== 'No match' && p.pick !== '???') cls = 'pick-wrong';
      html += '<div class="detail-pick"><div class="strat-label">'+esc(s.name)+'</div><span class="'+cls+'">'+esc(p.pick)+'</span>';
      if (p.reason) html += ' <span style="color:#666;font-size:10px">'+esc(p.reason.slice(0,80))+'</span>';
      html += '</div>';
    }
    html += '</div></div></div>';
    html += '</td></tr>';
  }
  html += '</table>';

  // Confusion analysis (from last/best strategy)
  const focus = strats[strats.length - 1];
  const confusions = {};
  for (let i = 0; i < N; i++) {
    const gt = items[i].groundTruth;
    const pick = focus.picks[i]?.pick;
    if (pick && pick !== gt && pick !== 'No match' && pick !== '???') {
      const key = gt + ' \\u2192 ' + pick;
      confusions[key] = (confusions[key] || 0) + 1;
    }
  }
  const confSorted = Object.entries(confusions).sort((a, b) => b[1] - a[1]);
  if (confSorted.length > 0) {
    html += '<h3>Confusion Analysis ('+esc(focus.name)+')</h3>';
    html += '<table><tr><th>Misclassification</th><th>Count</th></tr>';
    for (const [pair, count] of confSorted.slice(0, 15)) {
      html += '<tr><td>'+esc(pair)+'</td><td>'+count+'</td></tr>';
    }
    html += '</table>';
  }

  el.innerHTML = html;
}

function toggleItemDetail(idx) {
  const row = document.getElementById('detail-' + idx);
  if (row) row.style.display = row.style.display === 'table-row' ? 'none' : 'table-row';
}

// ═══ Init ═══
renderTab1();
renderTab2();
renderTab3();
renderTab4();
renderTab5();
renderTab6();

document.querySelector('.tab-bar').insertAdjacentHTML('beforeend',
  '<span style="margin-left:auto;padding:14px 20px;color:#555;font-size:11px">Generated '+D.generated.slice(0,16)+'</span>');
</script>
</body>
</html>`;

const outPath = path.join(ROOST_DIR, "dashboard.html");
fs.writeFileSync(outPath, html);
console.log(`\nDone! Wrote dashboard to: ${outPath}`);
console.log(`Open in browser: file://${outPath}`);
console.log(`HTML size: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
