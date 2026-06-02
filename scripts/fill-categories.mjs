#!/usr/bin/env node
/**
 * Fill missing category/summary fields in the embedding cache.
 * Runs Ollama topic analysis (stage 2) on items that have vectors but no summary.
 *
 * Usage:
 *   node scripts/fill-categories.mjs              # dry run — show counts
 *   node scripts/fill-categories.mjs --run        # actually call Ollama
 *   node scripts/fill-categories.mjs --run --max=500  # limit to 500 items
 */
import fs from "fs";
import path from "path";
import os from "os";

const OLLAMA = "http://localhost:11434";
const MODEL = "llama3.2:3b";
const CONCURRENCY = 3;
const CACHE_PATH = path.join(os.homedir(), "ObsidianBookmarks", ".roost", "embedding-cache.json");

const args = process.argv.slice(2);
const dryRun = !args.includes("--run");
const maxArg = args.find(a => a.startsWith("--max="));
const maxItems = maxArg ? parseInt(maxArg.split("=")[1], 10) : Infinity;

// Load cache
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

// Find items needing topic analysis
const needsWork = [];
for (const [id, entry] of Object.entries(cache)) {
  if (!entry.vec) continue;
  if (entry.summary && entry.category) continue;
  needsWork.push(id);
}

console.log(`Cache: ${Object.keys(cache).length} entries`);
console.log(`Need topic analysis: ${needsWork.length}`);
console.log(`Will process: ${Math.min(needsWork.length, maxItems)}`);

if (dryRun) {
  console.log("\nDry run. Use --run to process.");
  // Show sample of what's missing
  for (const id of needsWork.slice(0, 5)) {
    const e = cache[id];
    console.log(`  ${id}: vision=${e.vision ? "yes" : "no"} summary=${e.summary ? "yes" : "no"} category=${e.category ? "yes" : "no"}`);
  }
  process.exit(0);
}

// Process
const toProcess = needsWork.slice(0, maxItems);
let processed = 0, errors = 0;
const startTime = Date.now();

async function analyzeItem(id) {
  const entry = cache[id];
  const parts = [];
  if (entry.vision) parts.push(`Image: ${entry.vision}`);
  // Use whatever text we have — desc is from vision, or we might have nothing
  if (parts.length === 0) {
    // Skip items with literally nothing to analyze
    return false;
  }

  const prompt = `${parts.join("\n")}\n\nWhat is this about? Focus on the actual subject.\n\nRespond in exactly this format:\nTopic: <one sentence>\nCategory: <one word>`;

  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    const raw = (data.response || "").trim();
    const topicMatch = raw.match(/Topic:\s*(.+)/i);
    const categoryMatch = raw.match(/Category:\s*(\S+)/i);
    entry.summary = topicMatch?.[1]?.trim() || null;
    entry.category = categoryMatch?.[1]?.trim().replace(/['"]/g, "") || null;
    return !!(entry.summary || entry.category);
  } catch (e) {
    return false;
  }
}

for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
  const batch = toProcess.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(batch.map(id => analyzeItem(id)));
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) processed++;
    else errors++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = ((i + batch.length) / ((Date.now() - startTime) / 1000)).toFixed(1);
  process.stdout.write(`\r  ${i + batch.length}/${toProcess.length} (${processed} filled, ${errors} failed, ${rate}/s, ${elapsed}s)`);

  // Save every 100 items
  if ((i + batch.length) % 100 < CONCURRENCY) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
}

// Final save
fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nDone in ${totalTime}s: ${processed} filled, ${errors} failed`);

// Verify
let stillMissing = 0;
for (const [id, entry] of Object.entries(cache)) {
  if (entry.vec && !entry.category) stillMissing++;
}
console.log(`Still missing category: ${stillMissing}`);
