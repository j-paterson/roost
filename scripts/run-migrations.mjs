#!/usr/bin/env node
/**
 * Standalone migration script — runs the three pipeline migrations
 * directly on the vault filesystem without needing Obsidian running.
 *
 * Usage: node scripts/run-migrations.mjs [--vault-root <path>]
 *
 * Defaults to the vault path from package.json dev script.
 */
import * as fs from "fs";
import * as path from "path";

const VAULT = process.env.ROOST_DEV_VAULT || process.env.VAULT;
if (!VAULT && !process.argv.includes("--vault-root")) {
  console.error("Set ROOST_DEV_VAULT or VAULT to your vault path, or pass --vault-root <path>");
  process.exit(1);
}
const vaultRoot = process.argv.includes("--vault-root")
  ? process.argv[process.argv.indexOf("--vault-root") + 1]
  : VAULT;

if (!fs.existsSync(vaultRoot)) {
  console.error(`Vault not found: ${vaultRoot}`);
  process.exit(1);
}

// ── Frontmatter helpers ──

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return { fm: {}, body: content, raw: "" };
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return { fm: {}, body: content, raw: "" };
  const raw = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5);
  const fm = {};
  let currentKey = null;
  let currentArray = null;
  for (const line of raw.split("\n")) {
    const arrayItem = line.match(/^  - (.+)$/);
    if (arrayItem && currentKey) {
      if (!currentArray) currentArray = [];
      currentArray.push(arrayItem[1]);
      fm[currentKey] = currentArray;
      continue;
    }
    if (currentArray) { currentArray = null; currentKey = null; }
    const m = line.match(/^([\w][\w_]*):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      let val = m[2].replace(/^"|"$/g, "").trim();
      if (val === "" || val === "null") val = null;
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
      else if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
      fm[currentKey] = val;
    }
  }
  return { fm, body, raw };
}

function writeFrontmatter(fm, body) {
  const lines = [];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      const s = String(value);
      if (s.includes(":") || s.includes("#") || s.includes("'") || s.includes('"') || s.startsWith("{") || s.startsWith("[")) {
        lines.push(`${key}: "${s.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${s}`);
      }
    }
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function updateFrontmatterFields(content, updates) {
  const { fm, body } = parseFrontmatter(content);
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      if (key in fm) { delete fm[key]; changed = true; }
    } else if (JSON.stringify(fm[key]) !== JSON.stringify(value)) {
      fm[key] = value;
      changed = true;
    }
  }
  if (!changed) return null;
  return writeFrontmatter(fm, body);
}

// ── Vault scanning ──

