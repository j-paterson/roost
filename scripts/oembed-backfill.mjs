#!/usr/bin/env node
/**
 * Backfill notes missing raw.json by fetching TikTok oEmbed + generating a
 * minimal raw.json sidecar. Also fixes frontmatter sound field.
 *
 * For items where oEmbed fails (deleted/private videos), generates raw.json
 * from existing frontmatter so scanIncompleteIds stops flagging them.
 *
 * Run: node scripts/oembed-backfill.mjs [--dry-run]
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const VAULT_PATH = path.join(os.homedir(), "ObsidianBookmarks");
const DRY_RUN = process.argv.includes("--dry-run");
const TIKTOK_DIR = path.join(VAULT_PATH, "Bookmarks", "TikTok");

const t0 = Date.now();
let updated = 0, skipped = 0, oembedOk = 0, oembedFail = 0;
const changes = { title: 0, sound: 0, rawJson: 0 };

// ── Helpers ──

function splitNote(content) {
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;
  return { fmBlock: content.slice(4, endIdx), body: content.slice(endIdx + 5) };
}

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
      let j = i + 1;
      while (j < lines.length) {
        if (lines[j].match(/^\w[\w_]*\s*:/)) break;
        block += "\n" + lines[j];
        j++;
      }
      entries.push({ key, fullBlock: block });
      i = j;
    } else {
      entries.push({ key: null, fullBlock: line });
      i++;
    }
  }
  return entries;
}

function getFmValue(entryMap, key) {
  const e = entryMap.get(key);
  if (!e) return null;
  const m = e.fullBlock.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`));
  return m ? m[1] : null;
}

function yamlStr(val) {
  const s = String(val);
  if (s.includes('"') || s.includes(":") || s.includes("#") || s.includes("\n") || s.startsWith("[") || s.startsWith("{")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${s}"`;
}

function extractSoundFromHtml(html) {
  const m = html.match(/title="\u266c\s*([^"]+)"/);
  if (!m) return null;
  const raw = m[1].trim();
  const dashIdx = raw.lastIndexOf(" - ");
  if (dashIdx === -1) return raw;
  return `${raw.slice(0, dashIdx)} — ${raw.slice(dashIdx + 3)}`;
}

async function fetchOembed(url) {
  const resp = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.code || !data.title) return null;
  return data;
}

function buildMinimalRawJson(itemId, entryMap, oembed) {
  // Build a minimal raw.json from oEmbed + frontmatter
  const desc = oembed?.title || getFmValue(entryMap, "title") || "";
  const author = getFmValue(entryMap, "author")?.replace(/\[\[People\/@?/, "").replace(/\]\]/, "") || "";

  const soundEntry = entryMap.get("sound");
  let musicTitle = "", musicAuthor = "";
  if (soundEntry) {
    const sv = soundEntry.fullBlock.replace(/^sound:\s*"?/, "").replace(/"?\s*$/, "");
    const dashIdx = sv.lastIndexOf(" — ");
    if (dashIdx !== -1) {
      musicTitle = sv.slice(0, dashIdx);
      musicAuthor = sv.slice(dashIdx + 3);
    } else {
      musicTitle = sv;
    }
  }

  const raw = {
    _source: "oembed-backfill",
    id: itemId,
    desc,
    author: { uniqueId: author, nickname: oembed?.author_name || author },
    music: { title: musicTitle, authorName: musicAuthor },
    stats: {
      playCount: parseInt(getFmValue(entryMap, "stats_plays")) || 0,
      diggCount: parseInt(getFmValue(entryMap, "stats_likes")) || 0,
      commentCount: parseInt(getFmValue(entryMap, "stats_comments")) || 0,
      shareCount: parseInt(getFmValue(entryMap, "stats_shares")) || 0,
    },
  };
  if (oembed) {
    raw._oembed = { title: oembed.title, author_name: oembed.author_name, thumbnail_url: oembed.thumbnail_url };
  }
  return raw;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Collect targets: all items missing raw.json ──

const targets = [];
const mdFiles = fs.readdirSync(TIKTOK_DIR).filter(f => f.endsWith(".md"));

for (const mdFile of mdFiles) {
  const mdPath = path.join(TIKTOK_DIR, mdFile);
  const content = fs.readFileSync(mdPath, "utf-8");
  const split = splitNote(content);
  if (!split) continue;

  const idMatch = split.fmBlock.match(/roost_id:\s*"?tiktok:(\d+)"?/);
  if (!idMatch) continue;
  const itemId = idMatch[1];
  const attachFolder = path.join(TIKTOK_DIR, `tiktok-${itemId}`);

  if (fs.existsSync(path.join(attachFolder, "raw.json"))) continue;

  const entries = parseFrontmatterEntries(split.fmBlock);
  const entryMap = new Map(entries.filter(e => e.key).map(e => [e.key, e]));

  const authorEntry = entryMap.get("author");
  const handleMatch = authorEntry?.fullBlock.match(/@([^\]"]+)/);
  const handle = handleMatch?.[1];

  const url = handle ? `https://www.tiktok.com/@${handle}/video/${itemId}` : null;
  targets.push({ mdFile, mdPath, content, split, entries, entryMap, url, itemId, attachFolder, needsSound: !entryMap.has("sound") });
}

console.log(`Found ${targets.length} notes missing raw.json`);
console.log(`  ${targets.filter(t => t.needsSound).length} also missing sound`);

// ── Fetch oEmbed and update ──

const BATCH = 5;
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  const results = await Promise.all(batch.map(async t => {
    if (!t.url) return { target: t, oembed: null };
    try {
      return { target: t, oembed: await fetchOembed(t.url) };
    } catch {
      return { target: t, oembed: null };
    }
  }));

  for (const { target: t, oembed } of results) {
    if (oembed) oembedOk++;
    else oembedFail++;

    let fmChanged = false;
    const fileChanges = [];

    // Update title if oEmbed has a longer one
    if (oembed?.title) {
      const titleEntry = t.entryMap.get("title");
      if (titleEntry) {
        const currentMatch = titleEntry.fullBlock.match(/^title:\s*"?(.*?)"?\s*$/);
        const currentTitle = currentMatch ? currentMatch[1] : "";
        if (oembed.title.length > currentTitle.length + 5) {
          titleEntry.fullBlock = `title: ${yamlStr(oembed.title)}`;
          fmChanged = true;
          fileChanges.push("title");
          changes.title++;
        }
      }
    }

    // Add sound from oEmbed HTML if missing
    if (t.needsSound && oembed?.html) {
      const sound = extractSoundFromHtml(oembed.html);
      if (sound) {
        const afterKey = t.entryMap.has("collection") ? "collection" : "author";
        const afterIdx = t.entries.findIndex(e => e.key === afterKey);
        const insertIdx = afterIdx !== -1 ? afterIdx + 1 : t.entries.length;
        t.entries.splice(insertIdx, 0, { key: "sound", fullBlock: `sound: ${yamlStr(sound)}` });
        // Refresh entryMap after insertion
        t.entryMap.set("sound", t.entries[insertIdx]);
        fmChanged = true;
        fileChanges.push("sound");
        changes.sound++;
      }
    }

    // Write frontmatter if changed
    if (fmChanged) {
      const newFm = t.entries.map(e => e.fullBlock).join("\n");
      const newContent = `---\n${newFm}\n---\n${t.split.body}`;
      if (!DRY_RUN) fs.writeFileSync(t.mdPath, newContent, "utf-8");
    }

    // Generate minimal raw.json
    const rawData = buildMinimalRawJson(t.itemId, t.entryMap, oembed);
    if (!DRY_RUN) {
      if (!fs.existsSync(t.attachFolder)) fs.mkdirSync(t.attachFolder, { recursive: true });
      fs.writeFileSync(path.join(t.attachFolder, "raw.json"), JSON.stringify(rawData, null, 2));
    }
    fileChanges.push("raw.json");
    changes.rawJson++;

    if (fileChanges.length > 0) {
      if (DRY_RUN) console.log(`[DRY] ${t.mdFile}: ${fileChanges.join(", ")}${oembed ? "" : " (no oembed)"}`);
      updated++;
    } else {
      skipped++;
    }
  }

  if (i + BATCH < targets.length) await sleep(200);
  if ((i + BATCH) % 50 === 0) console.log(`  ...${i + BATCH}/${targets.length}`);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s${DRY_RUN ? " (dry run)" : ""}`);
console.log(`Updated: ${updated}, Skipped: ${skipped}`);
console.log(`oEmbed: ${oembedOk} ok, ${oembedFail} failed`);
console.log(`Changes: title=${changes.title}, sound=${changes.sound}, raw.json=${changes.rawJson}`);
