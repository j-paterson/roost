#!/usr/bin/env node
/**
 * Test embedding text configurations with fair centroids.
 *
 * Matches the actual pipeline's data path exactly:
 *   text = fm.title
 *   subtitle = fm.subtitle
 *   tags = fm.tags (filtered same as describe-items.ts)
 *   vision, summary, category = embedding cache
 *
 * For each config: re-embeds all collection members + test items,
 * builds fresh centroids, scores top-1/top-5 vs ground truth.
 */
import fs from "fs";
import path from "path";

const VAULT_PATH = path.join(process.env.HOME, "ObsidianBookmarks");
const ROOST_DIR = path.join(VAULT_PATH, ".roost");
const OLLAMA_URL = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const SEED = 42;

// ── Load embedding cache ──

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
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
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

  // Extract collection/category
  const collMatch = fm.match(/^collection:\s*(.+)/m);
  const catMatch = fm.match(/^roost_category:\s*(.+)/m);
  const cat = (catMatch?.[1] || collMatch?.[1])?.trim()?.replace(/^"|"$/g, "") || null;

  return { roost_id, title, subtitle, tags, category: cat };
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

      if (fm.category && fm.category !== "undefined" && fm.category !== "null") {
        if (!collectionItems.has(fm.category)) collectionItems.set(fm.category, []);
        collectionItems.get(fm.category).push(fm.roost_id);
      }
    } catch {}
  }
}
scanDir(syncFolder);

// Filter collections
const collectionNames = [];
for (const [name, ids] of collectionItems) {
  const withCache = ids.filter(id => cache[id]);
  if (withCache.length >= 3) collectionNames.push(name);
}

let totalItems = 0;
for (const name of collectionNames) totalItems += collectionItems.get(name).filter(id => cache[id]).length;
console.log(`${collectionNames.length} collections, ${totalItems} items to embed per config`);

// Verify: check that our extraction matches the pipeline for a sample item
const sampleId = collectionItems.get(collectionNames[0])?.find(id => cache[id] && itemMeta.get(id)?.title);
if (sampleId) {
  const meta = itemMeta.get(sampleId);
  const entry = cache[sampleId];
  // Build current formula text
  const parts = [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle].filter(Boolean);
  const embedText = parts.join(" ").slice(0, 2000);
  console.log(`\nSample verification (${sampleId}):`);
  console.log(`  title: ${(meta.title || "").slice(0, 80)}...`);
  console.log(`  subtitle: ${meta.subtitle ? meta.subtitle.slice(0, 60) + "..." : "(none)"}`);
  console.log(`  tags: ${meta.tags.slice(0, 5).join(", ")}`);
  console.log(`  embed text length: ${embedText.length}`);
}

// ── Pick test items (identical seed/logic to test-strategies.mjs) ──

const TEST_SIZE = parseInt(process.argv[2] || "50");
const rng = mulberry32(SEED);
const testPool = [];
for (const [name, ids] of collectionItems) {
  const withVec = ids.filter(id => cache[id]?.vec);
  if (withVec.length < 3) continue;
  const shuffled = [...withVec];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const take = Math.max(1, Math.min(3, Math.ceil(TEST_SIZE / collectionNames.length)));
  for (const id of shuffled.slice(0, take)) {
    testPool.push({ id, groundTruth: name });
  }
}
for (let i = testPool.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [testPool[i], testPool[j]] = [testPool[j], testPool[i]];
}
const testEntries = testPool.slice(0, TEST_SIZE);
const testIdSet = new Set(testEntries.map(e => e.id));
console.log(`\nTest set: ${testEntries.length} labeled items from ${new Set(testEntries.map(e => e.groundTruth)).size} collections\n`);

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

// ── Location extraction ──

const LOCATION_PATTERNS = [
  /\b(austin|atx|do512|austintx|austintexas|austincreatives)\b/i,
  /\b(dallas|houston|san\s?antonio|fort\s?worth|dfw)\b/i,
  /\b(new\s?york|nyc|brooklyn|manhattan|los\s?angeles|chicago|miami|seattle|portland|denver|nashville|atlanta|boston|philly|philadelphia|san\s?francisco|sf|bay\s?area)\b/i,
  /\b(london|paris|tokyo|seoul|bangkok|bali|palawan|barcelona|rome|berlin|dubai|singapore|sydney|melbourne)\b/i,
];