function findAllMd(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findAllMd(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

function findBookmarkByRoostId(roostId) {
  const bookmarksDir = path.join(vaultRoot, "Bookmarks");
  if (!fs.existsSync(bookmarksDir)) return null;
  for (const mdPath of findAllMd(bookmarksDir)) {
    const content = fs.readFileSync(mdPath, "utf-8");
    const { fm } = parseFrontmatter(content);
    if (fm.roost_id === roostId) return mdPath;
  }
  return null;
}

// Cache the roost_id → path mapping for performance
let roostIdIndex = null;
function buildRoostIdIndex() {
  if (roostIdIndex) return roostIdIndex;
  console.log("  Building roost_id index...");
  roostIdIndex = new Map();
  const bookmarksDir = path.join(vaultRoot, "Bookmarks");
  if (!fs.existsSync(bookmarksDir)) return roostIdIndex;
  for (const mdPath of findAllMd(bookmarksDir)) {
    const content = fs.readFileSync(mdPath, "utf-8");
    const { fm } = parseFrontmatter(content);
    if (fm.roost_id) roostIdIndex.set(String(fm.roost_id), mdPath);
  }
  console.log(`  Index built: ${roostIdIndex.size} bookmarks`);
  return roostIdIndex;
}

function rmEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) rmEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

// ── Migration 1: Recipes ──

function migrateRecipes() {
  const folder = path.join(vaultRoot, "Pipelines/Recipes");
  if (!fs.existsSync(folder)) { console.log("Migration 1 (Recipes): no Pipelines/Recipes/ folder — skipping."); return; }

  const files = findAllMd(folder);
  console.log(`Migration 1 (Recipes): found ${files.length} notes`);
  const index = buildRoostIdIndex();

  let migrated = 0, alreadyMigrated = 0, unresolved = 0, errors = 0, indexes = 0;

  for (const filePath of files) {
    const basename = path.basename(filePath, ".md");
    if (basename === "Recipe Index" || basename.endsWith(" Index")) {
      fs.unlinkSync(filePath);
      indexes++;
      continue;
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { fm } = parseFrontmatter(content);
      if (fm.pipeline !== "recipe") continue;
      const sourceId = fm.source_id ? String(fm.source_id) : null;
      if (!sourceId) { unresolved++; continue; }
      const sourcePath = index.get(sourceId);
      if (!sourcePath) { unresolved++; continue; }

      const sourceContent = fs.readFileSync(sourcePath, "utf-8");
      const { fm: sourceFm } = parseFrontmatter(sourceContent);
      if (typeof sourceFm.enrichment_v_recipe === "number") {
        alreadyMigrated++;
        fs.unlinkSync(filePath);
        continue;
      }

      const updates = {
        recipe_dish: fm.dish || "Unknown",
        recipe_cuisine: fm.cuisine || "Unknown",
        recipe_prep_time: fm.prep_time || null,
        recipe_cook_time: fm.cook_time || null,
        recipe_difficulty: fm.difficulty || "medium",
        recipe_link: null,
        recipe_ingredients: Array.isArray(fm.ingredients) ? fm.ingredients : [],
        recipe_steps: Array.isArray(fm.steps) ? fm.steps : [],
        enrichment_v_recipe: 1,
      };
      if (!sourceFm.roost_subcategory) {
        if (!sourceFm.roost_category) {
          updates.roost_category = "Recipes";
          updates.roost_subcategory = fm.cuisine || "Other";
        } else if (["recipes", "food", "food & drink", "cooking"].includes(String(sourceFm.roost_category).toLowerCase())) {
          updates.roost_subcategory = fm.cuisine || "Other";
        }
      }

      const updated = updateFrontmatterFields(sourceContent, updates);
      if (updated) fs.writeFileSync(sourcePath, updated);
      fs.unlinkSync(filePath);
      migrated++;
    } catch (e) {
      errors++;
      console.error(`  Error: ${filePath}: ${e.message}`);
    }
  }

  rmEmptyDirs(folder);
  console.log(`  Recipe migration: ${migrated} migrated, ${alreadyMigrated} already done, ${unresolved} unresolved, ${errors} errors, ${indexes} index notes deleted`);
}

// ── Migration 2: Places ──

function migratePlaces() {
  const folder = path.join(vaultRoot, "Pipelines/Places");
  if (!fs.existsSync(folder)) { console.log("Migration 2 (Places): no Pipelines/Places/ folder — skipping."); return; }

  const files = findAllMd(folder);
  console.log(`Migration 2 (Places): found ${files.length} notes`);
  const index = buildRoostIdIndex();

  let migrated = 0, alreadyMigrated = 0, unresolved = 0, errors = 0, indexes = 0;

  for (const filePath of files) {
    const basename = path.basename(filePath, ".md");
    if (basename === "Places Index" || basename.endsWith(" Index")) {
      fs.unlinkSync(filePath);
      indexes++;
      continue;
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { fm } = parseFrontmatter(content);
      if (fm.pipeline !== "place" && fm.pipeline !== "places") continue;
      const sourceId = fm.source_id ? String(fm.source_id) : null;
      if (!sourceId) { unresolved++; continue; }
      const sourcePath = index.get(sourceId);
      if (!sourcePath) { unresolved++; continue; }

      const sourceContent = fs.readFileSync(sourcePath, "utf-8");
      const { fm: sourceFm } = parseFrontmatter(sourceContent);
      if (typeof sourceFm.enrichment_v_place === "number") {
        alreadyMigrated++;
        fs.unlinkSync(filePath);
        continue;
      }

      const parseLat = (v) => typeof v === "number" ? v : (typeof v === "string" ? parseFloat(v) || null : null);

      const updates = {
        place_name: fm.name || fm.place || "Unknown",
        place_city: fm.city || "",
        place_country: fm.country || "",
        place_type: fm.place_type || "",
        place_address: fm.address || null,
        place_best_for: fm.best_for || "",
        place_lat: parseLat(fm.lat),
        place_lng: parseLat(fm.lng),
        place_description: null,
        place_vibes: [],
        place_tips: [],
        enrichment_v_place: 1,
      };
      if (!sourceFm.roost_subcategory) {
        if (!sourceFm.roost_category) {
          updates.roost_category = "Places";
          updates.roost_subcategory = fm.place_type || "Other";
        } else if (["places", "travel"].includes(String(sourceFm.roost_category).toLowerCase())) {
          updates.roost_subcategory = fm.place_type || "Other";
        }
      }

      const updated = updateFrontmatterFields(sourceContent, updates);
      if (updated) fs.writeFileSync(sourcePath, updated);
      fs.unlinkSync(filePath);
      migrated++;
    } catch (e) {
      errors++;
      console.error(`  Error: ${filePath}: ${e.message}`);
    }
  }

  rmEmptyDirs(folder);
  console.log(`  Places migration: ${migrated} migrated, ${alreadyMigrated} already done, ${unresolved} unresolved, ${errors} errors, ${indexes} index notes deleted`);
}

// ── Migration 3: Namespace rename ──

function migrateNamespaces() {
  console.log("Migration 3 (Namespaces): scanning bookmarks...");
  const bookmarksDir = path.join(vaultRoot, "Bookmarks");
  if (!fs.existsSync(bookmarksDir)) { console.log("  No Bookmarks/ folder — skipping."); return; }

  const files = findAllMd(bookmarksDir);
  let renamed = 0, filesTouched = 0;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    const { fm } = parseFrontmatter(content);

    const renames = [
      ["pipeline_v_media", "enrichment_v_mediaExtraction"],
      ["enrichment_v_media", "enrichment_v_mediaFiles"],
    ];

    const updates = {};
    let hasRename = false;
    for (const [from, to] of renames) {
      if (from in fm) {
        updates[from] = null;
        if (!(to in fm)) updates[to] = fm[from];
        hasRename = true;
        renamed++;
      }
    }

    if (!hasRename) continue;
    const updated = updateFrontmatterFields(content, updates);
    if (updated) {
      fs.writeFileSync(filePath, updated);
      filesTouched++;
    }
  }

  console.log(`  Namespace migration: ${filesTouched} files touched, ${renamed} fields renamed`);
}

// ── Run all ──

console.log(`\nPipelines-as-Enrichments Migration\n${"=".repeat(36)}\nVault: ${vaultRoot}\n`);

migrateRecipes();
console.log();
migratePlaces();
console.log();
migrateNamespaces();

console.log("\nDone. Restart Obsidian to pick up the changes.\n");
