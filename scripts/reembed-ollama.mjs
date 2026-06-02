#!/usr/bin/env node
/**
 * Bulk re-embed vault items via Ollama nomic-embed-text.
 * Fills the cache gap (~17K items) using text extracted from frontmatter
 * (title + subtitle + body). Existing cache entries are preserved.
 *
 * Usage:
 *   node scripts/reembed-ollama.mjs --vault-root <vault>
 *   # or: ROOST_VAULT=<vault> node scripts/reembed-ollama.mjs
 */
import fs from "fs";
import path from "path";

const VAULT_ROOT = process.argv.includes("--vault-root")
  ? process.argv[process.argv.indexOf("--vault-root") + 1]
  : process.env.ROOST_VAULT;
if (!VAULT_ROOT) { console.error("--vault-root or ROOST_VAULT required"); process.exit(2); }

const OLLAMA_URL = "http://localhost:11434";
const MODEL = "nomic-embed-text";
const BATCH_SIZE = 50;
const VEC_DIM = 768;
const PREFIX = "search_document: ";

const CACHE_DIR = path.join(VAULT_ROOT, ".roost", "cache");
const JSON_PATH = path.join(CACHE_DIR, "embedding-cache.json");
const BIN_PATH = path.join(CACHE_DIR, "embedding-vectors.bin");
const BOOKMARKS_DIR = path.join(VAULT_ROOT, "Bookmarks");

// ── Load existing cache ──
console.log("Loading existing cache...");
const cache = fs.existsSync(JSON_PATH)
  ? JSON.parse(fs.readFileSync(JSON_PATH, "utf8"))
  : {};

// Load bin vectors into cache entries (plugin format: text in JSON, vecs in bin)
if (fs.existsSync(BIN_PATH)) {
  const buf = fs.readFileSync(BIN_PATH);
  const nl = buf.indexOf(10);
  if (nl > 0) {
    const keys = JSON.parse(buf.slice(0, nl).toString("utf8"));
    const dataStart = nl + 1;
    const aligned = Buffer.alloc(keys.length * VEC_DIM * 4);
    buf.copy(aligned, 0, dataStart, dataStart + aligned.length);
    const floats = new Float32Array(aligned.buffer, aligned.byteOffset, keys.length * VEC_DIM);
    for (let i = 0; i < keys.length; i++) {
      if (cache[keys[i]]) {
        cache[keys[i]].vec = Array.from(floats.subarray(i * VEC_DIM, (i + 1) * VEC_DIM));
      }
    }
  }
}
const existingWithVec = Object.keys(cache).filter(k => cache[k]?.vec?.length > 0).length;
console.log(`  ${Object.keys(cache).length} entries, ${existingWithVec} with vectors`);

// ── Walk vault ──
console.log("Scanning vault...");
const items = []; // {id, text}
function stripEmbeds(body) {
  return body
    .replace(/!\[\[.*?\]\]/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/#[^\s]+/g, "")
    .trim();
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];
      const idMatch = fm.match(/roost_id:\s*"?([^"\n]+)"?/);
      if (!idMatch) continue;
      const id = idMatch[1].trim();

      // Skip if already has a vector
      if (cache[id]?.vec?.length > 0) continue;

      // Build text from frontmatter + body
      const titleMatch = fm.match(/^title:\s*"?(.*?)"?\s*$/m);
      const subtitleMatch = fm.match(/^subtitle:\s*"?(.*?)"?\s*$/m);
      const body = content.slice(fmMatch[0].length).trim();
      const cleanBody = stripEmbeds(body);

      const parts = [];
      if (subtitleMatch?.[1]) parts.push(subtitleMatch[1]);
      if (titleMatch?.[1]) parts.push(titleMatch[1]);
      if (cleanBody.length > 20 && cleanBody.length < 2000) parts.push(cleanBody);

      const text = parts.join(" ").trim();
      if (text.length < 10) continue;

      items.push({ id, text });
      // Store text fields for the cache JSON (matches plugin's describe-items structure)
      if (!cache[id]) cache[id] = { vision: null, summary: null, category: null, vec: null };
      cache[id].summary = text.slice(0, 500);
    } catch { /* skip unreadable */ }
  }
}
walk(BOOKMARKS_DIR);
console.log(`  ${items.length} items need embedding`);

// ── Batch embed via Ollama ──
async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts.map(t => PREFIX + t) }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.embeddings;
}

async function main() {
  const t0 = Date.now();
  let embedded = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const texts = batch.map(b => b.text);
    try {
      const vecs = await embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        cache[batch[j].id].vec = vecs[j];
        embedded++;
      }
    } catch (e) {
      console.error(`  batch ${i}-${i + batch.length} failed:`, e.message);
    }
    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= items.length) {
      const pct = Math.round(((i + batch.length) / items.length) * 100);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${pct}% (${embedded}/${items.length}) — ${elapsed}s`);
    }
  }

  // ── Save ──
  console.log(`\nSaving ${Object.keys(cache).length} entries...`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Write bin (keys JSON line + Float32 payload)
  const allKeys = Object.keys(cache).filter(k => cache[k]?.vec?.length === VEC_DIM);
  const header = Buffer.from(JSON.stringify(allKeys) + "\n", "utf8");
  const payload = Buffer.alloc(allKeys.length * VEC_DIM * 4);
  for (let i = 0; i < allKeys.length; i++) {
    const vec = cache[allKeys[i]].vec;
    for (let d = 0; d < VEC_DIM; d++) {
      payload.writeFloatLE(vec[d], (i * VEC_DIM + d) * 4);
    }
  }
  fs.writeFileSync(BIN_PATH, Buffer.concat([header, payload]));

  // Write JSON (text fields only, strip vec)
  const jsonCache = {};
  for (const [k, v] of Object.entries(cache)) {
    const { vec, ...rest } = v;
    jsonCache[k] = rest;
  }
  fs.writeFileSync(JSON_PATH, JSON.stringify(jsonCache));

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done: ${embedded} new + ${existingWithVec} existing = ${allKeys.length} vectors in ${totalSec}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
