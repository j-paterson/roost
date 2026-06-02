#!/usr/bin/env node
/**
 * Strip vision-model preambles from summary/vision fields, then re-embed all items
 * using the full available signal: vision + summary + category + title + subtitle.
 *
 * Usage:
 *   node scripts/strip-preambles.mjs --dry-run     # preview changes, no writes
 *   node scripts/strip-preambles.mjs --strip-only   # strip preambles, skip re-embed
 *   node scripts/strip-preambles.mjs                # strip + re-embed all
 */
import * as fs from "fs";
import * as path from "path";

const VAULT = path.join(process.env.HOME, "ObsidianBookmarks");
const CACHE_PATH = path.join(VAULT, ".roost/embedding-cache.json");
const SYNC_DIR = path.join(VAULT, "Bookmarks");
const OLLAMA_URL = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const CONCURRENCY = 5;

const DRY_RUN = process.argv.includes("--dry-run");
const STRIP_ONLY = process.argv.includes("--strip-only");

const PREAMBLE_RE = /^(?:the |a )?(?:video|image|post|text|clip|photo|picture|content)\s+(?:(?:features|depicts|shows|showcases|discusses|documents|presents|demonstrates|highlights|captures|displays|illustrates|reveals|explores|examines|covers|describes|promotes|encourages)\s+|(?:appears to (?:be|show)\s+)|(?:is (?:about|a)\s+)|(?:(?:of|documenting|showcasing|demonstrating|presenting|showing|featuring|depicting|about)\s+))/i;

function stripPreamble(s) {
  if (!s) return s;
  const stripped = s.replace(PREAMBLE_RE, "");
  if (stripped !== s && stripped.length > 0) {
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }
  return s;
}

// ── Step 0: Migrate field names (desc→vision, topic→summary) ──

console.log(`Loading cache from ${CACHE_PATH}...`);
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
const ids = Object.keys(cache);
console.log(`${ids.length} entries\n`);

let migrated = 0;
for (const id of ids) {
  const entry = cache[id];
  if ("desc" in entry || "topic" in entry) {
    if (entry.desc !== undefined) { entry.vision = entry.desc; delete entry.desc; }
    if (entry.topic !== undefined) { entry.summary = entry.topic; delete entry.topic; }
    migrated++;
  }
}
if (migrated > 0) console.log(`Migrated ${migrated} entries (desc→vision, topic→summary)`);
else console.log("Field names already migrated");

// ── Step 1: Strip preambles ──

let summaryFixed = 0, visionFixed = 0;
for (const id of ids) {
  const entry = cache[id];
  if (entry.summary) {
    const cleaned = stripPreamble(entry.summary);
    if (cleaned !== entry.summary) { entry.summary = cleaned; summaryFixed++; }
  }
  if (entry.vision) {
    const cleaned = stripPreamble(entry.vision);
    if (cleaned !== entry.vision) { entry.vision = cleaned; visionFixed++; }
  }
}
console.log(`Stripped: ${summaryFixed} summaries, ${visionFixed} visions`);

if (DRY_RUN) {
  console.log("--dry-run: no changes written");
  process.exit(0);
}

// Save stripped cache before re-embedding (so we don't lose work if interrupted)
console.log("Saving stripped cache...");
fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

if (STRIP_ONLY) {
  console.log("--strip-only: skipping re-embed");
  process.exit(0);
}

// ── Step 2: Build frontmatter index (title + subtitle from vault) ──

console.log("\nIndexing vault frontmatter...");
const frontmatter = new Map(); // roost_id → { title, subtitle }

function walkDir(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) { walkDir(fp); continue; }
    if (!f.endsWith(".md")) continue;
    const content = fs.readFileSync(fp, "utf8");
    const idMatch = content.match(/^roost_id:\s*"?([^\n"]+)"?/m);
    if (!idMatch) continue;
    const id = idMatch[1].trim();
    const titleMatch = content.match(/^title:\s*"(.+)"/m);
    const subMatch = content.match(/^subtitle:\s*"(.+)"/m);
    frontmatter.set(id, {
      title: titleMatch?.[1] || "",
      subtitle: subMatch?.[1] || "",
    });
  }
}
walkDir(SYNC_DIR);
console.log(`${frontmatter.size} files indexed`);

// ── Step 3: Re-embed everything with full signal ──

function buildEmbedText(id) {
  const entry = cache[id];
  const fm = frontmatter.get(id) || { title: "", subtitle: "" };
  const parts = [];
  if (entry.vision) parts.push(entry.vision);
  if (entry.summary) parts.push(entry.summary);
  if (entry.category) parts.push(entry.category);
  if (fm.title) parts.push(fm.title);
  if (fm.subtitle) parts.push(fm.subtitle);
  return parts.join(" ").slice(0, 2000);
}

async function embedBatch(batch) {
  return Promise.all(batch.map(async (id) => {
    const text = buildEmbedText(id);
    if (text.length < 10) return { id, vec: null };
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      });
      const data = await res.json();
      return { id, vec: data.embeddings?.[0] || null };
    } catch (e) {
      return { id, vec: null, error: e.message };
    }
  }));
}

console.log(`\nRe-embedding ${ids.length} items (concurrency=${CONCURRENCY})...\n`);
const startTime = Date.now();
let done = 0, errors = 0;

for (let i = 0; i < ids.length; i += CONCURRENCY) {
  const batch = ids.slice(i, i + CONCURRENCY);
  const results = await embedBatch(batch);
  for (const r of results) {
    if (r.vec) {
      cache[r.id].vec = r.vec;
      done++;
    } else {
      errors++;
      if (errors <= 5) console.log(`  ERROR: ${r.id} — ${r.error || "no vector"}`);
    }
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const total = Math.min(i + CONCURRENCY, ids.length);
  const rate = (total / elapsed).toFixed(0);
  if (total % 500 < CONCURRENCY || total === ids.length) {
    const eta = ((ids.length - total) / rate).toFixed(0);
    console.log(`  ${total}/${ids.length} (${rate}/s, ~${eta}s remaining)`);
  }
  // Save checkpoint every 2000 items
  if (total % 2000 < CONCURRENCY) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
}

// Final save
fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone: ${done} embedded, ${errors} errors in ${totalTime}s`);
