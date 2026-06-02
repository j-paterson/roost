#!/usr/bin/env node
/**
 * Enrich vision descriptions for TikTok videos that lack speech transcripts.
 * Extracts keyframes from the video via ffmpeg, describes each with minicpm-v,
 * and writes a richer combined description to the embedding cache.
 *
 * Targets items with subtitle_type: music|silent, or videos without any subtitle.
 * Skips items with subtitle_type: speech (they already have rich text from Whisper).
 *
 * Usage:
 *   node scripts/fill-frames.mjs              # dry run — count items (silent/music only)
 *   node scripts/fill-frames.mjs --run        # process silent/music items
 *   node scripts/fill-frames.mjs --all        # dry run — count ALL items with video
 *   node scripts/fill-frames.mjs --all --run  # redo ALL visual descriptions with Gemma 4
 *   node scripts/fill-frames.mjs --run -n 50  # process first 50
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const BOOKMARKS_PATH = path.join(VAULT_PATH, "Bookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");
const OLLAMA = "http://localhost:11434";
const VISION_MODEL = "gemma4:e4b";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const NUM_FRAMES = 3;

const dryRun = !process.argv.includes("--run");
const allMode = process.argv.includes("--all");
const limitIdx = process.argv.indexOf("-n");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

// ── Extract keyframes from video ──────────────────────────────

function getVideoDuration(mp4Path) {
  try {
    const out = execFileSync(FFPROBE, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "csv=p=0", mp4Path,
    ], { encoding: "utf8", timeout: 10000 });
    return parseFloat(out.trim());
  } catch {
    return null;
  }
}

function extractFrames(mp4Path, duration) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-frames-"));
  const framePaths = [];

  // Extract frames at 25%, 50%, 75% of duration
  const positions = [0.25, 0.5, 0.75];
  for (let i = 0; i < positions.length; i++) {
    const time = (duration * positions[i]).toFixed(2);
    const framePath = path.join(tmpDir, `frame_${i}.jpg`);
    try {
      execFileSync(FFMPEG, [
        "-ss", time, "-i", mp4Path,
        "-frames:v", "1", "-q:v", "2",
        "-y", "-loglevel", "error", framePath,
      ], { timeout: 15000 });
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 100) {
        framePaths.push(framePath);
      }
    } catch {}
  }

  return { tmpDir, framePaths };
}

function cleanupFrames(tmpDir) {
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    fs.rmdirSync(tmpDir);
  } catch {}
}

// ── Vision analysis via Ollama (multi-image, single call) ─────

async function describeVideo(framePaths) {
  const images = framePaths.map(p => fs.readFileSync(p).toString("base64"));
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: "These are frames from the beginning, middle, and end of a short video. Describe what happens in this video in 2-3 sentences. Be specific about the subject matter, actions, and any changes between frames.",
      images,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return (data.response || "").trim().slice(0, 800) || null;
}

// ─��� Scan vault ────────────────────────────────────────────────

function scanVaultNotes() {
  const notes = [];

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

      const idMatch = fm.match(/^roost_id:\s*"?tiktok:(\S+?)"?\s*$/m);
      if (!idMatch) continue;
      const roostId = `tiktok:${idMatch[1]}`;

      // In default mode, skip items with speech — they have rich text already
      // In --all mode, process everything with a video
      if (!allMode) {
        const typeMatch = fm.match(/^subtitle_type:\s*"?(\w+)"?/m);
        if (typeMatch?.[1] === "speech") continue;
        const hasSubtitle = /^subtitle:/m.test(fm);
        if (hasSubtitle && !typeMatch) continue;
      }

      // Find MP4
      const coverMatch = fm.match(/^cover:\s*"?\[\[([^\]]+)\]\]"?/m);
      if (!coverMatch) continue;
      const attachFolder = path.join(VAULT_PATH, path.dirname(coverMatch[1]));
      let mp4Path = null;
      try {
        const files = fs.readdirSync(attachFolder);
        const mp4 = files.find(f => f.endsWith(".mp4"));
        if (mp4) mp4Path = path.join(attachFolder, mp4);
      } catch {}
      if (!mp4Path) continue;

      const type = fm.match(/^subtitle_type:\s*"?(\w+)"?/m)?.[1] || "unknown";
      notes.push({
        filePath: full,
        roostId,
        mp4Path,
        contentType: type,
      });
    }
  }

  walk(path.join(BOOKMARKS_PATH, "TikTok"));
  return notes;
}

// ── Main ─────��─────────────────────���──────────────────────────

const notes = scanVaultNotes();
console.log(`Found ${notes.length} TikTok videos needing vision enrichment`);
const byType = {};
for (const n of notes) byType[n.contentType] = (byType[n.contentType] || 0) + 1;
console.log(`  Breakdown:`, byType);

if (dryRun) {
  console.log("\nDry run. Use --run to process.");
  for (const note of notes.slice(0, 10)) {
    console.log(`  ${note.roostId} [${note.contentType}] → ${path.basename(note.mp4Path)}`);
  }
  if (notes.length > 10) console.log(`  ... and ${notes.length - 10} more`);
  process.exit(0);
}

const toProcess = notes.slice(0, limit);
console.log(`Processing ${toProcess.length} items...\n`);

const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

let enriched = 0, skipped = 0, errors = 0;
let invalidated = 0;
const startTime = Date.now();

for (let i = 0; i < toProcess.length; i++) {
  const note = toProcess[i];

  try {
    const duration = getVideoDuration(note.mp4Path);
    if (!duration || duration < 1) { skipped++; continue; }

    const { tmpDir, framePaths } = extractFrames(note.mp4Path, duration);

    if (framePaths.length === 0) {
      cleanupFrames(tmpDir);
      skipped++;
      continue;
    }

    // Describe all frames in a single call
    const combined = await describeVideo(framePaths);
    cleanupFrames(tmpDir);

    if (!combined) { skipped++; continue; }

    // Update embedding cache
    const entry = cache[note.roostId];
    if (entry) {
      entry.vision = combined;
      entry.vec = null;
      entry.summary = null;
      entry.category = null;
      invalidated++;
    }
    enriched++;
  } catch (e) {
    errors++;
    if (errors <= 5) console.log(`\n  Error on ${note.roostId}: ${e.message}`);
  }

  if ((i + 1) % 20 === 0 || i + 1 === toProcess.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = ((i + 1) / (Date.now() - startTime) * 1000).toFixed(2);
    const eta = ((toProcess.length - i - 1) / rate / 60).toFixed(0);
    console.log(`  ${i + 1}/${toProcess.length} (${enriched} enriched, ${skipped} skipped, ${errors} errors, ${elapsed}s, ~${eta}min left)`);
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
}

fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`\nDone in ${totalTime}min: ${enriched} enriched, ${skipped} skipped, ${errors} errors`);
console.log(`Invalidated ${invalidated} embedding cache entries.`);
if (invalidated > 0) {
  console.log(`Run Smart Assign from the plugin to re-embed these items.`);
}
