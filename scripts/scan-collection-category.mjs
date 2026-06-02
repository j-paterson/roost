#!/usr/bin/env node
/**
 * Scan all bookmark notes for mismatches between the source `collection`
 * (TikTok favorites folder, Eagle collection) and the current `roost_category`.
 *
 * Usage:
 *   node scripts/scan-collection-category.mjs          # summary
 *   node scripts/scan-collection-category.mjs --list   # list mismatches
 *   node scripts/scan-collection-category.mjs --vault=/path/to/vault
 */
import fs from "fs";
import path from "path";
import os from "os";

const args = process.argv.slice(2);
const listAll = args.includes("--list");
const vaultArg = args.find(a => a.startsWith("--vault="));
const vaultRoot = vaultArg ? vaultArg.split("=")[1] : path.join(os.homedir(), "ObsidianBookmarks");
const bookmarksDir = path.join(vaultRoot, "Bookmarks");

if (!fs.existsSync(bookmarksDir)) {
  console.error(`Bookmarks folder not found: ${bookmarksDir}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Parse a simple YAML frontmatter block — handles quoted strings and bare scalars.
// Not a full YAML parser; enough for the fields we care about.
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val === "" || val === "~" || val === "null") continue;
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[m[1]] = val;
  }
  return fm;
}

const files = walk(bookmarksDir);
console.log(`Scanning ${files.length} markdown files in ${bookmarksDir}…\n`);

let hasCollection = 0;
let hasCategory = 0;
let bothPresent = 0;
let match = 0;
let mismatch = 0;
let missingCategory = 0;
const mismatches = []; // { path, collection, category }
const missing = [];    // { path, collection }

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm) continue;
  const collection = fm.collection;
  const category = fm.roost_category;
  if (collection) hasCollection++;
  if (category) hasCategory++;
  if (!collection) continue;
  if (!category) {
    missingCategory++;
    missing.push({ path: path.relative(vaultRoot, file), collection });
    continue;
  }
  bothPresent++;
  if (collection.trim().toLowerCase() === category.trim().toLowerCase()) {
    match++;
  } else {
    mismatch++;
    mismatches.push({ path: path.relative(vaultRoot, file), collection, category });
  }
}

console.log(`Has collection:            ${hasCollection}`);
console.log(`Has roost_category:        ${hasCategory}`);
console.log(`Both present:              ${bothPresent}`);
console.log(`  ✓ match:                 ${match}`);
console.log(`  ✗ mismatch:              ${mismatch}`);
console.log(`  ? collection w/o cat:    ${missingCategory}`);
console.log();

// Top mismatching source collections
if (mismatch > 0) {
  const byCollection = new Map();
  for (const m of mismatches) {
    const key = m.collection;
    if (!byCollection.has(key)) byCollection.set(key, new Map());
    const cats = byCollection.get(key);
    cats.set(m.category, (cats.get(m.category) ?? 0) + 1);
  }
  const rows = [...byCollection.entries()]
    .map(([coll, cats]) => ({
      collection: coll,
      count: [...cats.values()].reduce((s, v) => s + v, 0),
      cats,
    }))
    .sort((a, b) => b.count - a.count);
  console.log("Mismatches by source collection (top 20):");
  for (const r of rows.slice(0, 20)) {
    const breakdown = [...r.cats.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}×${n}`)
      .join(", ");
    console.log(`  ${r.collection.padEnd(30)} ${String(r.count).padStart(4)}  →  ${breakdown}`);
  }
  console.log();
}

if (listAll) {
  if (mismatches.length > 0) {
    console.log("─── Mismatches ───");
    for (const m of mismatches) {
      console.log(`  ${m.collection} → ${m.category}   ${m.path}`);
    }
    console.log();
  }
  if (missing.length > 0) {
    console.log("─── Collection without roost_category ───");
    for (const m of missing) {
      console.log(`  ${m.collection.padEnd(30)} ${m.path}`);
    }
  }
}
