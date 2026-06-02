#!/usr/bin/env node
/**
 * Backfill subtitle transcripts for TikTok videos via local Whisper.
 * Spawns a long-running Python whisper-worker.py process, sends MP4 paths,
 * writes transcripts to `subtitle:` frontmatter, and invalidates embedding cache.
 *
 * Usage:
 *   node scripts/fill-whisper.mjs              # dry run — count items
 *   node scripts/fill-whisper.mjs --run        # process all
 *   node scripts/fill-whisper.mjs --run -n 50  # process first 50
 */
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const BOOKMARKS_PATH = path.join(VAULT_PATH, "Bookmarks");
const CACHE_PATH = path.join(VAULT_PATH, ".roost", "embedding-cache.json");
const PYTHON = path.join(VAULT_PATH, ".roost", "venv", "bin", "python");
const WORKER_SCRIPT = path.join(__dirname, "whisper-worker.py");

const dryRun = !process.argv.includes("--run");
const limitIdx = process.argv.indexOf("-n");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

// ── Hallucination filter ──────────────────────────────────────

const HALLUCINATION_PATTERNS = [
  /^(thank(s| you)[\s.,!]*)+$/i,
  /^(subscribe[\s.,!]*)+$/i,
  /^(music[\s.,!]*)+$/i,
  /^(applause[\s.,!]*)+$/i,
  /^(laughter[\s.,!]*)+$/i,
  /^\[.*\]$/,                         // [Music], [Applause], etc.
];

/**
 * Classify Whisper output into content type.
 * Returns: "speech" | "music" | "silent"
 */
function classifyWhisperOutput(text) {
  if (!text || text.length < 10) return "silent";
  for (const pat of HALLUCINATION_PATTERNS) {
    if (pat.test(text)) return "silent";
  }
  // Repeated phrase detection → likely music lyrics or hallucination
  const words = text.split(/\s+/);
  if (words.length >= 15) {
    const phrase = words.slice(0, 5).join(" ").toLowerCase();
    const count = text.toLowerCase().split(phrase).length - 1;
    if (count >= 3) return "music";
  }
  return "speech";
}

// ── Scan vault for TikTok notes without subtitles + with MP4 ──

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

      // Must be a TikTok note
      const idMatch = fm.match(/^roost_id:\s*"?tiktok:(\S+?)"?\s*$/m);
      if (!idMatch) continue;
      const roostId = `tiktok:${idMatch[1]}`;

      // Skip if already has subtitle or has been classified
      if (/^subtitle:/m.test(fm)) continue;
      if (/^subtitle_type:/m.test(fm)) continue;

      // Find MP4 in attachment folder (derive from cover path — may be quoted)
      const coverMatch = fm.match(/^cover:\s*"?\[\[([^\]]+)\]\]"?/m);
      if (!coverMatch) continue;
      const coverPath = coverMatch[1];
      const attachFolder = path.join(VAULT_PATH, path.dirname(coverPath));

      let mp4Path = null;
      try {
        const files = fs.readdirSync(attachFolder);
        const mp4 = files.find(f => f.endsWith(".mp4"));
        if (mp4) mp4Path = path.join(attachFolder, mp4);
      } catch {}

      if (!mp4Path) continue;
      notes.push({ filePath: full, roostId, mp4Path });
    }
  }

  walk(path.join(BOOKMARKS_PATH, "TikTok"));
  return notes;
}

// ── Update note frontmatter ───────────────────────────────────

function writeFrontmatterFields(filePath, fields) {
  const content = fs.readFileSync(filePath, "utf8");
  const fmEnd = content.indexOf("\n---", 4);
  if (fmEnd < 0) return false;
  const lines = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    const escaped = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`${k}: "${escaped}"`);
  }
  if (lines.length === 0) return false;
  const updated = content.slice(0, fmEnd) + "\n" + lines.join("\n") + content.slice(fmEnd);
  fs.writeFileSync(filePath, updated);
  return true;
}

