#!/usr/bin/env node
/**
 * Fill missing vision descriptions (vision field) in the embedding cache.
 * Runs minicpm-v on cover images for items that have vectors but no vision.
 * Then runs topic analysis on the newly described items.
 *
 * Usage:
 *   node scripts/fill-vision.mjs              # dry run
 *   node scripts/fill-vision.mjs --run        # process
 */
import fs from "fs";
import path from "path";
import os from "os";

const OLLAMA = "http://localhost:11434";
const VISION_MODEL = "minicpm-v";
const TOPIC_MODEL = "llama3.2:3b";
const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");

const dryRun = !process.argv.includes("--run");

const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

// Find items with vec but no vision that have cover images
const needsVision = [];
for (const [id, entry] of Object.entries(cache)) {
  if (!entry.vec || entry.vision) continue;
  const match = id.match(/^(tiktok|twitter):(.+)/);
  if (!match) continue;
  const [, platform, itemId] = match;
  const platformFolder = platform === "tiktok" ? "TikTok" : "X";
  const attachFolder = path.join(VAULT_PATH, "Bookmarks", platformFolder, `${platform}-${itemId}`);
  try {
    const files = fs.readdirSync(attachFolder);
    const coverFile = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (coverFile) {
      needsVision.push({ id, coverPath: path.join(attachFolder, coverFile) });
    }
  } catch {}
}

console.log(`Found ${needsVision.length} items with cover images but no vision description`);

if (dryRun) {
  console.log("\nDry run. Use --run to process.");
  for (const item of needsVision.slice(0, 5)) {
    console.log(`  ${item.id} → ${path.basename(item.coverPath)}`);
  }
  process.exit(0);
}

let described = 0, analyzed = 0, errors = 0;
const startTime = Date.now();

for (let i = 0; i < needsVision.length; i++) {
  const item = needsVision[i];
  const entry = cache[item.id];

  try {
    // Stage 1: Vision
    const imageData = fs.readFileSync(item.coverPath);
    const base64 = imageData.toString("base64");
    const visionRes = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: "Describe what you see in this image in one sentence. Be specific about the subject matter.",
        images: [base64],
        stream: false,
      }),
    });
    if (!visionRes.ok) throw new Error(`Vision ${visionRes.status}`);
    const visionData = await visionRes.json();
    entry.vision = (visionData.response || "").trim().slice(0, 300) || null;
    if (entry.vision) described++;

    // Stage 2: Topic analysis
    if (entry.vision && !entry.summary) {
      const prompt = `Image: ${entry.vision}\n\nWhat is this about? Focus on the actual subject.\n\nRespond in exactly this format:\nTopic: <one sentence>\nCategory: <one word>`;
      const topicRes = await fetch(`${OLLAMA}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TOPIC_MODEL, prompt, stream: false }),
      });
      if (topicRes.ok) {
        const raw = ((await topicRes.json()).response || "").trim();
        const topicMatch = raw.match(/Topic:\s*(.+)/i);
        const categoryMatch = raw.match(/Category:\s*(\S+)/i);
        entry.summary = topicMatch?.[1]?.trim() || null;
        entry.category = categoryMatch?.[1]?.trim().replace(/['"]/g, "") || null;
        if (entry.summary) analyzed++;
      }
    }
  } catch (e) {
    errors++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r  ${i + 1}/${needsVision.length} (${described} described, ${analyzed} analyzed, ${errors} errors, ${elapsed}s)`);

  // Save every 20 items
  if ((i + 1) % 20 === 0) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
}

fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nDone in ${totalTime}s: ${described} described, ${analyzed} analyzed, ${errors} errors`);
