#!/usr/bin/env node
/**
 * Normalize attachment folder names: Eagle-format IDs → numeric platform IDs.
 *
 * Eagle imports created folders like `tiktok-MN2DB13RYDKNR/` but roost_id uses
 * the numeric TikTok/Twitter ID. This renames all folders to match roost_id,
 * merging any orphaned numeric-ID folders from broken resync.
 *
 * Run: node scripts/normalize-folders.mjs [vault-path] [--dry-run]
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const VAULT_PATH = process.argv[2] || path.join(os.homedir(), "ObsidianBookmarks");
const SYNC_FOLDER = "Bookmarks";
const DRY_RUN = process.argv.includes("--dry-run");

const bookmarksDir = path.join(VAULT_PATH, SYNC_FOLDER);

let renamed = 0, merged = 0, orphansDeleted = 0, skipped = 0, errors = 0;
const t0 = Date.now();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectNotes(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectNotes(full, results);
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function findAttachFolder(content, platform) {
  // Cover field: cover: "[[Bookmarks/TikTok/tiktok-ABC123/thumb.png]]"
  const coverMatch = content.match(/cover:\s*"?\[\[([^\]]+)\]\]/);
  if (coverMatch) {
    const folderPath = coverMatch[1].replace(/\/[^/]+$/, "");
    if (folderPath.includes(`${platform}-`)) return folderPath;
  }
  // Embed: ![[Bookmarks/TikTok/tiktok-ABC123/media.mp4]]
  const embedRegex = new RegExp(`!\\[\\[([^\\]]*${escapeRegex(platform)}-[^/\\]]+)/[^\\]]+\\]\\]`);
  const embedMatch = content.match(embedRegex);
  if (embedMatch) return embedMatch[1];
  return null;
}

function processNote(notePath) {
  const content = fs.readFileSync(notePath, "utf8");

  // Parse roost_id
  const idMatch = content.match(/roost_id:\s*"?([^"\n]+)/);
  if (!idMatch) { skipped++; return; }
  const roostId = idMatch[1].trim();

  const platform = roostId.startsWith("tiktok:") ? "tiktok"
    : roostId.startsWith("twitter:") ? "twitter" : null;
  if (!platform) { skipped++; return; }

  const numericId = roostId.split(":")[1];

  // Vault-relative paths (as stored in note content)
  const actualFolderVault = findAttachFolder(content, platform);
  if (!actualFolderVault) { skipped++; return; }

  // Note's parent directory (vault-relative)
  const noteRelPath = path.relative(VAULT_PATH, notePath);
  const noteDirVault = path.dirname(noteRelPath);
  const canonicalFolderVault = `${noteDirVault}/${platform}-${numericId}`;

  if (actualFolderVault === canonicalFolderVault) { skipped++; return; }

  // Filesystem paths
  const actualFolderFS = path.join(VAULT_PATH, actualFolderVault);
  const canonicalFolderFS = path.join(VAULT_PATH, canonicalFolderVault);

  if (!fs.existsSync(actualFolderFS) || !fs.statSync(actualFolderFS).isDirectory()) {
    skipped++;
    return;
  }

  if (DRY_RUN) {
    const hasOrphan = fs.existsSync(canonicalFolderFS);
    console.log(`RENAME: ${actualFolderVault} → ${canonicalFolderVault}${hasOrphan ? " (merge orphan)" : ""}`);
    renamed++;
    return;
  }

  try {
    // Step 1: Merge orphan if it exists at the target path
    if (fs.existsSync(canonicalFolderFS) && fs.statSync(canonicalFolderFS).isDirectory()) {
      for (const file of fs.readdirSync(canonicalFolderFS)) {
        const src = path.join(canonicalFolderFS, file);
        const dest = path.join(actualFolderFS, file);
        if (!fs.existsSync(dest) && fs.statSync(src).isFile()) {
          fs.copyFileSync(src, dest);
          merged++;
        }
      }
      // Delete orphan folder
      fs.rmSync(canonicalFolderFS, { recursive: true });
      orphansDeleted++;
    }

    // Step 2: Rename Eagle folder → canonical
    fs.renameSync(actualFolderFS, canonicalFolderFS);

    // Step 3: Update note references
    const oldBasename = path.basename(actualFolderVault);
    const newBasename = path.basename(canonicalFolderVault);
    const updatedContent = content.split(oldBasename).join(newBasename);
    if (updatedContent !== content) {
      fs.writeFileSync(notePath, updatedContent);
    }

    renamed++;
  } catch (e) {
    errors++;
    if (errors <= 20) console.error(`ERROR: ${notePath}: ${e.message}`);
  }
}

// Run — collect all note paths first, then process (avoids ENOENT from mid-walk renames)
console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Normalizing folders in ${bookmarksDir}...`);
const notes = collectNotes(bookmarksDir);
console.log(`Found ${notes.length} notes`);
for (const note of notes) processNote(note);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s: ${renamed} renamed, ${merged} files merged, ${orphansDeleted} orphans deleted, ${skipped} skipped, ${errors} errors`);
