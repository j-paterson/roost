#!/usr/bin/env node
/**
 * Fast Eagle → Obsidian vault migration script.
 * Copies media + creates markdown notes with ecosystem-optimized frontmatter.
 * Run: node scripts/migrate-eagle.mjs [eagle-library-path] [vault-path] [sync-folder]
 *
 * Defaults:
 *   Eagle: ~/Bookmarks.library
 *   Vault: ~/ObsidianBookmarks
 *   Folder: Bookmarks
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const EAGLE_LIB = process.argv[2] || path.join(os.homedir(), "Bookmarks.library");
const VAULT_PATH = process.argv[3] || path.join(os.homedir(), "ObsidianBookmarks");
const SYNC_FOLDER = process.argv[4] || "Bookmarks";

const imagesDir = path.join(EAGLE_LIB, "images");
const outputDir = path.join(VAULT_PATH, SYNC_FOLDER);
const peopleDir = path.join(VAULT_PATH, "People");

if (!fs.existsSync(imagesDir)) {
  console.error(`Eagle images directory not found: ${imagesDir}`);
  process.exit(1);
}

// Scan existing roost_ids for dedup
const existingIds = new Set();
function scanExisting(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) scanExisting(path.join(dir, entry.name));
    else if (entry.name.endsWith(".md")) {
      try {
        const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
        const match = content.match(/^roost_id:\s*"?([^\n"]+)"?/m);
        if (match) existingIds.add(match[1]);
      } catch { /* skip */ }
    }
  }
}
console.log("Scanning existing notes for dedup...");
scanExisting(outputDir);
console.log(`Found ${existingIds.size} existing items\n`);

// Read Eagle library folders for context
const folderNames = new Map();
try {
  const libMeta = JSON.parse(fs.readFileSync(path.join(EAGLE_LIB, "metadata.json"), "utf8"));
  function walkFolders(folders, parentPath = "") {
    for (const f of folders) {
      const fp = parentPath ? `${parentPath}/${f.name}` : f.name;
      folderNames.set(f.id, fp);
      if (f.children?.length) walkFolders(f.children, fp);
    }
  }
  walkFolders(libMeta.folders || []);
} catch { /* skip */ }

// Process items
const itemDirs = fs.readdirSync(imagesDir).filter(d => d.endsWith(".info"));
console.log(`Processing ${itemDirs.length} Eagle items...\n`);

let imported = 0, skipped = 0, errors = 0;
const createdAuthors = new Set();
const createdFolders = new Set();

function ensureDir(p) {
  if (createdFolders.has(p)) return;
  fs.mkdirSync(p, { recursive: true });
  createdFolders.add(p);
}

function sanitize(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f#^[\]]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 200) || "untitled";
}

function buildRoostId(meta) {
  const url = meta.website || meta.url || "";
  if (url.includes("tiktok.com")) {
    const match = url.match(/video\/(\d+)/);
    return match ? `tiktok:${match[1]}` : null;
  }
  if (url.includes("x.com") || url.includes("twitter.com")) {
    const match = url.match(/status\/(\d+)/);
    return match ? `twitter:${match[1]}` : null;
  }
  return null;
}

function detectPlatform(meta) {
  const url = meta.website || meta.url || "";
  if (url.includes("tiktok.com") || meta.tags?.includes("tiktok")) return "tiktok";
  if (url.includes("x.com") || url.includes("twitter.com") || meta.tags?.includes("twitter")) return "twitter";
  return "other";
}

function extractAuthor(meta) {
  const tag = meta.tags?.find(t => t.startsWith("@"));
  if (tag) return tag;
  const match = meta.name?.match(/@(\w+)/);
  return match ? `@${match[1]}` : "Unknown";
}

const t0 = Date.now();