const LOCATION_NAMES = {
  austin: "Austin, TX", atx: "Austin, TX", do512: "Austin, TX",
  austintx: "Austin, TX", austintexas: "Austin, TX", austincreatives: "Austin, TX",
  dallas: "Dallas, TX", houston: "Houston, TX", "san antonio": "San Antonio, TX",
  "fort worth": "Fort Worth, TX", dfw: "Dallas-Fort Worth, TX",
  "new york": "New York, NY", nyc: "New York, NY", brooklyn: "Brooklyn, NY",
  manhattan: "Manhattan, NY", "los angeles": "Los Angeles, CA",
  chicago: "Chicago, IL", miami: "Miami, FL", seattle: "Seattle, WA",
  portland: "Portland, OR", denver: "Denver, CO", nashville: "Nashville, TN",
  atlanta: "Atlanta, GA", boston: "Boston, MA", philly: "Philadelphia, PA",
  philadelphia: "Philadelphia, PA", "san francisco": "San Francisco, CA",
  sf: "San Francisco, CA", "bay area": "Bay Area, CA",
  london: "London, UK", paris: "Paris, France", tokyo: "Tokyo, Japan",
  seoul: "Seoul, South Korea", bangkok: "Bangkok, Thailand", bali: "Bali, Indonesia",
  palawan: "Palawan, Philippines", barcelona: "Barcelona, Spain", rome: "Rome, Italy",
  berlin: "Berlin, Germany", dubai: "Dubai, UAE", singapore: "Singapore",
  sydney: "Sydney, Australia", melbourne: "Melbourne, Australia",
};

function extractLocation(meta) {
  const sources = [
    (meta.tags || []).join(" "),
    meta.title || "",
    (meta.subtitle || "").slice(0, 500),
  ].join(" ");
  for (const pattern of LOCATION_PATTERNS) {
    const match = sources.match(pattern);
    if (match) {
      const key = match[1].toLowerCase();
      return LOCATION_NAMES[key] || match[1];
    }
  }
  return null;
}

// ── Build embed text for an item, given a config ──

function buildText(config, id) {
  const entry = cache[id] || {};
  const meta = itemMeta.get(id) || { title: "", subtitle: "", tags: [] };
  return config.build(entry, meta);
}

// ── Configs ──

