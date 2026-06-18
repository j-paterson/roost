// scripts/strip-folder-stamp.mjs
// One-time cleanup: remove orphaned `enrichment_v_folder` stamps left by the now-removed
// folder enrichment. Operates only on the leading YAML frontmatter block, line-oriented,
// so it cannot perturb body content or sibling keys.
import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Pure: strip the single `enrichment_v_folder:` line from the leading `---` block. */
export function stripFolderStampFromFrontmatter(content) {
  if (!content.startsWith("---\n")) return { content, changed: false };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { content, changed: false };
  const head = content.slice(0, end);
  const rest = content.slice(end);
  const kept = head.split("\n").filter((line) => !/^enrichment_v_folder\s*:/.test(line));
  const newHead = kept.join("\n");
  if (newHead === head) return { content, changed: false };
  return { content: newHead + rest, changed: true };
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
  if (!vault) { console.error("usage: node scripts/strip-folder-stamp.mjs <vault-dir> [--apply]"); process.exit(1); }
  const files = await walk(vault);
  let changed = 0;
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const { content, changed: c } = stripFolderStampFromFrontmatter(before);
    if (!c) continue;
    changed++;
    if (apply) writeFileSync(f, content);
  }
  console.log(`${apply ? "stripped" : "would strip"} enrichment_v_folder from ${changed} of ${files.length} notes${apply ? "" : " (dry-run; pass --apply to write)"}`);
}

// Only run when executed directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