for (let i = 0; i < itemDirs.length; i++) {
  const itemDir = itemDirs[i];
  const itemId = itemDir.replace(".info", "");
  const itemPath = path.join(imagesDir, itemDir);

  try {
    const metaPath = path.join(itemPath, "metadata.json");
    if (!fs.existsSync(metaPath)) { skipped++; continue; }

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.isDeleted) { skipped++; continue; }

    const roostId = buildRoostId(meta);
    if (!roostId) { skipped++; continue; }
    if (existingIds.has(roostId)) { skipped++; continue; }

    const platform = detectPlatform(meta);
    const collection = meta.tags?.find(t => t.startsWith("collection:"))?.slice("collection:".length);
    const platformFolder = platform === "tiktok"
      ? (collection ? `TikTok/${sanitize(collection)}` : "TikTok")
      : platform === "twitter" ? "X" : "Other";
    const folderPath = path.join(outputDir, platformFolder);
    const attachFolder = path.join(folderPath, `${platform}-${itemId}`);

    ensureDir(folderPath);

    // Copy media file + thumbnail
    let coverPath;
    const files = fs.readdirSync(itemPath).filter(f => f !== "metadata.json" && !f.startsWith("."));

    // First pass: copy main media file
    for (const file of files) {
      if (file.includes("_thumbnail")) continue;
      const srcPath = path.join(itemPath, file);
      const stat = fs.statSync(srcPath);
      if (!stat.isFile()) continue;

      const safeName = `media.${meta.ext || path.extname(file).slice(1) || "bin"}`;
      ensureDir(attachFolder);
      const destPath = path.join(attachFolder, safeName);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
      break;
    }

    // Second pass: copy thumbnail (use as cover for cards view)
    const thumbFile = files.find(f => f.includes("_thumbnail"));
    if (thumbFile) {
      ensureDir(attachFolder);
      const thumbDest = path.join(attachFolder, "thumb.png");
      if (!fs.existsSync(thumbDest)) {
        fs.copyFileSync(path.join(itemPath, thumbFile), thumbDest);
      }
      coverPath = `${SYNC_FOLDER}/${platformFolder}/${platform}-${itemId}/thumb.png`;
    } else {
      // No thumbnail — use the media file itself (works for images, not videos)
      const mediaExt = meta.ext || "bin";
      if (/^(jpg|jpeg|png|gif|webp)$/i.test(mediaExt)) {
        coverPath = `${SYNC_FOLDER}/${platformFolder}/${platform}-${itemId}/media.${mediaExt}`;
      }
    }

    // Create author note
    const author = extractAuthor(meta);
    const authorNotePath = path.join(peopleDir, `${author}.md`);
    if (!createdAuthors.has(author)) {
      ensureDir(peopleDir);
      if (!fs.existsSync(authorNotePath)) {
        fs.writeFileSync(authorNotePath,
          `---\ntype: person\nplatform: ${platform}\nhandle: "${author}"\n---\n\n# ${author}\n`);
      }
      createdAuthors.add(author);
    }
    const authorLink = `[[People/${author}]]`;

    // Build frontmatter
    const rawTags = meta.tags?.filter(t => !t.startsWith("collection:") && t !== platform && !t.startsWith("@")) || [];
    const collectionTag = collection ? `collection/${sanitize(collection)}` : null;
    const fmTags = [platform, ...rawTags, ...(collectionTag ? [collectionTag] : [])];
    const titleText = (meta.annotation?.split("\n")[0] || meta.name || "").slice(0, 80);
    const publishedDate = meta.modificationTime ? new Date(meta.modificationTime * 1000).toISOString().split("T")[0] : undefined;
    const savedDate = meta.btime ? new Date(meta.btime).toISOString().split("T")[0] : undefined;

    const fmLines = [];
    fmLines.push(`roost_id: "${roostId}"`);
    if (titleText) fmLines.push(`title: "${titleText.replace(/"/g, '\\"')}"`);
    if (coverPath) fmLines.push(`cover: "[[${coverPath}]]"`);
    fmLines.push(`platform: ${platform}`);
    fmLines.push(`author: "${authorLink}"`);
    if (meta.website) fmLines.push(`url: "${meta.website}"`);
    if (collection) fmLines.push(`collection: ${collection}`);
    if (publishedDate) fmLines.push(`published: ${publishedDate}`);
    if (savedDate) fmLines.push(`saved: ${savedDate}`);
    if (fmTags.length > 0) {
      fmLines.push("tags:");
      for (const t of fmTags) fmLines.push(`  - ${t}`);
    }

    // Body
    const bodyParts = [];
    if (meta.annotation) bodyParts.push(meta.annotation.split("\n\n")[0]);
    if (coverPath) bodyParts.push("", `![[${coverPath}]]`);

    // Inline tags
    const inlineTags = rawTags
      .filter(t => t.length > 1 && t.length < 30)
      .map(t => t.startsWith("#") ? t : `#${t}`)
      .slice(0, 15);
    if (collectionTag) inlineTags.push(`#${collectionTag}`);
    if (inlineTags.length > 0) bodyParts.push("", inlineTags.join(" "));

    if (meta.website) bodyParts.push("", `— ${authorLink} · [Original](${meta.website})`);

    const content = `---\n${fmLines.join("\n")}\n---\n\n${bodyParts.join("\n")}\n`;
    const filename = sanitize(`${author} - ${itemId}`) + ".md";
    const filePath = path.join(folderPath, filename);

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
    }

    existingIds.add(roostId);
    imported++;

    if (imported % 500 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${imported} imported, ${skipped} skipped (${elapsed}s)`);
    }
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`Error ${itemId}: ${e.message}`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s:`);
console.log(`  ${imported} imported`);
console.log(`  ${skipped} skipped`);
console.log(`  ${errors} errors`);
console.log(`  ${createdAuthors.size} authors`);