const configs = [
  {
    name: "A: Current (vision+summary+cat+title+sub)",
    build(entry, meta) {
      // Exact match of describe-items.ts line 251
      return [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "B: Reordered (summary+cat+title+sub+tags+vision)",
    build(entry, meta) {
      const tags = filterTags(meta.tags).join(", ");
      return [entry.summary, entry.category, meta.title, meta.subtitle, tags, entry.vision].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "C: No vision (summary+cat+tags+title+sub)",
    build(entry, meta) {
      const tags = filterTags(meta.tags).join(", ");
      return [entry.summary, entry.category, tags, meta.title, meta.subtitle].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "H: Current + tags",
    build(entry, meta) {
      const tags = filterTags(meta.tags).join(", ");
      return [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle, tags].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "I: Current + location",
    build(entry, meta) {
      const loc = extractLocation(meta);
      return [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle, loc ? `Location: ${loc}` : null].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "K: Current + location + tags",
    build(entry, meta) {
      const tags = filterTags(meta.tags).join(", ");
      const loc = extractLocation(meta);
      return [entry.vision, entry.summary, entry.category, meta.title, meta.subtitle, loc ? `Location: ${loc}` : null, tags].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "M: Loc-first + summary-first + trunc vision",
    build(entry, meta) {
      const loc = extractLocation(meta);
      const shortVision = entry.vision ? entry.vision.slice(0, 200) : null;
      return [loc ? `Location: ${loc}.` : null, entry.summary, entry.category, meta.title, meta.subtitle, shortVision].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
  {
    name: "N: Summary + loc + cat + trunc vision + title + sub",
    build(entry, meta) {
      const loc = extractLocation(meta);
      const shortVision = entry.vision ? entry.vision.slice(0, 200) : null;
      return [entry.summary, loc ? `Location: ${loc}` : null, entry.category, meta.title, meta.subtitle, shortVision].filter(Boolean).join(" ").slice(0, 2000);
    },
  },
];

// ── Score ──

function scoreVectors(testVecs, centroids) {
  let top1Correct = 0, top5Correct = 0;
  const details = [];

  for (let i = 0; i < testEntries.length; i++) {
    const { groundTruth } = testEntries[i];
    const vec = testVecs[i];
    if (!vec) { details.push({ gt: groundTruth, top1: "NO VEC", correct: false }); continue; }

    const scores = centroids.map(c => ({
      name: c.name,
      sim: cosineSim(vec, c.centroid),
    })).sort((a, b) => b.sim - a.sim);

    const top1Match = scores[0].name === groundTruth;
    const top5Match = scores.slice(0, 5).some(s => s.name === groundTruth);
    if (top1Match) top1Correct++;
    if (top5Match) top5Correct++;

    details.push({ gt: groundTruth, top1: scores[0].name, correct: top1Match });
  }
  return { top1Correct, top5Correct, details };
}

// ── Main ──

async function main() {
  const N = testEntries.length;

  // Baseline: cached vectors
  const baselineCentroids = collectionNames.map(name => {
    const ids = collectionItems.get(name).filter(id => cache[id]?.vec);
    return { name, centroid: computeCentroid(ids.map(id => cache[id].vec)) };
  });
  const baselineVecs = testEntries.map(e => cache[e.id]?.vec || null);
  const baseline = scoreVectors(baselineVecs, baselineCentroids);

  console.log("═".repeat(100));
  console.log("EMBEDDING CONFIG COMPARISON (fair centroids per config)");
  console.log("═".repeat(100));
  console.log("");
  console.log(`${"Configuration".padEnd(55)}  Top-1    Top-5    Δ Top-1    Time`);
  console.log("─".repeat(100));
  console.log(`${"Baseline (cached vectors)".padEnd(55)}  ${String(baseline.top1Correct).padStart(2)}/${N} ${(baseline.top1Correct / N * 100).toFixed(0).padStart(3)}%   ${String(baseline.top5Correct).padStart(2)}/${N} ${(baseline.top5Correct / N * 100).toFixed(0).padStart(3)}%        —     0.0s`);

  const allResults = [{ name: "Baseline", ...baseline }];

  // Pre-build the list of all IDs per collection (for centroid building)
  const collectionIdLists = new Map();
  for (const name of collectionNames) {
    collectionIdLists.set(name, collectionItems.get(name).filter(id => cache[id]));
  }

  for (const config of configs) {
    const start = Date.now();

    // Build embed text for every item
    const allIds = [];
    const allTexts = [];
    for (const name of collectionNames) {
      for (const id of collectionIdLists.get(name)) {
        allIds.push({ id, collection: name });
        allTexts.push(buildText(config, id));
      }
    }
    // Also add test items (in case they're not in the lists above — they should be)
    const testTexts = testEntries.map(e => buildText(config, e.id));

    process.stdout.write(`  ${config.name.slice(0, 50).padEnd(50)} embedding ${allTexts.length} items...`);

    // Embed all collection items
    const allVecs = await embedBatch(allTexts, 20);
    // Embed test items
    const testVecs = await embedBatch(testTexts, 20);

    // Build centroids (excluding test items)
    const centroidVecsMap = new Map(); // name → [vecs]
    for (const name of collectionNames) centroidVecsMap.set(name, []);
    for (let i = 0; i < allIds.length; i++) {
      const { id, collection } = allIds[i];
      if (allVecs[i] && !testIdSet.has(id)) {
        centroidVecsMap.get(collection).push(allVecs[i]);
      }
    }
    const centroids = [];
    for (const name of collectionNames) {
      const vecs = centroidVecsMap.get(name);
      if (vecs.length > 0) centroids.push({ name, centroid: computeCentroid(vecs) });
    }

    const result = scoreVectors(testVecs, centroids);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const delta = result.top1Correct - baseline.top1Correct;
    const deltaStr = delta > 0 ? `+${delta}` : delta === 0 ? " 0" : String(delta);

    process.stdout.write(`\r`);
    console.log(`${config.name.padEnd(55)}  ${String(result.top1Correct).padStart(2)}/${N} ${(result.top1Correct / N * 100).toFixed(0).padStart(3)}%   ${String(result.top5Correct).padStart(2)}/${N} ${(result.top5Correct / N * 100).toFixed(0).padStart(3)}%   ${deltaStr.padStart(5)}   ${elapsed.padStart(6)}s`);

    allResults.push({ name: config.name, ...result });
  }

  console.log("─".repeat(100));

  // ── Per-item detail ──
  console.log("\n");
  console.log("═".repeat(100));
  console.log("PER-ITEM CHANGES vs BASELINE");
  console.log("═".repeat(100));
  console.log("");

  const labels = ["Base", ...configs.map(c => c.name.split(":")[0].trim())];
  const hdr = `${"#".padStart(4)}  ${"GT".padEnd(18)}  ${labels.map(n => n.padEnd(5)).join(" ")}  Summary`;
  console.log(hdr);
  console.log("─".repeat(hdr.length + 20));

  for (let i = 0; i < N; i++) {
    const results = allResults.map(r => r.details[i]);
    const anyDiffers = results.some(r => r.correct !== results[0].correct);
    if (!anyDiffers) continue;

    const entry = cache[testEntries[i].id];
    const marks = results.map(r => r.correct ? "  ✓  " : `✗${(r.top1 || "?").slice(0, 4)}`);
    console.log(`${String(i + 1).padStart(4)}  ${results[0].gt.padEnd(18)}  ${marks.join(" ")}  ${(entry?.summary || "").slice(0, 50)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
