/**
 * Build a canonical taxonomy by asking Ollama to group 700+ raw categories into ~50-100 canonical ones.
 * Outputs: test/taxonomy.json
 *
 * Usage: node test/build-taxonomy.mjs
 */
import * as fs from "fs";
import * as path from "path";

const HOME = process.env.HOME;
const VAULT_CACHE = path.join(HOME, "ObsidianBookmarks/.roost/embedding-cache.json");
const APP_CACHE = path.join(HOME, "Library/Application Support/roost-app/.embedding-cache-tiktok.json");
const OLLAMA = "http://localhost:11434";
const MODEL = "llama3.2:3b";
const OUT_FILE = path.join(import.meta.dirname, "taxonomy.json");

// ── Load and normalize categories ──
const cacheFile = fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : APP_CACHE;
const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

function normalize(c) {
  return (c || "").trim().replace(/\.+$/, "").toLowerCase();
}

const catCounts = new Map();
for (const v of Object.values(cache)) {
  if (!v?.vec) continue;
  const cat = normalize(v.category);
  if (cat) catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
}

// Get categories with 3+ items, sorted by frequency
const significant = [...catCounts.entries()]
  .filter(([_, n]) => n >= 3)
  .sort((a, b) => b[1] - a[1]);

console.log(`${significant.length} categories with 3+ items (${catCounts.size} total unique)\n`);

// ── Build prompt — batch categories into chunks for the LLM ──
// 700+ categories is too many for one prompt. Batch into groups.
const BATCH_SIZE = 150;
const batches = [];
for (let i = 0; i < significant.length; i += BATCH_SIZE) {
  batches.push(significant.slice(i, i + BATCH_SIZE));
}

const taxonomy = new Map(); // raw → canonical

console.log(`Processing ${batches.length} batches of ~${BATCH_SIZE} categories each...\n`);

for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  const catList = batch.map(([c, n]) => c).join(", ");

  const prompt = `You are a taxonomy expert. I have a list of category labels from a social media bookmark collection. Many are duplicates, near-duplicates, or overly specific.

Group them into canonical categories. Return ONLY a JSON object mapping each input category to its canonical form. Use Title Case for canonical names. Aim for 40-80 total canonical categories across all inputs.

Rules:
- Merge synonyms: "tech", "technology", "software" → "Technology"
- Merge sub-categories into parents when too specific: "jazz", "folk", "hiphop" → "Music"
- Keep genuinely distinct categories separate: "Fitness" and "Food" should NOT merge
- "portrait", "selfie", "headshot" → "Portrait & Selfie"
- "interior", "interiordesign", "homedecor", "room", "decor" → "Interior Design"
- "car", "cars", "vehicle", "motorcycle" → "Vehicles"
- "blockchain", "crypto", "cryptocurrency", "web3", "nft" → "Crypto & Web3"

Categories to group:
${catList}

Respond with ONLY valid JSON, no explanation. Example format:
{"tech": "Technology", "software": "Technology", "jazz": "Music", "folk": "Music"}`;

  console.log(`Batch ${bi + 1}/${batches.length} (${batch.length} categories)...`);

  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 4096 },
    }),
  });

  const data = await res.json();
  const text = data.response || "";

  // Extract JSON from response (may have markdown fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`  WARNING: No JSON found in response for batch ${bi + 1}`);
    console.log(`  Response: ${text.slice(0, 200)}...`);
    continue;
  }

  try {
    const mapping = JSON.parse(jsonMatch[0]);
    let mapped = 0;
    for (const [raw, canonical] of Object.entries(mapping)) {
      taxonomy.set(normalize(raw), canonical);
      mapped++;
    }
    console.log(`  Mapped ${mapped} categories`);
  } catch (e) {
    console.log(`  WARNING: Failed to parse JSON for batch ${bi + 1}: ${e.message}`);
    console.log(`  JSON: ${jsonMatch[0].slice(0, 200)}...`);
  }
}

// ── Also map remaining categories not in the significant list ──
// Map them to their closest significant match, or leave as-is
const allCats = [...catCounts.keys()];
let unmapped = 0;
for (const cat of allCats) {
  if (!taxonomy.has(cat)) {
    // Try to find a significant category that contains this one or vice versa
    let found = false;
    for (const [sig] of significant) {
      if (sig === cat || sig.startsWith(cat) || cat.startsWith(sig)) {
        if (taxonomy.has(sig)) {
          taxonomy.set(cat, taxonomy.get(sig));
          found = true;
          break;
        }
      }
    }
    if (!found) unmapped++;
  }
}

// ── Stats ──
const canonicals = new Set(taxonomy.values());
console.log(`\n${"═".repeat(50)}`);
console.log(`Taxonomy built: ${taxonomy.size} raw → ${canonicals.size} canonical categories`);
console.log(`Unmapped: ${unmapped} rare categories`);
console.log(`\nCanonical categories (${canonicals.size}):`);
const canonicalCounts = new Map();
for (const [raw, canonical] of taxonomy) {
  const count = catCounts.get(raw) || 0;
  canonicalCounts.set(canonical, (canonicalCounts.get(canonical) || 0) + count);
}
for (const [canonical, count] of [...canonicalCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${canonical}`);
}

// ── Save ──
const output = {
  mapping: Object.fromEntries(taxonomy),
  canonicals: [...canonicals].sort(),
  stats: {
    raw_categories: catCounts.size,
    significant_categories: significant.length,
    mapped: taxonomy.size,
    canonical_count: canonicals.size,
    unmapped,
  },
};
fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`\nSaved to ${OUT_FILE}`);
