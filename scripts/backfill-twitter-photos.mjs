#!/usr/bin/env node
/**
 * Backfill multi-image Twitter posts.
 *
 * Walks every twitter-* attachment folder in the vault. For folders that have
 * raw.json, reads extended_entities.media to find all photos. Downloads any
 * missing numbered files (1.jpg, 2.jpg, …). Updates the note's cover
 * frontmatter from media.jpg → 1.jpg when applicable.
 *
 * Run:  node scripts/backfill-twitter-photos.mjs [--dry-run]
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const VAULT = process.argv[2]?.startsWith("/")
  ? process.argv[2]
  : path.join(os.homedir(), "ObsidianBookmarks");
const SYNC_FOLDER = "Bookmarks";
const X_DIR = path.join(VAULT, SYNC_FOLDER, "X");
const DRY_RUN = process.argv.includes("--dry-run");
const CONCURRENCY = 8;
const REFERER = "https://x.com/";

let downloaded = 0;
let coversFixed = 0;
let foldersProcessed = 0;
let foldersWithNewPhotos = 0;
let errors = 0;

// ─── helpers ───────────────────────────────────────────────────────

function roostUnwrapTweet(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.tweet) return roostUnwrapTweet(obj.tweet);
  if (obj.result?.legacy) return obj.result;
  if (obj.tweetResult?.result?.legacy) return obj.tweetResult.result;
  return obj;
}

function extractPhotos(raw) {
  const tweet = roostUnwrapTweet(raw) || raw;
  const media =
    tweet?.legacy?.extended_entities?.media ||
    tweet?.legacy?.entities?.media ||
    [];
  const photos = [];
  for (let i = 0; i < media.length; i++) {
    if (media[i].type === "photo" && media[i].media_url_https) {
      photos.push({
        url: `${media[i].media_url_https}?format=jpg&name=large`,
        index: i, // 0-based → saved as (index+1).jpg
      });
    }
  }
  return photos;
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { Referer: REFERER } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Limit concurrency
async function mapLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

// ─── main ──────────────────────────────────────────────────────────

async function processFolder(folderPath) {
  const rawPath = path.join(folderPath, "raw.json");
  if (!fs.existsSync(rawPath)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  } catch {
    return;
  }

  const photos = extractPhotos(raw);
  if (photos.length === 0) return;

  foldersProcessed++;

  // Determine which numbered files are missing
  const missing = [];
  for (const photo of photos) {
    const filename = `${photo.index + 1}.jpg`;
    const filePath = path.join(folderPath, filename);
    if (!fs.existsSync(filePath)) {
      missing.push({ ...photo, filename, filePath });
    }
  }

  if (missing.length === 0) return;

  const folderId = path.basename(folderPath);
  if (DRY_RUN) {
    console.log(`[dry-run] ${folderId}: would download ${missing.length} photo(s): ${missing.map((m) => m.filename).join(", ")}`);
    foldersWithNewPhotos++;
    downloaded += missing.length;
    return;
  }

  // Download missing photos
  let folderDownloaded = 0;
  for (const m of missing) {
    try {
      const data = await downloadImage(m.url);
      fs.writeFileSync(m.filePath, data);
      folderDownloaded++;
      downloaded++;
    } catch (e) {
      console.error(`  ✗ ${folderId}/${m.filename}: ${e.message}`);
      errors++;
    }
  }

  if (folderDownloaded > 0) {
    foldersWithNewPhotos++;
    console.log(`  ✓ ${folderId}: downloaded ${folderDownloaded} photo(s)`);
  }
}

async function fixCovers() {
  // Walk all .md files in X/ and update cover from media.jpg → 1.jpg
  // if 1.jpg exists on disk
  const mdFiles = fs.readdirSync(X_DIR).filter((f) => f.endsWith(".md"));

  for (const mdFile of mdFiles) {
    const notePath = path.join(X_DIR, mdFile);
    let content;
    try {
      content = fs.readFileSync(notePath, "utf8");
    } catch {
      continue;
    }

    // Match cover pointing to media.jpg or thumb.png
    const coverMatch = content.match(
      /^(cover:\s*"?\[\[)(Bookmarks\/X\/twitter-[^/]+)\/(media\.jpg|thumb\.png)(\]\]"?)/m
    );
    if (!coverMatch) continue;

    const attachFolder = path.join(VAULT, coverMatch[2]);
    const oneJpg = path.join(attachFolder, "1.jpg");
    if (!fs.existsSync(oneJpg)) continue;

    const oldCover = coverMatch[0];
    const newCover = `${coverMatch[1]}${coverMatch[2]}/1.jpg${coverMatch[4]}`;

    if (DRY_RUN) {
      console.log(`[dry-run] ${mdFile}: cover ${coverMatch[3]} → 1.jpg`);
      coversFixed++;
      continue;
    }

    const updated = content.replace(oldCover, newCover);
    fs.writeFileSync(notePath, updated);
    coversFixed++;
  }
}

async function main() {
  console.log(`Vault: ${VAULT}`);
  console.log(`Scanning: ${X_DIR}`);
  if (DRY_RUN) console.log("── DRY RUN ──\n");

  if (!fs.existsSync(X_DIR)) {
    console.error(`X directory not found: ${X_DIR}`);
    process.exit(1);
  }

  // Collect all twitter-* folders
  const folders = fs
    .readdirSync(X_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("twitter-"))
    .map((d) => path.join(X_DIR, d.name));

  console.log(`Found ${folders.length} twitter attachment folders\n`);

  // Process in batches to limit concurrency
  await mapLimit(folders, CONCURRENCY, async (folder) => {
    try {
      await processFolder(folder);
    } catch (e) {
      errors++;
      console.error(`  ✗ ${path.basename(folder)}: ${e.message}`);
    }
  });

  console.log(`\n── Photo download complete ──`);
  console.log(`  Folders with raw.json + photos: ${foldersProcessed}`);
  console.log(`  Folders with new downloads: ${foldersWithNewPhotos}`);
  console.log(`  Photos downloaded: ${downloaded}`);
  console.log(`  Errors: ${errors}`);

  // Fix cover frontmatter
  console.log(`\nUpdating cover frontmatter...`);
  await fixCovers();
  console.log(`  Covers updated: ${coversFixed}`);

  console.log(`\nDone.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
