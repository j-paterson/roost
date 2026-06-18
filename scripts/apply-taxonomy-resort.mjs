// scripts/apply-taxonomy-resort.mjs
// One-time bulk resort: mirror of resortPatch (packages/core/src/sync/resort-by-collection.ts,
// commit 4ccc3ce) applied headlessly to the vault. Rewrites roost_category to the alias-
// resolved top-level, stamps roost_assigned_by: human, and sets roost_subcategory to the
// folded collection name (or clears an orphan). Line-oriented frontmatter edits — only the
// three roost_* scalar lines are touched; everything else stays byte-identical.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const EMPTY = new Set(["", "undefined", "null"]);

function splitFrontmatter(content) {
  if (!/^---\r?\n/.test(content)) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  return { head: content.slice(0, end), rest: content.slice(end) };
}
function readKey(lines, key) {
  const m = lines.find((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (!m) return null;
  const v = m.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim().replace(/^["']|["']$/g, "");
  return v.length ? v : null;
}
function needsQuote(v) { return /[:#&!|>%@*`{}\[\],"']/.test(v) || /^[\s>?-]/.test(v); }
function fmt(key, value) { return `${key}: ${needsQuote(value) ? JSON.stringify(value) : value}`; }
function setKey(lines, key, value) { // value=string → set/replace; null → delete
  const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (value === null) { if (i >= 0) lines.splice(i, 1); return; }
  const line = fmt(key, value);
  if (i >= 0) lines[i] = line; else lines.push(line);
}

/** Pure: apply the resort rule to one note's content. Returns {content, changed, target}. */
export function resortNote(content, aliases) {
  const fmtxt = splitFrontmatter(content);
  if (!fmtxt) return { content, changed: false, target: null };
  const lines = fmtxt.head.split("\n");
  const collection = readKey(lines, "collection");
  if (!collection || EMPTY.has(collection)) return { content, changed: false, target: null };
  const platform = readKey(lines, "platform") ?? "";
  const target = aliases[`${platform}:${collection}`] ?? collection;
  const curCat = readKey(lines, "roost_category");
  const curBy = readKey(lines, "roost_assigned_by");
  const curSub = readKey(lines, "roost_subcategory");
  const desiredSub = collection !== target ? collection : (curCat !== target ? null : undefined);
  const subOk = desiredSub === undefined || desiredSub === curSub;
  if (curCat === target && curBy === "human" && subOk) return { content, changed: false, target };
  setKey(lines, "roost_category", target);
  setKey(lines, "roost_assigned_by", "human");
  if (desiredSub !== undefined && desiredSub !== curSub) setKey(lines, "roost_subcategory", desiredSub);
  return { content: lines.join("\n") + fmtxt.rest, changed: true, target };
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
  if (!vault) { console.error("usage: node scripts/apply-taxonomy-resort.mjs <vault-dir> [--apply]"); process.exit(1); }
  const aliasPath = join(vault, ".roost", "cache", "collection-aliases.json");
  const aliases = existsSync(aliasPath) ? JSON.parse(readFileSync(aliasPath, "utf8")) : {};
  const byTarget = {}; let changed = 0; const samples = [];
  for (const f of await walk(vault)) {
    const before = readFileSync(f, "utf8");
    const { content, changed: c, target } = resortNote(before, aliases);
    if (!c) continue;
    changed++; byTarget[target] = (byTarget[target] ?? 0) + 1;
    if (samples.length < 4) samples.push(f.split("/").pop());
    if (apply) writeFileSync(f, content);
  }
  const top = Object.entries(byTarget).sort((a, b) => b[1] - a[1]);
  console.log(`${apply ? "resorted" : "would resort"} ${changed} notes into ${top.length} categories.`);
  console.log("per-category:", top.map(([k, v]) => `${k}:${v}`).join("  "));
  if (!apply) console.log("sample changed files:", samples.join(", "), "\n(dry-run; pass --apply to write)");
}

// Only run when executed directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
