#!/usr/bin/env node
/**
 * Refresh TikTok note frontmatter from raw.json sidecar data.
 *
 * Fixes Eagle-imported notes that have:
 * - Truncated titles (from Eagle's 80-char limit)
 * - Missing stats (stats_plays, stats_likes, stats_comments, stats_shares)
 * - Missing sound field
 * - Raw JSON subtitle blobs instead of parsed text
 * - thumb.png cover references when cover.jpg now exists
 *
 * Run: node scripts/refresh-frontmatter.mjs [--dry-run]
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const VAULT_PATH = process.argv[2]?.startsWith("--")
  ? path.join(os.homedir(), "ObsidianBookmarks")
  : (process.argv[2] || path.join(os.homedir(), "ObsidianBookmarks"));
const DRY_RUN = process.argv.includes("--dry-run");
const TIKTOK_DIR = path.join(VAULT_PATH, "Bookmarks", "TikTok");

const t0 = Date.now();
let updated = 0, skipped = 0, noRaw = 0, errors = 0;
const changes = { title: 0, stats: 0, sound: 0, subtitle: 0, cover: 0, url: 0 };

// ── Helpers ──

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

function parseJsonSubtitle(jsonStr) {
  // Try full JSON parse first
  try {
    const data = JSON.parse(jsonStr);
    const utterances = data.utterances || data;
    if (!Array.isArray(utterances)) return null;
    return utterances
      .sort((a, b) => (a.start_time || 0) - (b.start_time || 0))
      .map(u => u.text)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() || null;
  } catch {
    // JSON is likely truncated — extract text fields with regex
    const texts = [];
    const re = /"text"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(jsonStr)) !== null) {
      texts.push(m[1].replace(/\\n/g, " ").replace(/\\"/g, '"'));
    }
    if (texts.length === 0) return null;
    return texts.join(" ").replace(/\s+/g, " ").trim() || null;
  }
}

/** Extract frontmatter block and body from a note file. */
function splitNote(content) {
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;
  const fmBlock = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5);
  return { fmBlock, body };
}

/**
 * Parse YAML frontmatter into ordered key-value pairs.
 * Preserves order, handles multi-line values (arrays, quoted strings).
 * Returns array of { key, rawLine, fullBlock } entries.
 */
function parseFrontmatterEntries(fmBlock) {
  const lines = fmBlock.split("\n");
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\w[\w_]*)\s*:/);
    if (m) {
      const key = m[1];
      let block = line;
      // Collect continuation lines (indented or array items)
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.match(/^\w[\w_]*\s*:/)) break; // next key
        block += "\n" + next;
        j++;
      }
      entries.push({ key, fullBlock: block });
      i = j;
    } else {
      // Orphan line — keep as-is
      entries.push({ key: null, fullBlock: line });
      i++;
    }
  }
  return entries;
}

/** Rebuild frontmatter string from entries. */
function rebuildFrontmatter(entries) {
  return entries.map(e => e.fullBlock).join("\n");
}

