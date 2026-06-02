#!/usr/bin/env node
/**
 * Generate subcategory eval scenarios from a real vault.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.eval.json scripts/build-subcat-scenarios.mjs \
 *     [--vault=$HOME/ObsidianBookmarks] [--out=tests/eval/subcat-method-scenarios.json] \
 *     [--min-subcats=2] [--min-items-per-subcat=10] [--max-negatives-per-parent=1000]
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const VAULT = args.vault ?? path.join(os.homedir(), "ObsidianBookmarks");
const OUT = args.out ?? "tests/eval/subcat-method-scenarios.json";
const SYNC_FOLDER = args["sync-folder"] ?? "Bookmarks";
const opts = {
  minSubcats: parseInt(args["min-subcats"] ?? "2", 10),
  minItemsPerSubcat: parseInt(args["min-items-per-subcat"] ?? "10", 10),
  maxNegativesPerParent: parseInt(args["max-negatives-per-parent"] ?? "1000", 10),
};

const { buildScenarios } = await import(
  path.join(__dirname, "..", "src", "eval", "subcat-scenarios.ts")
);

// Load embedding cache via the mock-Obsidian shim. Items without an embedding
// still appear in scenarios (positives/negatives) but won't contribute to
// parentCentroid.
const { FileSystemAdapter } = await import(
  path.join(__dirname, "..", "src", "__mocks__", "obsidian.ts")
);
const { loadEmbeddingCache } = await import(
  path.join(__dirname, "..", "src", "pipeline", "shared.ts")
);
const adapter = new FileSystemAdapter();
adapter.basePath = VAULT;
const fakeVault = { adapter };
const embeddingCache = loadEmbeddingCache(fakeVault);
console.error(`Loaded embedding cache (${Object.keys(embeddingCache).length} items)`);

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return m[1];
}

function fmField(fm, key) {
  // Matches `key: value` and `key: "value"` on its own line.
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m");
  const m = fm.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v === "null" || v === "undefined") return null;
  return v;
}

function scanVault(vaultRoot) {
  const items = [];
  const folder = path.join(vaultRoot, SYNC_FOLDER);
  if (!fs.existsSync(folder)) {
    console.error(`Sync folder not found: ${folder}`);
    return items;
  }
  const stack = [folder];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const content = fs.readFileSync(full, "utf8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      const itemId = fmField(fm, "roost_id");
      if (!itemId) continue;
      const vec = embeddingCache[itemId]?.vec;
      items.push({
        itemId,
        category: fmField(fm, "roost_category"),
        subcategory: fmField(fm, "roost_subcategory"),
        vec,
      });
    }
  }
  return items;
}

const items = scanVault(VAULT);
console.error(`Scanned ${items.length} items from ${VAULT}/${SYNC_FOLDER}`);
const output = buildScenarios(items, opts);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
console.error(
  `Wrote ${OUT} — ${output.stats.parentsIncluded} parents, ` +
  `${output.stats.totalPositives} positives, ${output.stats.totalNegatives} negatives.`
);
