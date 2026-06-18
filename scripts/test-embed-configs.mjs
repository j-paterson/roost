#!/usr/bin/env node
/**
 * M7 input-text ablation — test embedding text configurations with production-style centroids.
 *
 * Matches the actual pipeline's data path exactly:
 *   text = fm.title
 *   subtitle = fm.subtitle
 *   tags = fm.tags (filtered same as describe-items.ts)
 *   vision, summary, category = embedding cache
 *
 * For each variant:
 *   1. Gather ALL vault items that have a roost_category (auto OR human) and are NOT fixture ids.
 *      This is the production pool (~13K items × 6 variants).
 *   2. Build the variant's embed text for each pool item, embed via the sidecar, centroid by
 *      roost_category — producing production-style variant centroids (19 cats).
 *   3. Re-embed the fixture items per variant and score them against those centroids (top-1,
 *      per-platform tiktok/twitter split).
 *   4. Write the per-variant fixture-vector cache to .roost/build/<variant>.json so
 *      honest-eval.py --cache <variant>.json --by-platform can score it.
 *
 * ROOT CAUSE of old crash: the honest fixture covers ~100% of human `collection` labels, so
 * any pool built from collection-labeled members MINUS fixture was EMPTY → centroids empty →
 * scores[0].name on undefined. FIX: build centroids from the production pool (roost_category,
 * auto OR human), NOT from collection-minus-fixture.
 *
 * Contamination guard: fixture ids (dev ∪ holdout, all 4320) are EXCLUDED from the centroid
 * pool regardless of whether they have roost_category. GT for scoring is human collection only.
 *
 * Variant set (pre-registered, spec 2026-06-18):
 *   full            — vision + summary + category + title + subtitle  (current formula)
 *   minus-vision    — summary + category + title + subtitle  (drop vision field)
 *   minus-subtitle  — vision + summary + category + title    (drop subtitle/transcript)
 *   text-only       — title only  (raw bookmark text, no LLM-derived fields)
 *   summary-only    — summary only
 *   modality-flag   — full formula but replace absent/noisy subtitle with a flag token
 *                     rather than omitting it; marks "transcript absent/noise"
 *
 * Usage:
 *   ROOST_VAULT=<vault> node scripts/test-embed-configs.mjs [--split dev|holdout|large]
 * The fixture split controls which items are held out from centroids (default: large).
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = process.env.ROOST_VAULT
  || path.join(process.env.HOME, "SynologyDrive", "SynologyDrive", "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const BUILD_DIR = path.join(ROOST_DIR, "build");
// Sidecar (fine-tuned, port 11435) matches production. Falls back to Ollama (11434).
const SIDECAR_URL = process.env.ROOST_EMBED_URL || "http://localhost:11435";
const OLLAMA_URL  = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";

// ── Parse --split arg ──

const splitArg = (() => {
  const i = process.argv.indexOf("--split");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return "large";
})();
if (!["dev", "holdout", "large"].includes(splitArg)) {
  console.error(`--split must be dev|holdout|large, got: ${splitArg}`);
  process.exit(1);
}

// ── Resolve embed URL (sidecar first, fall back to Ollama) ──

let EMBED_URL = SIDECAR_URL;
try {
  const probe = await fetch(`${SIDECAR_URL}/health`);
  if (!probe.ok) throw new Error();
  console.log(`Embedding backend: sidecar at ${SIDECAR_URL}`);
} catch {
  EMBED_URL = OLLAMA_URL;
  console.log(`Sidecar not available; falling back to Ollama at ${OLLAMA_URL}`);
}

// ── Load embedding cache (v2 JSON) for LLM-derived fields only ──
// Only used for vision/summary/category text fields — NOT the vec, which we recompute.

let cache = {};
const cacheJsonPath = path.join(ROOST_DIR, "embedding-cache.json");
const cacheAltPath  = path.join(ROOST_DIR, "cache", "embedding-cache.json");
if (fs.existsSync(cacheJsonPath)) {
  cache = JSON.parse(fs.readFileSync(cacheJsonPath, "utf8"));
} else if (fs.existsSync(cacheAltPath)) {
  cache = JSON.parse(fs.readFileSync(cacheAltPath, "utf8"));
} else {
  console.warn("Warning: embedding-cache.json not found; vision/summary/category fields will be absent.");
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

// ── filterTags: exact match with describe-items.ts lines 305-312 ──

function filterTags(tags) {
  return tags.filter(t => {
    if (t.startsWith("@") || t.startsWith("collection:") || t.startsWith("collection/") || t.startsWith("_")) return false;
    const lower = t.toLowerCase();
    if (["tiktok", "twitter", "farcaster", "fyp", "foryou", "viral", "trending"].includes(lower)) return false;
    return true;
  });
}

// ── Parse frontmatter ──
// Extracts roost_id, title, subtitle, tags, collection (GT, human only), roost_category (pool label).

function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  // Extract roost_id
  const idMatch = fm.match(/^roost_id:\s*"?([^"\n]+)"?/m);
  if (!idMatch) return null;
  const roost_id = idMatch[1].trim();

  // Extract title
  const titleMatch = fm.match(/^title:\s*(?:"((?:[^"\\]|\\.)*)"|(.+))/m);
  const title = titleMatch ? (titleMatch[1] ?? titleMatch[2])?.trim() || "" : "";

  // Extract subtitle — long quoted string on one line
  const subMatch = fm.match(/^subtitle:\s*"((?:[^"\\]|\\.)*)"/m);
  const subtitle = subMatch?.[1] || "";

  // Extract tags — YAML array
  const tags = [];
  const tagsSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
  if (tagsSection) {
    for (const m of tagsSection[1].matchAll(/\s+-\s+(?:"([^"]*)"|(.+))/g)) {
      const t = (m[1] ?? m[2])?.trim();
      if (t) tags.push(t);
    }
  }

  // GT contamination guard: collection = human label only (NEVER roost_category for GT).
  const collMatch = fm.match(/^collection:\s*(.+)/m);
  const collection = collMatch?.[1]?.trim()?.replace(/^"|"$/g, "") || null;

  // roost_category = production auto or human category — used ONLY for centroid pool grouping.
  const rcMatch = fm.match(/^roost_category:\s*(.+)/m);
  const roost_category = rcMatch?.[1]?.trim()?.replace(/^"|"$/g, "") || null;

  return { roost_id, title, subtitle, tags, collection, roost_category };
}

// ── Scan vault ──
// Collects:
//   itemMeta:   id → { title, subtitle, tags }   (all items)
//   poolByCategory: category → [id]              (production pool: has roost_category, not in fixture)
// Fixture ids are excluded from poolByCategory AFTER the fixture is loaded.

console.log("Scanning vault...");
const itemMeta = new Map();    // id → { title, subtitle, tags }
// Temporarily store roost_category per id; we'll filter by fixture after loading it.
const itemRoostCategory = new Map(); // id → roost_category

const syncFolder = path.join(VAULT_PATH, "Bookmarks");
function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { scanDir(path.join(dir, entry.name)); continue; }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      itemMeta.set(fm.roost_id, {
        title: fm.title,
        subtitle: fm.subtitle,
        tags: fm.tags,
      });

      if (fm.roost_category) {
        itemRoostCategory.set(fm.roost_id, fm.roost_category);
      }
    } catch {}
  }
}
scanDir(syncFolder);
console.log(`Vault: ${itemMeta.size} items; ${itemRoostCategory.size} with roost_category`);

// ── Load honest fixture ──

if (!fs.existsSync(BUILD_DIR)) {
  console.error(`Build dir not found: ${BUILD_DIR}\nRun build-honest-fixture.py first.`);
  process.exit(1);
}

const fixturePath = path.join(BUILD_DIR, `eval-fixture-${splitArg}.json`);
if (!fs.existsSync(fixturePath)) {
  console.error(`Fixture not found: ${fixturePath}\nRun build-honest-fixture.py first.`);
  process.exit(1);
}
const fixtureData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
// All fixture items (positives + negatives) must be held out from centroids.
const testEntries = fixtureData.testItems;
const testIdSet = new Set(testEntries.map(e => e.id));
console.log(`\nFixture split=${splitArg}: ${testEntries.length} items `
  + `(${testEntries.filter(e => !e.isNegative).length} positives, `
  + `${testEntries.filter(e => e.isNegative).length} negatives)`);

const fixtureWithMeta = testEntries.filter(e => itemMeta.has(e.id));
console.log(`  fixture items with vault metadata: ${fixtureWithMeta.length}/${testEntries.length}`);

// ── Build production pool (contamination-free) ──
// Pool = items with roost_category AND NOT in fixture.
// Grouped by roost_category (the 19 canonical categories).

const poolByCategory = new Map(); // category → [id]
for (const [id, cat] of itemRoostCategory) {
  if (testIdSet.has(id)) continue;           // contamination guard: exclude all fixture ids
  if (!poolByCategory.has(cat)) poolByCategory.set(cat, []);
  poolByCategory.get(cat).push(id);
}

const poolCategories = [...poolByCategory.keys()].sort();
let totalPoolItems = 0;
for (const ids of poolByCategory.values()) totalPoolItems += ids.length;
console.log(`\nProduction pool (roost_category, fixture excluded): ${totalPoolItems} items across ${poolCategories.length} categories`);
for (const cat of poolCategories) {
  console.log(`  ${cat}: ${poolByCategory.get(cat).length}`);
}

if (totalPoolItems === 0) {
  console.error("ERROR: Production pool is empty. This should not happen — vault scan found no items with roost_category outside the fixture.");
  process.exit(1);
}

// ── Subtitle noise detection (for modality-flag variant) ──

const MUSIC_NOISE_RE = /^[\s♪♬\.…\[\]()]+$|^\[music\]$|^\[applause\]$|^\[laughter\]$/i;
const NOISE_TOKENS_RE = /\b(um+|uh+|hmm+|yeah+|okay+|alright)\b/gi;

function isNoisySubtitle(subtitle) {
  if (!subtitle || subtitle.length < 20) return true;
  const cleaned = subtitle.replace(NOISE_TOKENS_RE, "").trim();
  if (cleaned.length < 15) return true;
  if (MUSIC_NOISE_RE.test(subtitle.trim())) return true;
  const wordChars = (subtitle.match(/[a-zA-Z]/g) || []).length;
  if (wordChars / subtitle.length < 0.3 && subtitle.length > 30) return true;
  return false;
}

// ── Build embed text for an item, given a config ──

function buildText(config, id) {
  const entry = cache[id] || {};
  const meta = itemMeta.get(id) || { title: "", subtitle: "", tags: [] };
  return config.build(entry, meta);
}

// ── Variant configs (pre-registered, spec 2026-06-18) ──

const configs = [
  {
    name: "full",
    label: "full (vision + summary + category + title + subtitle)",
    build(entry, meta) {
      return [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle]
        .filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "minus-vision",
    label: "minus-vision (summary + category + title + subtitle)",
    build(entry, meta) {
      return [entry.summary, entry.category, meta.title, meta.subtitle]
        .filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "minus-subtitle",
    label: "minus-subtitle (vision + summary + category + title)",
    build(entry, meta) {
      return [entry.vision, entry.summary, entry.category, meta.title]
        .filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "text-only",
    label: "text-only (title only — raw bookmark text)",
    build(_entry, meta) {
      return (meta.title || "").slice(0, 2000);
    },
  },
  {
    name: "summary-only",
    label: "summary-only (LLM summary only)",
    build(entry, _meta) {
      return (entry.summary || "").slice(0, 2000);
    },
  },
  {
    name: "modality-flag",
    label: "modality-flag (full formula; noisy/absent subtitle → [no transcript])",
    build(entry, meta) {
      const subtitle = isNoisySubtitle(meta.subtitle)
        ? "[no transcript]"
        : meta.subtitle;
      return [entry.vision, entry.summary, entry.category, meta.title, subtitle]
        .filter(Boolean).join(" ").slice(0, 2000);
    },
  },
];

// ── Embedding helper (concurrent) ──
// Concurrency kept at 12 to stay reasonable for 13K-item batches.

async function embedBatch(texts, concurrency = 12) {
  const results = new Array(texts.length);
  let idx = 0;

  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      const text = texts[i];
      if (!text || text.length < 10) { results[i] = null; continue; }
      try {
        const res = await fetch(`${EMBED_URL}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: EMBED_MODEL, input: text }),
        });
        const data = await res.json();
        results[i] = data?.embeddings?.[0] || null;
      } catch { results[i] = null; }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Score fixture against variant centroids (console summary; canonical scorer = honest-eval.py) ──

function scoreVectors(testVecs, centroids, entries) {
  let top1Correct = 0, top5Correct = 0;
  const perPlatform = { tiktok: { top1: 0, n: 0 }, twitter: { top1: 0, n: 0 } };
  const details = [];

  if (centroids.length === 0) {
    console.error("  ERROR: centroids are empty — cannot score. Check pool construction.");
    return { top1Correct: 0, top5Correct: 0, positives: entries.filter(e => !e.isNegative).length, details, perPlatform };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isNegative) { details.push({ id: entry.id, gt: null, top1: null, correct: null }); continue; }
    const vec = testVecs[i];
    if (!vec) { details.push({ id: entry.id, gt: entry.groundTruth, top1: "NO VEC", correct: false }); continue; }

    const scores = centroids.map(c => ({
      name: c.name,
      sim: cosineSim(vec, c.centroid),
    })).sort((a, b) => b.sim - a.sim);

    // Guard: scores array must be non-empty (centroids.length check above handles this).
    const top1Name = scores[0].name;
    const top1Match = top1Name === entry.groundTruth;
    const top5Match = scores.slice(0, 5).some(s => s.name === entry.groundTruth);
    if (top1Match) top1Correct++;
    if (top5Match) top5Correct++;

    // Per-platform tracking
    const platform = entry.id.startsWith("tiktok:") ? "tiktok"
      : entry.id.startsWith("twitter:") || entry.id.startsWith("x:") ? "twitter"
      : null;
    if (platform) {
      perPlatform[platform].n++;
      if (top1Match) perPlatform[platform].top1++;
    }

    details.push({ id: entry.id, gt: entry.groundTruth, top1: top1Name, correct: top1Match });
  }
  const positives = entries.filter(e => !e.isNegative).length;
  return { top1Correct, top5Correct, positives, details, perPlatform };
}

// ── Main ──

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // Sample verification — show the current formula text for one item.
  const sampleEntry = testEntries.find(e => !e.isNegative && cache[e.id] && itemMeta.get(e.id)?.title);
  if (sampleEntry) {
    const meta = itemMeta.get(sampleEntry.id);
    const entry = cache[sampleEntry.id] || {};
    const parts = [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle].filter(Boolean);
    const embedText = parts.join(" ").slice(0, 2000);
    console.log(`\nSample verification (${sampleEntry.id}):`);
    console.log(`  gt: ${sampleEntry.groundTruth}`);
    console.log(`  title: ${(meta.title || "").slice(0, 80)}...`);
    console.log(`  subtitle: ${meta.subtitle ? meta.subtitle.slice(0, 60) + "..." : "(none)"}`);
    console.log(`  embed text length: ${embedText.length}`);
  }

  const Npos = testEntries.filter(e => !e.isNegative).length;

  console.log("\n");
  console.log("═".repeat(110));
  console.log(`M7 EMBEDDING INPUT ABLATION  split=${splitArg}  N=${Npos} positives`);
  console.log(`Pool: ${totalPoolItems} production items (roost_category, fixture excluded) → ${poolCategories.length} category centroids`);
  console.log("═".repeat(110));
  console.log(`${"Variant".padEnd(60)}  Top-1     TikTok   Twitter   Top-5    Time   Cache`);
  console.log("─".repeat(110));

  for (const config of configs) {
    const start = Date.now();
    const outPath = path.join(BUILD_DIR, `${config.name}.json`);

    // Build embed text for every production pool item (grouped by category).
    const poolIds = [];   // parallel arrays
    const poolCats = [];
    const poolTexts = [];
    for (const cat of poolCategories) {
      for (const id of poolByCategory.get(cat)) {
        poolIds.push(id);
        poolCats.push(cat);
        poolTexts.push(buildText(config, id));
      }
    }

    // Build embed text for fixture items (test set).
    const testTexts = testEntries.map(e => buildText(config, e.id));

    const totalToEmbed = poolTexts.length + testTexts.length;
    process.stdout.write(`  ${config.label.slice(0, 55).padEnd(55)} embedding ${totalToEmbed} items...`);

    // Embed production pool items (for centroids). Concurrency=12 to be reasonable.
    const poolVecs = await embedBatch(poolTexts, 12);
    // Embed fixture items (for scoring + cache output).
    const testVecs = await embedBatch(testTexts, 12);

    // Build centroids (fixture items already excluded from pool above).
    const centroidVecsMap = new Map();
    for (const cat of poolCategories) centroidVecsMap.set(cat, []);
    for (let i = 0; i < poolIds.length; i++) {
      if (poolVecs[i]) {
        centroidVecsMap.get(poolCats[i]).push(poolVecs[i]);
      }
    }
    const centroids = [];
    for (const cat of poolCategories) {
      const vecs = centroidVecsMap.get(cat);
      if (vecs.length > 0) centroids.push({ name: cat, centroid: computeCentroid(vecs) });
    }

    if (centroids.length === 0) {
      console.error(`\nERROR: No centroids built for variant ${config.name}. Pool was empty after embedding.`);
      continue;
    }

    // Score fixture against variant centroids (console summary only; honest-eval.py is canonical).
    const result = scoreVectors(testVecs, centroids, testEntries);

    // Write named cache: { <roost_id>: { vec: [...] } } for fixture items only.
    // Format: honest-eval.py --cache <variant>.json reads this.
    const cacheOut = {};
    for (let i = 0; i < testEntries.length; i++) {
      if (testVecs[i]) {
        cacheOut[testEntries[i].id] = { vec: testVecs[i] };
      }
    }
    fs.writeFileSync(outPath, JSON.stringify(cacheOut));

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const top1pct = result.positives > 0 ? (result.top1Correct / result.positives * 100).toFixed(0) : "?";
    const top5pct = result.positives > 0 ? (result.top5Correct / result.positives * 100).toFixed(0) : "?";
    const ttk = result.perPlatform.tiktok;
    const ttw = result.perPlatform.twitter;
    const ttkPct = ttk.n > 0 ? (ttk.top1 / ttk.n * 100).toFixed(0) : "?";
    const ttwPct = ttw.n > 0 ? (ttw.top1 / ttw.n * 100).toFixed(0) : "?";

    process.stdout.write(`\r`);
    console.log(
      `${config.label.padEnd(60)}  ` +
      `${String(result.top1Correct).padStart(4)}/${result.positives} ${top1pct.padStart(3)}%  ` +
      `${String(ttk.top1).padStart(4)}/${ttk.n} ${ttkPct.padStart(3)}%  ` +
      `${String(ttw.top1).padStart(4)}/${ttw.n} ${ttwPct.padStart(3)}%  ` +
      `${String(result.top5Correct).padStart(4)}/${result.positives} ${top5pct.padStart(3)}%  ` +
      `${elapsed.padStart(6)}s  ${path.basename(outPath)}`
    );
  }

  console.log("─".repeat(110));
  console.log(`\nCaches written to: ${BUILD_DIR}/`);
  console.log("Score with: ROOST_VAULT=<vault> python scripts/honest-eval.py --cache <variant>.json --split <split> --by-platform");
  console.log("\nNote: top-1/top-5 above use production-style centroids built from roost_category pool.");
  console.log("Use honest-eval.py for the canonical OSCR+AUROC+AUPR+AURC metrics with production centroids.");
}

main().catch(err => { console.error(err); process.exit(1); });
