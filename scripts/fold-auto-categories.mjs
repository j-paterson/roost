// scripts/fold-auto-categories.mjs
// One-time: consolidate AUTO (no-collection) notes' roost_category fragments into the 19
// top-levels, with the old fragment kept as the subcategory (code -> Tech/code). Mirrors the
// collection resort but keys on roost_category instead of collection, so it catches the
// Smart-Assign-categorized notes the resort can't (no collection to resort by). Line-oriented.
import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Fragment roost_category -> consolidated top-level (existing taxonomy folds + the 11
// 2026-06-18 Smart-Assign orphans, placed per the governance ruleset).
const FRAGMENT = {
  "AI": "Tech", "web3": "Tech", "Code": "Tech", "code": "Tech", "Immersive (AR/VR)": "Tech",
  "Technology": "Tech", "DAOs": "Tech", "Trading": "Tech", "Crypto": "Tech",
  "Graphics": "Design",
  "Tattoo": "Art",
  "Stuff": "Products", "Product": "Products",
  "Places": "Places & Travel", "Austin": "Places & Travel", "Travel": "Places & Travel", "Event": "Places & Travel",
  "Edits": "Media", "Media List": "Media", "Music": "Media", "Watchlist": "Media",
  "Dance": "Fitness", "Sports": "Fitness", "Health": "Fitness", "Selfcare": "Fitness",
  "Macro": "Money", "Business": "Money", "Finances": "Money", "Finance": "Money",
  "Learning": "Growth", "Motivation": "Growth", "Kaizen": "Growth",
  "Psychology": "Growth", "Science": "Growth", "Philosophy": "Growth", "Advice": "Growth", "Inspiration": "Growth", "Tutorial": "Growth",
  "Rizz": "Relationships",
  "Branding": "Content Creation", "Social": "Content Creation", "Storytelling": "Content Creation", "Promotion": "Content Creation",
  "Rock Facts": "Humor",
  "Nostalgia": "Lifestyle",
  "Rant": "Other", "D & D": "Other", "Cute Animals": "Other", "Dog training": "Other", "Plants": "Other", "Parenting": "Other", "Poses": "Spicy",
};

function splitFm(content) {
  if (!/^---\r?\n/.test(content)) return null;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? null : { head: content.slice(0, end), rest: content.slice(end) };
}
function readKey(lines, key) {
  const l = lines.find((x) => new RegExp(`^${key}\\s*:`).test(x));
  if (!l) return null;
  const v = l.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim().replace(/^["']|["']$/g, "");
  return v.length ? v : null;
}
function needsQuote(v) { return /[:#&!|>%@*`{}\[\],"']/.test(v) || /^[\s>?-]/.test(v); }
function setKey(lines, key, value) {
  const i = lines.findIndex((x) => new RegExp(`^${key}\\s*:`).test(x));
  const line = `${key}: ${needsQuote(value) ? JSON.stringify(value) : value}`;
  if (i >= 0) lines[i] = line; else lines.push(line);
}

/** Pure: fold a fragment roost_category into its top-level (fragment → subcategory). */
export function foldNote(content, map) {
  const fm = splitFm(content);
  if (!fm) return { content, changed: false, target: null };
  const lines = fm.head.split("\n");
  const cat = readKey(lines, "roost_category");
  const top = cat && map[cat];
  if (!top) return { content, changed: false, target: null };
  setKey(lines, "roost_category", top);
  setKey(lines, "roost_subcategory", cat); // old fragment becomes the subcategory
  return { content: lines.join("\n") + fm.rest, changed: true, target: top };
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
async function main() {
  const apply = process.argv.includes("--apply");
  const vault = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  if (!vault) { console.error("usage: node scripts/fold-auto-categories.mjs <vault-dir> [--apply]"); process.exit(1); }
  const byTarget = {}; let changed = 0;
  for (const f of await walk(vault)) {
    const before = readFileSync(f, "utf8");
    const { content, changed: c, target } = foldNote(before, FRAGMENT);
    if (!c) continue;
    changed++; byTarget[target] = (byTarget[target] ?? 0) + 1;
    if (apply) writeFileSync(f, content);
  }
  console.log(`${apply ? "folded" : "would fold"} ${changed} notes.`);
  console.log("per-target:", Object.entries(byTarget).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));
  if (!apply) console.log("(dry-run; pass --apply to write)");
}
if (import.meta.url === `file://${process.argv[1]}`) main();
