/**
 * Second pass: collapse 478 canonical categories into ~60-80 top-level categories.
 * Logs every merge decision.
 *
 * Usage: node test/refine-taxonomy.mjs
 */
import * as fs from "fs";
import * as path from "path";

const OLLAMA = "http://localhost:11434";
const MODEL = "llama3.2:3b";
const HOME = process.env.HOME;
const VAULT_CACHE = path.join(HOME, "ObsidianBookmarks/.roost/embedding-cache.json");
const TAXONOMY_V1 = path.join(import.meta.dirname, "taxonomy.json");
const OUT_FILE = path.join(import.meta.dirname, "taxonomy-v2.json");
const LOG_FILE = path.join(import.meta.dirname, "taxonomy-merge-log.txt");

// ── Load v1 taxonomy ──
const cache = JSON.parse(fs.readFileSync(fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : path.join(HOME, "Library/Application Support/roost-app/.embedding-cache-tiktok.json"), "utf8"));
const v1 = JSON.parse(fs.readFileSync(TAXONOMY_V1, "utf8"));
const v1Mapping = v1.mapping;

function normalize(c) { return (c || "").trim().replace(/\.+$/, "").toLowerCase(); }

// Count items per v1 canonical
const canonicalCounts = new Map();
for (const v of Object.values(cache)) {
  if (!v?.vec) continue;
  const raw = normalize(v.category);
  const canonical = v1Mapping[raw] || raw;
  if (canonical) canonicalCounts.set(canonical, (canonicalCounts.get(canonical) || 0) + 1);
}

const v1Canonicals = [...canonicalCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${v1Canonicals.length} v1 canonical categories\n`);

// ── Step 1: Define master categories ──
console.log("Step 1: Defining master categories...\n");

const topCats = v1Canonicals.slice(0, 80).map(([c, n]) => `${c} (${n})`).join("\n");
const masterPrompt = `You are building a bookmark taxonomy. Below are the 80 most common category labels with item counts.

Define 60-80 master categories. Rules:
- Merge synonyms and sub-categories: "Interior Design" + "Decor" + "Home" → "Home & Interior"
- "Food" + "Recipes" + "Drinks" + "Dessert" + "Baking" → "Food & Drink"
- "Fitness" + "Exercise" + "Gym" + "Gymnastics" → "Fitness"
- "Portrait & Selfie" + "Photography" → "Photography"
- Keep genuinely different topics separate

Return ONLY a JSON array. Example: ["Technology", "Art", "Fitness"]

Categories:
${topCats}`;

const masterRes = await fetch(`${OLLAMA}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: MODEL, prompt: masterPrompt, stream: false, options: { temperature: 0.1, num_predict: 2048 } }),
});
const masterText = (await masterRes.json()).response;
const masterMatch = masterText.match(/\[[\s\S]*?\]/);
let masterCategories;
try {
  masterCategories = JSON.parse(masterMatch[0]);
  console.log(`${masterCategories.length} master categories defined\n`);
} catch (e) {
  console.log("Failed to parse:", masterText.slice(0, 300));
  process.exit(1);
}

// ── Step 2: Map each v1 canonical to a master — one at a time for reliability ──
console.log(`Step 2: Mapping ${v1Canonicals.length} categories...\n`);

const masterList = masterCategories.join(", ");
const v2Mapping = new Map();
const mergeLog = [];

// Batch via a simpler format: one mapping per line, "input → output"
const BATCH_SIZE = 40;
const batches = [];
for (let i = 0; i < v1Canonicals.length; i += BATCH_SIZE) {
  batches.push(v1Canonicals.slice(i, i + BATCH_SIZE));
}

