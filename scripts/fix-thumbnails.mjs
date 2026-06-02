#!/usr/bin/env node
/**
 * Fix thumbnails — copy Eagle's _thumbnail.png files and update cover frontmatter.
 * Run: node scripts/fix-thumbnails.mjs
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const EAGLE_LIB = process.argv[2] || path.join(os.homedir(), "Bookmarks.library");
const VAULT_PATH = process.argv[3] || path.join(os.homedir(), "ObsidianBookmarks");
const SYNC_FOLDER = "Bookmarks";

const imagesDir = path.join(EAGLE_LIB, "images");
const bookmarksDir = path.join(VAULT_PATH, SYNC_FOLDER);

let fixed = 0, skipped = 0, errors = 0;
const t0 = Date.now();

// Find all notes that have media.mp4 as cover
function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walkDir(path.join(dir, entry.name));
    } else if (entry.name.endsWith(".md")) {
      try {
        processNote(path.join(dir, entry.name));
      } catch (e) {
        errors++;
      }
    }
  }
}

function processNote(notePath) {
  const content = fs.readFileSync(notePath, "utf8");

  // Check if cover points to a video file
  const coverMatch = content.match(/^cover:\s*"?\[\[([^\]]+)\]\]"?/m);
  if (!coverMatch) { skipped++; return; }

  const coverPath = coverMatch[1];
  if (!coverPath.endsWith(".mp4") && !coverPath.endsWith(".mov") && !coverPath.endsWith(".webm")) {
    skipped++; return; // Already an image
  }

  // Extract the Eagle item ID from the attachment folder name
  // Pattern: .../tiktok-MN2C5R9D1JVG1/media.mp4 or .../twitter-MN2C.../media.mp4
  const idMatch = coverPath.match(/(?:tiktok|twitter|other)-([A-Z0-9]+)\//);
  if (!idMatch) { skipped++; return; }

  const eagleId = idMatch[1];
  const eagleDir = path.join(imagesDir, `${eagleId}.info`);

  if (!fs.existsSync(eagleDir)) { skipped++; return; }

  // Find thumbnail in Eagle folder
  const eagleFiles = fs.readdirSync(eagleDir);
  const thumbFile = eagleFiles.find(f => f.includes("_thumbnail"));

  if (!thumbFile) { skipped++; return; }

  // Determine vault destination
  const attachFolder = coverPath.replace(/\/[^/]+$/, ""); // strip filename
  const vaultAttachDir = path.join(VAULT_PATH, attachFolder);
  const thumbDest = path.join(vaultAttachDir, "thumb.png");

  // Copy thumbnail
  if (!fs.existsSync(thumbDest)) {
    fs.mkdirSync(vaultAttachDir, { recursive: true });
    fs.copyFileSync(path.join(eagleDir, thumbFile), thumbDest);
  }

  // Update frontmatter — replace cover path
  const newCoverPath = `${attachFolder}/thumb.png`;
  const newContent = content.replace(
    /^cover:\s*"?\[\[[^\]]+\]\]"?/m,
    `cover: "[[${newCoverPath}]]"`
  );

  if (newContent !== content) {
    fs.writeFileSync(notePath, newContent);
    fixed++;
    if (fixed % 500 === 0) {
      console.log(`  ${fixed} fixed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  } else {
    skipped++;
  }
}

console.log("Fixing thumbnails...\n");
walkDir(bookmarksDir);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s:`);
console.log(`  ${fixed} fixed (thumbnail copied + cover updated)`);
console.log(`  ${skipped} skipped (already image or no thumbnail)`);
console.log(`  ${errors} errors`);
