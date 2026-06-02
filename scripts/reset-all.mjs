#!/usr/bin/env node
/**
 * Full reset — clears all Smart Assign artifacts:
 * 1. roost_category field from all note frontmatter
 * 2. category/* tags from all note frontmatter (legacy)
 * 3. Sync state from plugin settings
 *
 * Does NOT clear: embedding cache (expensive to regenerate), synced notes, media
 *
 * Dry-run by default — pass --run to execute.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const VAULT = process.env.ROOST_DEV_VAULT || process.env.VAULT;
if (!VAULT) {
  console.error("Set ROOST_DEV_VAULT or VAULT to your vault path");
  process.exit(1);
}
const SYNC_FOLDER = join(VAULT, "Bookmarks");
const PLUGIN_DATA = join(VAULT, ".obsidian", "plugins", "roost-sync-test", "data.json");
const DRY_RUN = !process.argv.includes("--run");

function findMarkdownFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findMarkdownFiles(full));
      else if (entry.name.endsWith(".md")) results.push(full);
    }
  } catch {}
  return results;
}

console.log(DRY_RUN ? "=== DRY RUN (pass --run to execute) ===" : "=== EXECUTING ===");
console.log();

// 1. Clean frontmatter
const files = findMarkdownFiles(SYNC_FOLDER);
let cleanedCategory = 0;
let cleanedTags = 0;

for (const file of files) {
  let content = readFileSync(file, "utf-8");
  let changed = false;
  const short = file.replace(SYNC_FOLDER + "/", "");

  // Remove roost_category line
  const catMatch = content.match(/^roost_category:.*\n/m);
  if (catMatch) {
    if (DRY_RUN) console.log(`  STRIP roost_category: ${short}`);
    else content = content.replace(/^roost_category:.*\n/m, "");
    cleanedCategory++;
    changed = true;
  }

  // Remove category/* tags
  const tagMatches = content.match(/^\s+- category\/.*\n/gm);
  if (tagMatches) {
    if (DRY_RUN) console.log(`  STRIP ${tagMatches.length} category tags: ${short}`);
    else content = content.replace(/^\s+- category\/.*\n/gm, "");
    cleanedTags += tagMatches.length;
    changed = true;
  }

  if (changed && !DRY_RUN) writeFileSync(file, content);
}

console.log(`\nFrontmatter: ${cleanedCategory} roost_category fields, ${cleanedTags} category/* tags`);

// 2. Clear sync state from plugin settings
if (existsSync(PLUGIN_DATA)) {
  try {
    const data = JSON.parse(readFileSync(PLUGIN_DATA, "utf-8"));
    if (data.syncState) {
      console.log(`\nSync state: ${Object.keys(data.syncState).join(", ")}`);
      if (!DRY_RUN) {
        data.syncState = {};
        writeFileSync(PLUGIN_DATA, JSON.stringify(data, null, 2));
        console.log("  Cleared sync state");
      } else {
        console.log("  Would clear sync state");
      }
    }
  } catch (e) {
    console.log(`Plugin data: error reading — ${e.message}`);
  }
}

console.log();
console.log(`Total: ${cleanedCategory + cleanedTags} changes across ${files.length} files`);
if (DRY_RUN) console.log("Re-run with --run to apply.");
else console.log("Done. Reload the plugin in Obsidian.");
