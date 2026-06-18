#!/usr/bin/env node
/**
 * M7 input-text ablation — test embedding text configurations with fair centroids.
 *
 * Matches the actual pipeline's data path exactly:
 *   text = fm.title
 *   subtitle = fm.subtitle
 *   tags = fm.tags (filtered same as describe-items.ts)
 *   vision, summary, category = embedding cache
 *
 * For each variant: re-embeds all collection members + fixture items,
 * builds fresh centroids (fixture items excluded), writes a named cache at
 * <vault>/.roost/build/<variant>.json so honest-eval.py --cache <variant>.json
 * can score it.
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

const VAULT_PATH = process.env.ROOST_VAULT || path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const BUILD_DIR = path.join(ROOST_DIR, "build");
const OLLAMA_URL = "http://localhost:11434";
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

// ── Load embedding cache (v2 JSON or inline cache) ──
// Prefer inline embedding-cache.json if present; the v2 binary is read by honest-eval.py.
// Here we only need the per-item metadata fields (vision, summary, category) — the vec
// field from the cache is used only for the baseline display, not re-emitted to output.

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

// ── Parse frontmatter with js-yaml-like approach ──
// Obsidian's metadataCache parses YAML properly. We need to match that.

function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  // Extract roost_id
  const idMatch = fm.match(/^roost_id:\s*"?([^"\n]+)"?/m);
  if (!idMatch) return null;
  const roost_id = idMatch[1].trim();

  // Extract title — Obsidian parses this as a string
  // It may or may not be quoted in YAML
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

  // Extract collection (human label) — collection: only, not roost_category.
  // GT contamination guard: we never use roost_category to build centroids here.
  const collMatch = fm.match(/^collection:\s*(.+)/m);
  const collection = collMatch?.[1]?.trim()?.replace(/^"|"$/g, "") || null;

  return { roost_id, title, subtitle, tags, collection };
}

// ── Scan vault ──

console.log("Scanning vault...");
const collectionItems = new Map(); // collection name → [id]
const itemMeta = new Map();        // id → { title, subtitle, tags }

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

      // Use collection: only (honest labels) for centroid building.
      if (fm.collection && fm.collection !== "undefined" && fm.collection !== "null") {
        if (!collectionItems.has(fm.collection)) collectionItems.set(fm.collection, []);
        collectionItems.get(fm.collection).push(fm.roost_id);
      }
    } catch {}
  }
}
scanDir(syncFolder);

// Filter collections to those with ≥3 cached items.
const collectionNames = [];
for (const [name, ids] of collectionItems) {
  const withCache = ids.filter(id => cache[id]);
  if (withCache.length >= 3) collectionNames.push(name);
}

let totalItems = 0;
for (const name of collectionNames) totalItems += collectionItems.get(name).filter(id => cache[id]).length;
console.log(`${collectionNames.length} collections, ${totalItems} items to embed per config`);

// ── Load honest fixture ──
// Source test items from the honest fixture, NOT from a random sampler.
// The fixture items are held out from centroid building (contamination guard).

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
// Positives have a groundTruth category; negatives have isNegative=true.
const testEntries = fixtureData.testItems;
const testIdSet = new Set(testEntries.map(e => e.id));
console.log(`\nFixture split=${splitArg}: ${testEntries.length} items `
  + `(${testEntries.filter(e => !e.isNegative).length} positives, `
  + `${testEntries.filter(e => e.isNegative).length} negatives)`);

// Verify: fixture items should have metadata in itemMeta (vault must be scanned first).
const fixtureWithMeta = testEntries.filter(e => itemMeta.has(e.id));
console.log(`  fixture items with vault metadata: ${fixtureWithMeta.length}/${testEntries.length}`);

// ── Subtitle noise detection (for modality-flag variant) ──
// A subtitle is considered "noise/absent" when:
//  - it is empty or very short (< 20 chars), OR
//  - it consists mostly of common music-noise tokens (♪, ♬, ellipsis, generic filler).
// We flag these rather than dropping them so the embedding model sees a signal about
// the *absence* of useful transcript, rather than interpreting pure silence as normal.

const MUSIC_NOISE_RE = /^[\s♪♬\.…\[\]()]+$|^\[music\]$|^\[applause\]$|^\[laughter\]$/i;
const NOISE_TOKENS_RE = /\b(um+|uh+|hmm+|yeah+|okay+|alright)\b/gi;

function isNoisySubtitle(subtitle) {
  if (!subtitle || subtitle.length < 20) return true;
  const cleaned = subtitle.replace(NOISE_TOKENS_RE, "").trim();
  if (cleaned.length < 15) return true;
  if (MUSIC_NOISE_RE.test(subtitle.trim())) return true;
  // High ratio of non-word characters suggests music transcription noise.
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
// Output cache key names must be stable — used as filenames for honest-eval.py.

const configs = [
  {
    name: "full",
    label: "full (vision + summary + category + title + subtitle)",
    build(entry, meta) {
      // Exact match of describe-items.ts line 251 — the current production formula.
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

async function embedBatch(texts, concurrency = 20) {
  const results = new Array(texts.length);
  let idx = 0;

  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      const text = texts[i];
      if (!text || text.length < 10) { results[i] = null; continue; }
      try {
        const res = await fetch(`${OLLAMA_URL}/api/embed`, {
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

// ── Score (for console summary only — honest-eval.py is the canonical scorer) ──

function scoreVectors(testVecs, centroids, entries) {
  let top1Correct = 0, top5Correct = 0;
  const details = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isNegative) { details.push({ id: entry.id, gt: null, top1: null, correct: null }); continue; }
    const vec = testVecs[i];
    if (!vec) { details.push({ id: entry.id, gt: entry.groundTruth, top1: "NO VEC", correct: false }); continue; }

    const scores = centroids.map(c => ({
      name: c.name,
      sim: cosineSim(vec, c.centroid),
    })).sort((a, b) => b.sim - a.sim);

    const top1Match = scores[0].name === entry.groundTruth;
    const top5Match = scores.slice(0, 5).some(s => s.name === entry.groundTruth);
    if (top1Match) top1Correct++;
    if (top5Match) top5Correct++;

    details.push({ id: entry.id, gt: entry.groundTruth, top1: scores[0].name, correct: top1Match });
  }
  const positives = entries.filter(e => !e.isNegative).length;
  return { top1Correct, top5Correct, positives, details };
}

// ── Main ──

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // Pre-build the list of all IDs per collection (for centroid building), excluding fixture.
  const collectionIdLists = new Map();
  for (const name of collectionNames) {
    collectionIdLists.set(name, collectionItems.get(name).filter(id => cache[id] && !testIdSet.has(id)));
  }

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

  const N = testEntries.length;
  const Npos = testEntries.filter(e => !e.isNegative).length;

  console.log("\n");
  console.log("═".repeat(100));
  console.log(`M7 EMBEDDING INPUT ABLATION  split=${splitArg}  N=${Npos} positives`);
  console.log("═".repeat(100));
  console.log(`${"Variant".padEnd(60)}  Top-1    Top-5    Time   Cache written`);
  console.log("─".repeat(100));

  for (const config of configs) {
    const start = Date.now();
    const outPath = path.join(BUILD_DIR, `${config.name}.json`);

    // Build embed text for every collection item (excluding fixture).
    const allIds = [];
    const allTexts = [];
    for (const name of collectionNames) {
      for (const id of collectionIdLists.get(name)) {
        allIds.push({ id, collection: name });
        allTexts.push(buildText(config, id));
      }
    }

    // Also build embed text for fixture items (test set).
    const testTexts = testEntries.map(e => buildText(config, e.id));

    process.stdout.write(`  ${config.label.slice(0, 55).padEnd(55)} embedding ${allTexts.length + testTexts.length} items...`);

    // Embed all collection items (for centroids).
    const allVecs = await embedBatch(allTexts, 20);
    // Embed fixture items (for scoring + cache output).
    const testVecs = await embedBatch(testTexts, 20);

    // Build centroids (fixture items already excluded from allIds above).
    const centroidVecsMap = new Map();
    for (const name of collectionNames) centroidVecsMap.set(name, []);
    for (let i = 0; i < allIds.length; i++) {
      const { collection } = allIds[i];
      if (allVecs[i]) {
        centroidVecsMap.get(collection).push(allVecs[i]);
      }
    }
    const centroids = [];
    for (const name of collectionNames) {
      const vecs = centroidVecsMap.get(name);
      if (vecs.length > 0) centroids.push({ name, centroid: computeCentroid(vecs) });
    }

    // Score (console summary only; canonical scoring is honest-eval.py).
    const result = scoreVectors(testVecs, centroids, testEntries);

    // Write named cache: { <roost_id>: { vec: [...] } } for fixture items.
    // This is the format L.load_cache(json_path=...) expects in honest-eval.py.
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

    process.stdout.write(`\r`);
    console.log(
      `${config.label.padEnd(60)}  ` +
      `${String(result.top1Correct).padStart(3)}/${result.positives} ${top1pct.padStart(3)}%   ` +
      `${String(result.top5Correct).padStart(3)}/${result.positives} ${top5pct.padStart(3)}%  ` +
      `${elapsed.padStart(6)}s   ${path.basename(outPath)}`
    );
  }

  console.log("─".repeat(100));
  console.log(`\nCaches written to: ${BUILD_DIR}/`);
  console.log("Score with: ROOST_VAULT=<vault> python scripts/honest-eval.py --cache <variant>.json --split <split> --by-platform");
  console.log("\nNote: top-1/top-5 above use plain-mean centroids from `collection:` labels.");
  console.log("Use honest-eval.py for the canonical OSCR+AUROC+AUPR+AURC metrics with production centroids.");
}

main().catch(err => { console.error(err); process.exit(1); });
