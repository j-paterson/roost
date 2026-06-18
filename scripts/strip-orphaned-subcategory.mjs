// scripts/strip-orphaned-subcategory.mjs
// One-time cleanup: remove roost_subcategory from RESORTED notes. The resort command
// (pre-fix) rewrote roost_category from a note's collection but left the old
// auto-assigned roost_subcategory stranded under the new category. Scope A: a note that
// is collection-driven + human-assigned no longer trusts its old auto subcategory.
// Operates only on the leading YAML frontmatter block, line-oriented.
import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const EMPTY = new Set(["", "undefined", "null"]);

/** Pure: for a resorted note (non-empty `collection` + `roost_assigned_by: human`),
 *  strip the `roost_subcategory:` line from the leading `---` block. Otherwise no-op. */
export function stripOrphanedSubcategory(content) {
  if (!/^---\r?\n/.test(content)) return { content, changed: false };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { content, changed: false };
  const head = content.slice(0, end);
  const rest = content.slice(end);
  const lines = head.split("\n");
  const collectionVal = (lines.find((l) => /^collection\s*:/.test(l)) ?? "")
    .replace(/^collection\s*:\s*/, "").trim().replace(/^["']|["']$/g, "");
  const hasCollection = collectionVal.length > 0 && !EMPTY.has(collectionVal);
  const isHuman = lines.some((l) => /^roost_assigned_by\s*:\s*human\s*$/.test(l));
  if (!hasCollection || !isHuman) return { content, changed: false };
  const kept = lines.filter((l) => !/^roost_subcategory\s*:/.test(l));
  if (kept.length === lines.length) return { content, changed: false };
  return { content: kept.join("\n") + rest, changed: true };
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const vault = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  if (!vault) { console.error("usage: node scripts/strip-orphaned-subcategory.mjs <vault-dir> [--apply]"); process.exit(1); }
  const files = await walk(vault);
  let changed = 0;
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const { content, changed: c } = stripOrphanedSubcategory(before);
    if (!c) continue;
    changed++;
    if (apply) writeFileSync(f, content);
  }
  console.log(`${apply ? "cleared" : "would clear"} roost_subcategory from ${changed} resorted notes (of ${files.length})${apply ? "" : " (dry-run; pass --apply to write)"}`);
}

// Only run when executed directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
