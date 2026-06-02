#!/usr/bin/env node
/**
 * Backfill subtitle transcripts for TikTok items in the vault.
 * Scrapes video pages for subtitle URLs embedded in page HTML,
 * downloads WebVTT, parses to plain text, and writes `subtitle:` to note frontmatter.
 *
 * Usage:
 *   node scripts/fill-subtitles.mjs              # dry run — count items
 *   node scripts/fill-subtitles.mjs --run        # process all
 *   node scripts/fill-subtitles.mjs --run -n 50  # process first 50
 */
import fs from "fs";
import path from "path";
import os from "os";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const BOOKMARKS_PATH = path.join(VAULT_PATH, "Bookmarks");
const DELAY_MS = 800; // per-request delay to avoid rate limits
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const dryRun = !process.argv.includes("--run");
const limitIdx = process.argv.indexOf("-n");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

// ── WebVTT parser ─────────────────────────────────────────────

function parseWebVTT(vtt) {
  return vtt
    .split("\n")
    .filter(line => {
      const t = line.trim();
      if (!t) return false;
      if (t === "WEBVTT") return false;
      if (t.includes("-->")) return false;
      if (/^\d+$/.test(t)) return false;
      if (t.startsWith("NOTE") || t.startsWith("STYLE")) return false;
      return true;
    })
    .map(line => line.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .filter((line, i, arr) => i === 0 || line !== arr[i - 1])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Pick best subtitle track ──────────────────────────────────

function pickSubtitleUrl(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null;
  const scored = infos
    .filter(s => s.Url || s.url)
    .map(s => {
      const source = (s.Source || s.source || "").toLowerCase();
      const lang = (s.LanguageCodeName || s.languageCodeName || "").toLowerCase();
      return {
        url: (s.Url || s.url).replace(/\\u002F/g, "/"),
        score: (source === "creator" ? 4 : source === "asr" ? 2 : 0)
             + (lang.startsWith("eng") ? 1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.url || null;
}

// ── Scrape subtitle info from TikTok video page ───────────────

async function scrapeSubtitleInfos(videoId, username) {
  // Build video URL — use username if available, otherwise try a generic path
  const videoUrl = username
    ? `https://www.tiktok.com/@${username}/video/${videoId}`
    : `https://www.tiktok.com/video/${videoId}`;

  const res = await fetch(videoUrl, {
    headers: { "User-Agent": UA, "Accept": "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extract subtitleInfos from the embedded JSON in the page
  const match = html.match(/"subtitleInfos"\s*:\s*(\[[^\]]*\])/);
  if (!match) return null;

  try {
    // The JSON uses \u002F escapes — JSON.parse handles them
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// ── Fetch subtitle WebVTT ─────────────────────────────────────

async function fetchSubtitle(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  return await res.text();
}

// ── Scan vault for TikTok notes without subtitles ─────────────

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

      // Must be a TikTok note (roost_id may be quoted or unquoted)
      const idMatch = fm.match(/^roost_id:\s*"?tiktok:(\S+?)"?\s*$/m);
      if (!idMatch) continue;

      // Skip if already has subtitle
      if (/^subtitle:/m.test(fm)) continue;

      // Extract username from URL field for page scraping
      const urlMatch = fm.match(/^url:\s*https:\/\/www\.tiktok\.com\/@([^/]+)\/video/m);
      const username = urlMatch?.[1] || null;

      notes.push({ filePath: full, videoId: idMatch[1], username });
    }
  }

  walk(BOOKMARKS_PATH);
  return notes;
}

// ── Update note frontmatter with subtitle ─────────────────────

function writeSubtitleToNote(filePath, subtitle) {
  const content = fs.readFileSync(filePath, "utf8");
  const fmEnd = content.indexOf("\n---", 4);
  if (fmEnd < 0) return false;

  // Escape for YAML
  const escaped = subtitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const subtitleLine = `subtitle: "${escaped}"`;

  // Insert before the closing ---
  const updated = content.slice(0, fmEnd) + "\n" + subtitleLine + content.slice(fmEnd);
  fs.writeFileSync(filePath, updated);
  return true;
}

// ── Main ──────────────────────────────────────────────────────

const notes = scanVaultNotes();
console.log(`Found ${notes.length} TikTok notes without subtitles`);

if (dryRun) {
  console.log("\nDry run. Use --run to process.");
  for (const note of notes.slice(0, 10)) {
    console.log(`  tiktok:${note.videoId} → ${path.basename(note.filePath)}`);
  }
  if (notes.length > 10) console.log(`  ... and ${notes.length - 10} more`);
  process.exit(0);
}

const toProcess = notes.slice(0, limit);
console.log(`Processing ${toProcess.length} items...\n`);

let scraped = 0, subtitled = 0, noSubs = 0, errors = 0;
const startTime = Date.now();

for (let i = 0; i < toProcess.length; i++) {
  const note = toProcess[i];

  try {
    // Scrape video page for subtitle info
    const infos = await scrapeSubtitleInfos(note.videoId, note.username);
    scraped++;

    if (!infos) { noSubs++; continue; }

    const subtitleUrl = pickSubtitleUrl(infos);
    if (!subtitleUrl) { noSubs++; continue; }

    // Fetch and parse WebVTT
    const vtt = await fetchSubtitle(subtitleUrl);
    if (!vtt) { noSubs++; continue; }

    const text = parseWebVTT(vtt);
    if (text.length <= 10) { noSubs++; continue; }

    // Write to frontmatter
    const subtitle = text.slice(0, 1500);
    if (writeSubtitleToNote(note.filePath, subtitle)) {
      subtitled++;
    }
  } catch (e) {
    errors++;
    if (e.message?.includes("429") || e.message?.includes("rate")) {
      console.log(`\n  Rate limited at item ${i + 1}, waiting 30s...`);
      await new Promise(r => setTimeout(r, 30000));
      i--; // retry
      errors--; // don't count rate limit as error
      continue;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if ((i + 1) % 50 === 0 || i + 1 === toProcess.length) {
    console.log(`  ${i + 1}/${toProcess.length} (${subtitled} subtitled, ${noSubs} no subs, ${errors} errors, ${elapsed}s)`);
  }

  // Rate limit delay
  if (i < toProcess.length - 1) {
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nDone in ${totalTime}s: ${scraped} scraped, ${subtitled} subtitled, ${noSubs} no subtitles available, ${errors} errors`);