/** YAML-escape a string value. */
function yamlStr(val) {
  if (val === undefined || val === null) return '""';
  const s = String(val);
  if (s.includes('"') && s.includes("'")) return `"${s.replace(/"/g, '\\"')}"`;
  if (s.includes('"') || s.includes(":") || s.includes("#") || s.includes("\n") || s.startsWith("[") || s.startsWith("{")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${s}"`;
}

/** Get the first meaningful line of desc for title (no hashtags-only lines). */
function extractTitle(desc) {
  if (!desc) return null;
  // Clean up: first 200 chars, remove leading/trailing whitespace, collapse newlines
  let title = desc.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  // Cap at reasonable length
  if (title.length > 300) title = title.slice(0, 300);
  return title || null;
}

// ── Main ──

const mdFiles = fs.readdirSync(TIKTOK_DIR).filter(f => f.endsWith(".md"));
console.log(`Scanning ${mdFiles.length} TikTok notes...`);

for (const mdFile of mdFiles) {
  const mdPath = path.join(TIKTOK_DIR, mdFile);
  let content;
  try {
    content = fs.readFileSync(mdPath, "utf-8");
  } catch (e) {
    errors++;
    continue;
  }

  const split = splitNote(content);
  if (!split) { skipped++; continue; }

  // Find roost_id to locate attach folder
  const idMatch = split.fmBlock.match(/roost_id:\s*"?tiktok:(\d+)"?/);
  if (!idMatch) { skipped++; continue; }
  const itemId = idMatch[1];
  const attachFolder = path.join(TIKTOK_DIR, `tiktok-${itemId}`);
  const rawPath = path.join(attachFolder, "raw.json");

  let raw = null;
  const hasRaw = fs.existsSync(rawPath);
  if (hasRaw) {
    try {
      raw = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
    } catch (e) {
      errors++;
    }
  } else {
    noRaw++;
  }

  const entries = parseFrontmatterEntries(split.fmBlock);
  const entryMap = new Map(entries.filter(e => e.key).map(e => [e.key, e]));
  let changed = false;
  const fileChanges = [];

  // ── 1. Title: update if raw.desc is longer ──
  if (raw) {
    const rawTitle = extractTitle(raw.desc);
    if (rawTitle) {
      const titleEntry = entryMap.get("title");
      if (titleEntry) {
        const currentMatch = titleEntry.fullBlock.match(/^title:\s*"?(.*?)"?\s*$/);
        const currentTitle = currentMatch ? currentMatch[1] : "";
        if (rawTitle.length > currentTitle.length + 5) {
          titleEntry.fullBlock = `title: ${yamlStr(rawTitle)}`;
          changed = true;
          fileChanges.push("title");
          changes.title++;
        }
      }
    }
  }

  // ── 2. Stats: add if missing ──
  if (raw?.stats && !entryMap.has("stats_plays")) {
    const stats = raw.stats;
    const tagsIdx = entries.findIndex(e => e.key === "tags");
    const insertIdx = tagsIdx !== -1 ? tagsIdx : entries.length;
    const statsEntries = [
      { key: "stats_plays", fullBlock: `stats_plays: ${stats.playCount || 0}` },
      { key: "stats_likes", fullBlock: `stats_likes: ${stats.diggCount || 0}` },
      { key: "stats_comments", fullBlock: `stats_comments: ${stats.commentCount || 0}` },
      { key: "stats_shares", fullBlock: `stats_shares: ${stats.shareCount || 0}` },
    ];
    entries.splice(insertIdx, 0, ...statsEntries);
    changed = true;
    fileChanges.push("stats");
    changes.stats++;
  }

  // ── 3. Sound: add if missing ──
  if (raw?.music?.title && !entryMap.has("sound")) {
    const music = raw.music;
    const soundVal = music.authorName
      ? `${music.title} — ${music.authorName}`
      : music.title;
    const afterKey = entryMap.has("collection") ? "collection" : "author";
    const afterIdx = entries.findIndex(e => e.key === afterKey);
    const insertIdx = afterIdx !== -1 ? afterIdx + 1 : entries.length;
    entries.splice(insertIdx, 0, { key: "sound", fullBlock: `sound: ${yamlStr(soundVal)}` });
    changed = true;
    fileChanges.push("sound");
    changes.sound++;
  }

  // ── 3b. Sound: fix broken values from previous oembed run (contains href HTML) ──
  const soundEntry = entryMap.get("sound");
  if (soundEntry && soundEntry.fullBlock.includes("href")) {
    // Extract clean sound: find the last "♬ title — author" or "♬ title - author" pattern
    const m = soundEntry.fullBlock.match(/\u266c\s*([^"\\]+)/);
    if (m) {
      const raw = m[1].trim();
      const dashIdx = raw.lastIndexOf(" - ");
      const cleanSound = dashIdx !== -1 ? `${raw.slice(0, dashIdx)} — ${raw.slice(dashIdx + 3)}` : raw;
      soundEntry.fullBlock = `sound: ${yamlStr(cleanSound)}`;
      changed = true;
      fileChanges.push("sound-fix");
      changes.sound++;
    }
  }

  // ── 4. Subtitle: fix JSON blobs (works with or without raw.json) ──
  const subtitleEntry = entryMap.get("subtitle");
  if (subtitleEntry && subtitleEntry.fullBlock.includes("{")) {
    const jsonMatch = subtitleEntry.fullBlock.match(/^subtitle:\s*"?(.*)/s);
    if (jsonMatch) {
      let newSubtitle = null;
      // First try subtitle.vtt file
      const vttPath = path.join(attachFolder, "subtitle.vtt");
      if (fs.existsSync(vttPath)) {
        const vttContent = fs.readFileSync(vttPath, "utf-8");
        if (vttContent.startsWith("WEBVTT")) {
          newSubtitle = parseWebVTT(vttContent);
        } else {
          newSubtitle = parseJsonSubtitle(vttContent);
        }
      }
      // Fallback: extract text from truncated JSON blob in frontmatter
      if (!newSubtitle) {
        let rawJson = subtitleEntry.fullBlock.replace(/^subtitle:\s*/, "");
        if (rawJson.startsWith('"') && rawJson.endsWith('"')) {
          rawJson = rawJson.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
        newSubtitle = parseJsonSubtitle(rawJson);
      }
      if (newSubtitle && newSubtitle.length > 10) {
        subtitleEntry.fullBlock = `subtitle: ${yamlStr(newSubtitle)}`;
        changed = true;
        fileChanges.push("subtitle");
        changes.subtitle++;
      }
    }
  }

  // ── 5. Cover: upgrade thumb.png → cover.jpg if available ──
  const coverEntry = entryMap.get("cover");
  if (coverEntry && coverEntry.fullBlock.includes("thumb.png")) {
    const coverJpgPath = path.join(attachFolder, "cover.jpg");
    if (fs.existsSync(coverJpgPath)) {
      coverEntry.fullBlock = coverEntry.fullBlock.replace("thumb.png", "cover.jpg");
      changed = true;
      fileChanges.push("cover");
      changes.cover++;
    }
  }

  // ── 6. URL: construct from author + video ID if missing ──
  if (!entryMap.has("url")) {
    const authorEntry = entryMap.get("author");
    if (authorEntry) {
      const handleMatch = authorEntry.fullBlock.match(/@([^\]"]+)/);
      if (handleMatch) {
        const url = `https://www.tiktok.com/@${handleMatch[1]}/video/${itemId}`;
        // Insert after author
        const afterIdx = entries.indexOf(authorEntry);
        entries.splice(afterIdx + 1, 0, { key: "url", fullBlock: `url: ${url}` });
        changed = true;
        fileChanges.push("url");
        changes.url++;
      }
    }
  }

  if (!changed) { skipped++; continue; }

  // Rebuild file
  const newFm = rebuildFrontmatter(entries);
  const newContent = `---\n${newFm}\n---\n${split.body}`;

  if (DRY_RUN) {
    console.log(`[DRY] ${mdFile}: ${fileChanges.join(", ")}`);
  } else {
    try {
      fs.writeFileSync(mdPath, newContent, "utf-8");
    } catch (e) {
      console.error(`[ERR] ${mdFile}: ${e.message}`);
      errors++;
      continue;
    }
  }
  updated++;
  if (updated % 500 === 0) console.log(`  ...${updated} updated`);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s${DRY_RUN ? " (dry run)" : ""}`);
console.log(`Updated: ${updated}, Skipped: ${skipped}, No raw.json: ${noRaw}, Errors: ${errors}`);
console.log(`Changes: title=${changes.title}, stats=${changes.stats}, sound=${changes.sound}, subtitle=${changes.subtitle}, cover=${changes.cover}, url=${changes.url}`);
