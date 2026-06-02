#!/usr/bin/env node
/**
 * Reset Smart Assign categories:
 * Removes the roost_category frontmatter field from all synced notes.
 *
 * Dry-run by default — pass --run to execute.
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const VAULT = process.env.ROOST_DEV_VAULT || process.env.VAULT;
if (!VAULT) {
  console.error("Set ROOST_DEV_VAULT or VAULT to your vault path");
  process.exit(1);
}
const SYNC_FOLDER = join(VAULT, "Bookmarks");
const DRY_RUN = !process.argv.includes("--run");
const FIELD = "roost_category";

function findMarkdownFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMarkdownFiles(full));
      } else if (entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable */ }
  return results;
}

console.log(DRY_RUN ? "=== DRY RUN (pass --run to execute) ===" : "=== EXECUTING ===");
console.log();

const files = findMarkdownFiles(SYNC_FOLDER);
let stripped = 0;

for (const file of files) {
  const content = readFileSync(file, "utf-8");

  // Remove roost_category line from frontmatter
  const regex = new RegExp(`^${FIELD}:.*\\n`, "m");
  if (!regex.test(content)) continue;

  const category = content.match(new RegExp(`^${FIELD}:\\s*"?([^\\n"]+)`, "m"))?.[1] || "?";

  if (DRY_RUN) {
    console.log(`WOULD STRIP: ${file.replace(SYNC_FOLDER + "/", "")} — ${category}`);
  } else {
    writeFileSync(file, content.replace(regex, ""));
    console.log(`STRIPPED: ${file.replace(SYNC_FOLDER + "/", "")} — ${category}`);
  }
  stripped++;
}

console.log();
console.log(`${stripped} notes ${DRY_RUN ? "would be" : ""} updated.`);
if (DRY_RUN) console.log("Re-run with --run to apply changes.");