// ── Invalidate embedding cache entry ──────────────────────────

function invalidateEmbedding(cache, roostId) {
  const entry = cache[roostId];
  if (!entry) return;
  entry.vec = null;
  entry.summary = null;
  entry.category = null;
}

// ── Whisper worker IPC ────────────────────────────────────────

function startWorker() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: proc.stdout });

    // Relay stderr for logging
    const stderrRl = readline.createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      console.log(`  [worker] ${line}`);
    });

    // Wait for "ready" signal
    rl.once("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.status === "ready") {
          resolve({ proc, rl });
        } else {
          reject(new Error("Worker did not signal ready"));
        }
      } catch (e) {
        reject(new Error(`Worker startup failed: ${line}`));
      }
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

function transcribe(worker, mp4Path) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 180000);
    worker.rl.once("line", (line) => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(line);
        if (result.error) reject(new Error(result.error));
        else resolve(result.text || "");
      } catch (e) { reject(e); }
    });
    worker.proc.stdin.write(mp4Path + "\n");
  });
}

// ── Main ──────────────────────────────────────────────────────

const notes = scanVaultNotes();
console.log(`Found ${notes.length} TikTok videos without subtitles`);

if (dryRun) {
  console.log("\nDry run. Use --run to process.");
  for (const note of notes.slice(0, 10)) {
    console.log(`  ${note.roostId} → ${path.basename(note.mp4Path)} (${(fs.statSync(note.mp4Path).size / 1024 / 1024).toFixed(1)}MB)`);
  }
  if (notes.length > 10) console.log(`  ... and ${notes.length - 10} more`);
  process.exit(0);
}

const toProcess = notes.slice(0, limit);
console.log(`Processing ${toProcess.length} items...\n`);

// Load embedding cache
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

let transcribed = 0, music = 0, silent = 0, errors = 0;
let invalidated = 0;
const startTime = Date.now();

let worker;
try {
  worker = await startWorker();
} catch (e) {
  console.error(`Failed to start whisper worker: ${e.message}`);
  process.exit(1);
}

for (let i = 0; i < toProcess.length; i++) {
  const note = toProcess[i];

  try {
    const text = await transcribe(worker, note.mp4Path);
    const contentType = classifyWhisperOutput(text);

    if (contentType === "speech") {
      const subtitle = text.slice(0, 1500);
      writeFrontmatterFields(note.filePath, { subtitle, subtitle_type: "speech" });
      transcribed++;
      invalidateEmbedding(cache, note.roostId);
      invalidated++;
    } else if (contentType === "music") {
      // Keep lyrics — they're weak signal but not nothing
      const lyrics = text?.slice(0, 500) || null;
      writeFrontmatterFields(note.filePath, { subtitle_type: "music", ...(lyrics && { lyrics }) });
      music++;
    } else {
      writeFrontmatterFields(note.filePath, { subtitle_type: "silent" });
      silent++;
    }
  } catch (e) {
    errors++;
    if (errors <= 3) console.log(`\n  Error on ${note.roostId}: ${e.message}`);
  }

  if ((i + 1) % 50 === 0 || i + 1 === toProcess.length) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = ((i + 1) / (Date.now() - startTime) * 1000).toFixed(1);
    const eta = ((toProcess.length - i - 1) / rate / 60).toFixed(0);
    console.log(`  ${i + 1}/${toProcess.length} (${transcribed} speech, ${music} music, ${silent} silent, ${errors} errors, ${elapsed}s, ~${eta}min left)`);
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
}

// Final save
fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

// Clean up worker
worker.proc.stdin.end();
worker.proc.kill();

const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`\nDone in ${totalTime}min: ${transcribed} speech, ${music} music, ${silent} silent, ${errors} errors`);
console.log(`Invalidated ${invalidated} embedding cache entries.`);
if (invalidated > 0) {
  console.log(`Run Smart Assign from the plugin to re-embed these items.`);
}