for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  const lines = batch.map(([c]) => c).join("\n");

  const prompt = `Map each category to the single best match from this master list:
[${masterList}]

For each input line, output EXACTLY: input → master
No extra text, no numbering, no explanation.

${lines}`;

  process.stdout.write(`  Batch ${bi + 1}/${batches.length}...`);

  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.0, num_predict: 2048 } }),
  });
  const text = (await res.json()).response;

  // Parse "input → master" lines
  let mapped = 0;
  for (const line of text.split("\n")) {
    // Match "Category → Master" or "Category -> Master"
    const m = line.match(/^\s*(.+?)\s*[→\->]+\s*(.+?)\s*$/);
    if (m) {
      const from = m[1].replace(/^\d+\.\s*/, "").trim();
      const to = m[2].trim();
      // Verify 'from' is in our batch
      const match = batch.find(([c]) => c.toLowerCase() === from.toLowerCase());
      if (match) {
        v2Mapping.set(match[0], to);
        mergeLog.push({ from: match[0], to, count: canonicalCounts.get(match[0]) || 0 });
        mapped++;
      }
    }
  }
  console.log(` ${mapped}/${batch.length} mapped`);
}

// ── Handle unmapped — assign to closest master by name ──
let unmapped = 0;
for (const [cat] of v1Canonicals) {
  if (!v2Mapping.has(cat)) {
    // Find best master by simple substring match
    const catLower = cat.toLowerCase();
    let best = null;
    for (const mc of masterCategories) {
      if (mc.toLowerCase() === catLower || catLower.includes(mc.toLowerCase()) || mc.toLowerCase().includes(catLower)) {
        best = mc;
        break;
      }
    }
    if (best) {
      v2Mapping.set(cat, best);
      mergeLog.push({ from: cat, to: best, count: canonicalCounts.get(cat) || 0 });
    } else {
      unmapped++;
      v2Mapping.set(cat, cat); // keep as-is
      mergeLog.push({ from: cat, to: cat, count: canonicalCounts.get(cat) || 0 });
    }
  }
}
console.log(`\n${v2Mapping.size} mapped, ${unmapped} kept as-is\n`);

// ── Build final raw → master mapping ──
const finalMapping = {};
for (const [raw, v1Canonical] of Object.entries(v1Mapping)) {
  finalMapping[raw] = v2Mapping.get(v1Canonical) || v1Canonical;
}

// ── Write merge log ──
mergeLog.sort((a, b) => a.to.localeCompare(b.to) || b.count - a.count);

const masterCounts = new Map();
for (const entry of mergeLog) {
  masterCounts.set(entry.to, (masterCounts.get(entry.to) || 0) + entry.count);
}
const masterSorted = [...masterCounts.entries()].sort((a, b) => b[1] - a[1]);

const logLines = [
  `Taxonomy v2 Merge Log`,
  `Generated: ${new Date().toISOString()}`,
  ``,
  `${v1Canonicals.length} v1 categories → ${new Set(v2Mapping.values()).size} master categories`,
  ``,
  `Master categories by item count:`,
  ...masterSorted.map(([m, n]) => `  ${String(n).padStart(5)}  ${m}`),
  ``,
  `═══════════════════════════════════════════`,
  `DETAILED MERGE LOG`,
  `═══════════════════════════════════════════`,
];

let currentMaster = null;
for (const entry of mergeLog) {
  if (entry.to !== currentMaster) {
    currentMaster = entry.to;
    logLines.push(`\n═══ ${currentMaster} (${masterCounts.get(currentMaster)} items) ═══`);
  }
  const arrow = entry.from === entry.to ? "  (identity)" : "";
  logLines.push(`  ${String(entry.count).padStart(5)}  ${entry.from}${arrow}`);
}

fs.writeFileSync(LOG_FILE, logLines.join("\n"));
console.log(`Merge log: ${LOG_FILE}`);

// ── Save ──
const output = {
  mapping: finalMapping,
  masterCategories: [...new Set(v2Mapping.values())].sort(),
  v2Mapping: Object.fromEntries(v2Mapping),
  stats: {
    v1_canonicals: v1Canonicals.length,
    master_count: new Set(v2Mapping.values()).size,
    mapped: v2Mapping.size,
    unmapped,
  },
};
fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`Taxonomy v2: ${OUT_FILE}`);

console.log(`\nMaster categories (${masterSorted.length}):`);
for (const [m, n] of masterSorted.slice(0, 30)) {
  console.log(`  ${String(n).padStart(5)}  ${m}`);
}
if (masterSorted.length > 30) console.log(`  ... and ${masterSorted.length - 30} more`);
