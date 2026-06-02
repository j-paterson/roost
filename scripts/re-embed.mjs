#!/usr/bin/env node
/**
 * Re-embed items with invalidated cache entries (null vec).
 * Runs topic analysis + embedding via Ollama. Skips vision (already filled by Gemma 4).
 * Reads frontmatter from vault notes for text, subtitle, and tags.
 *
 * Usage:
 *   node scripts/re-embed.mjs              # dry run — count items
 *   node scripts/re-embed.mjs --run        # process all
 *   node scripts/re-embed.mjs --run -n 50  # process first 50
 */
import fs from "fs";
import path from "path";
import os from "os";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const BOOKMARKS_PATH = path.join(VAULT_PATH, "Bookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");
const OLLAMA = "http://localhost:11434";
const TOPIC_MODEL = "llama3.2:3b";
const EMBED_MODEL = "nomic-embed-text";
const CONCURRENCY = 3;

const dryRun = !process.argv.includes("--run");
const limitIdx = process.argv.indexOf("-n");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

// ── Tag filter (same as describe-items.ts) ────────────────────

const SKIP_TAGS = new Set(["tiktok", "twitter", "farcaster", "fyp", "foryou", "viral", "trending"]);

function filterTags(tags) {
  return tags.filter(t => {
    if (t.startsWith("@") || t.startsWith("collection:") || t.startsWith("_")) return false;
    if (SKIP_TAGS.has(t.toLowerCase())) return false;
    return true;
  });
}

// ── Scan vault for items needing re-embedding ─────────────────

function scanItems(cache) {
  const items = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".md")) continue;

      const content = fs.readFileSync(full, "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];

      const idMatch = fm.match(/^roost_id:\s*"?([^\s"]+)"?\s*$/m);
      if (!idMatch) continue;
      const roostId = idMatch[1];

      // Only process items with null vec in cache
      if (!cache[roostId] || cache[roostId].vec !== null) continue;

      // Extract frontmatter fields
      const titleMatch = fm.match(/^title:\s*"?(.+?)"?\s*$/m);
      const text = titleMatch?.[1] || "";

      const subtitleMatch = fm.match(/^subtitle:\s*"(.+?)"\s*$/m);
      const subtitle = subtitleMatch?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, '\\') || "";

      const tags = [];
      const tagSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
      if (tagSection) {
        for (const line of tagSection[1].split("\n")) {
          const t = line.match(/^\s+-\s+(.+)/);
          if (t) tags.push(t[1].trim());
        }
      }

      items.push({ roostId, text, subtitle, tags });
    }
  }

  walk(BOOKMARKS_PATH);
  return items;
}

// ── Ollama calls ──────────────────────────────────────────────

async function topicAnalysis(vision, text, subtitle, tags) {
  const cleanTags = filterTags(tags).join(", ");
  const parts = [];
  if (vision) parts.push(`Image: ${vision}`);
  if (text) parts.push(`Post text: "${text.slice(0, 500)}"`);
  if (subtitle) parts.push(`Transcript: "${subtitle.slice(0, 500)}"`);
  if (cleanTags) parts.push(`Tags: ${cleanTags}`);
  const context = parts.join("\n");

  const prompt = `${context}\n\nWhat is this about? Focus on the actual subject.\n\nRespond in exactly this format:\nTopic: <one sentence>\nCategory: <one word>`;

  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: TOPIC_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama topic ${res.status}`);
  const data = await res.json();
  const raw = (data.response || "").trim();
  const topicMatch = raw.match(/Topic:\s*(.+)/i);
  const categoryMatch = raw.match(/Category:\s*(\S+)/i);
  return {
    summary: topicMatch?.[1]?.trim() || null,
    category: categoryMatch?.[1]?.trim().replace(/['"]/g, "") || null,
  };
}

async function embed(summary, category, text, subtitle) {
  const parts = [summary, category, text, subtitle].filter(Boolean);
  const embedText = parts.join(" ").slice(0, 2000);
  if (embedText.length <= 10) return null;

  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: embedText }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
  const data = await res.json();
  return data.embeddings?.[0] || null;
}

async function processItem(item, cache) {
  const entry = cache[item.roostId];
  if (!entry) return false;

  // Stage 1: Topic analysis (vision desc already in cache from Gemma 4)
  if (!entry.summary) {
    const result = await topicAnalysis(entry.vision, item.text, item.subtitle, item.tags);
    entry.summary = result.summary;
    entry.category = result.category;
  }

  // Stage 2: Embedding
  if (!entry.vec) {
    entry.vec = await embed(entry.summary, entry.category, item.text, item.subtitle);
  }

  return !!entry.vec;
}

// ── Main ──────────────────────────────────────────────────────

const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
const items = scanItems(cache);
console.log(`Found ${items.length} items needing re-embedding`);

if (dryRun) {
  console.log("\nDry run. Use --run to process.");
  for (const item of items.slice(0, 10)) {
    const hasVision = !!cache[item.roostId]?.vision;
    const hasSub = !!item.subtitle;
    console.log(`  ${item.roostId} [vision:${hasVision} sub:${hasSub}] ${item.text.slice(0, 60)}`);
  }
  if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);
  process.exit(0);
}

const toProcess = items.slice(0, limit);
console.log(`Processing ${toProcess.length} items (concurrency: ${CONCURRENCY})...\n`);

let embedded = 0, errors = 0;
const failed = [];
const startTime = Date.now();

for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
  const batch = toProcess.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(batch.map(item => processItem(item, cache)));

  for (let j = 0; j < results.length; j++) {
    if (results[j].status === "fulfilled" && results[j].value) embedded++;
    else failed.push(batch[j]);
  }

  if ((i + CONCURRENCY) % 50 < CONCURRENCY || i + CONCURRENCY >= toProcess.length) {
    const done = Math.min(i + CONCURRENCY, toProcess.length);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (done / (Date.now() - startTime) * 1000).toFixed(1);
    const eta = ((toProcess.length - done) / rate / 60).toFixed(0);
    console.log(`  ${done}/${toProcess.length} (${embedded} embedded, ${failed.length} failed, ${elapsed}s, ~${eta}min left)`);
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
}

// Retry failed once
if (failed.length > 0) {
  console.log(`\nRetrying ${failed.length} failed items...`);
  let retryOk = 0;
  for (let i = 0; i < failed.length; i += CONCURRENCY) {
    const batch = failed.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(item => processItem(item, cache)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) retryOk++;
    }
  }
  embedded += retryOk;
  errors = failed.length - retryOk;
  if (retryOk > 0) console.log(`  Recovered ${retryOk} items`);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`\nDone in ${totalTime}min: ${embedded} embedded, ${errors} errors`);
