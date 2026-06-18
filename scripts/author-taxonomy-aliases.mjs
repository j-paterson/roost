// scripts/author-taxonomy-aliases.mjs
// One-time: write platform:collection -> top-level alias entries for the consolidated
// 19-category taxonomy. Enumerates the vault's actual (platform, collection) pairs and
// maps each via TOPLEVEL. Identity collections (collection === top-level) get no entry
// (the resort falls back to the raw collection name). Merges into the existing alias map.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Resolved category -> consolidated top-level (full 46→19, identities included). The
// alias map is single-level, so we resolve each raw collection through any EXISTING alias
// to its intermediate category, then map that to the final top-level and write a DIRECT
// alias (raw collection → top-level). Identities (Food→Food) are skipped (no entry needed).
const CATEGORY_TOPLEVEL = {
  "AI": "Tech", "web3": "Tech", "Code": "Tech", "Immersive (AR/VR)": "Tech", "Technology": "Tech", "DAOs": "Tech", "Trading": "Tech",
  "Design": "Design", "Graphics": "Design",
  "Art": "Art", "Tattoo": "Art",
  "Crafts": "Crafts",
  "Stuff": "Products",
  "Food": "Food",
  "Places": "Places & Travel", "Austin": "Places & Travel", "Travel": "Places & Travel", "Event": "Places & Travel",
  "Media": "Media", "Edits": "Media",
  "Fitness": "Fitness", "Dance": "Fitness",
  "Macro": "Money", "Business": "Money", "Finances": "Money",
  "Learning": "Growth", "Motivation": "Growth", "Kaizen": "Growth",
  "Relationships": "Relationships", "Rizz": "Relationships",
  "Spicy": "Spicy",
  "Lifestyle": "Lifestyle",
  "Fashion": "Fashion",
  "Quotes": "Quotes",
  "Content Creation": "Content Creation", "Branding": "Content Creation", "Social": "Content Creation", "Storytelling": "Content Creation",
  "Humor": "Humor", "Rock Facts": "Humor",
  "Rant": "Other", "D & D": "Other", "Cute Animals": "Other", "Dog training": "Other", "Plants": "Other", "Parenting": "Other",
};

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
function fmVal(content, key) {
  const end = content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
  const head = end > 0 ? content.slice(0, end) : "";
  const m = head.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const vault = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  if (!vault) { console.error("usage: node scripts/author-taxonomy-aliases.mjs <vault-dir> [--apply]"); process.exit(1); }

  const present = new Set(); // "platform\tcollection"
  for (const f of await walk(vault)) {
    const c = readFileSync(f, "utf8");
    const platform = fmVal(c, "platform"), collection = fmVal(c, "collection");
    if (platform && collection) present.add(`${platform}\t${collection}`);
  }

  const aliasPath = join(vault, ".roost", "cache", "collection-aliases.json");
  const existing = existsSync(aliasPath) ? JSON.parse(readFileSync(aliasPath, "utf8")) : {};
  const next = { ...existing };
  let added = 0;
  const identity = new Set();   // collection already IS its top-level → no entry needed
  const unknown = new Set();    // intermediate not in CATEGORY_TOPLEVEL → would become its own category
  for (const pc of present) {
    const [platform, collection] = pc.split("\t");
    const key = `${platform}:${collection}`;
    const intermediate = existing[key] ?? collection;      // chase one existing alias level
    const top = CATEGORY_TOPLEVEL[intermediate];
    if (top === undefined) { unknown.add(`${collection} (→${intermediate})`); continue; }
    if (top === collection) { identity.add(collection); continue; } // already the top-level
    if (next[key] !== top) { next[key] = top; added++; }
  }
  console.log(`${apply ? "wrote" : "would write"} ${added} direct alias entries (${Object.keys(next).length} total in map).`);
  console.log(`identity (no entry, already the top-level): ${[...identity].sort().join(", ")}`);
  if (unknown.size) console.log(`\n⚠️  UNKNOWN intermediates (would become their own category — FIX before --apply): ${[...unknown].sort().join(", ")}`);
  if (apply) writeFileSync(aliasPath, JSON.stringify(next, null, 2));
}
main();
