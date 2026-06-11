/**
 * Shared vault utilities — frontmatter building, folder creation, and author notes.
 */
import { TFile, Vault } from "obsidian";

/** Values that can appear as frontmatter field values. */
export type FrontmatterValue = string | number | string[] | null | undefined;

/**
 * Build YAML frontmatter string from a record of fields.
 * Arrays become YAML lists, strings with special chars get quoted.
 */
export function buildFrontmatter(fields: Record<string, FrontmatterValue>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length > 0) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlStr(String(item))}`);
    } else if (typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === "string") {
      lines.push(`${k}: ${yamlStr(v)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse a YAML frontmatter block into ordered key-value entries.
 * Preserves field order and handles multi-line values (arrays, quoted strings).
 */
export function parseFrontmatterEntries(fmBlock: string): { key: string | null; fullBlock: string }[] {
  const lines = fmBlock.split("\n");
  const entries: { key: string | null; fullBlock: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\w[\w_]*)\s*:/);
    if (m) {
      const key = m[1];
      let block = line;
      let j = i + 1;
      while (j < lines.length) {
        if (lines[j].match(/^\w[\w_]*\s*:/)) break;
        block += "\n" + lines[j];
        j++;
      }
      entries.push({ key, fullBlock: block });
      i = j;
    } else {
      entries.push({ key: null, fullBlock: line });
      i++;
    }
  }
  return entries;
}

/** Rebuild a frontmatter block from ordered entries. */
function rebuildFrontmatter(entries: { key: string | null; fullBlock: string }[]): string {
  return entries.map(e => e.fullBlock).join("\n");
}

/** Does this string value need YAML quoting? */
function needsQuoting(s: string): boolean {
  return s.length === 0
    || s.includes('"') || s.includes(":") || s.includes("#")
    || s.includes("\n") || s.includes("\r") || s.includes("\t")
    || /^[-?>|&*!%'`@\[{ ]/.test(s) || s.endsWith(" ");
}

/** YAML-escape a string value for frontmatter. Only quotes when necessary. */
function yamlStr(val: string | number | null | undefined): string {
  if (val == null) return '""';
  const s = String(val);
  if (needsQuoting(s)) {
    return `"${s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}"`;
  }
  return s;
}

/**
 * Update specific frontmatter fields in an existing note's content.
 * Returns the updated content string, or null if no changes were made.
 * Preserves field order and only touches fields in `updates`.
 */
export function updateNoteFrontmatter(
  content: string,
  updates: Record<string, FrontmatterValue>,
): string | null {
  // Early exit if empty updates object
  if (Object.keys(updates).length === 0) return null;
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;

  const fmBlock = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5);
  const entries = parseFrontmatterEntries(fmBlock);
  const entryMap = new Map(entries.filter(e => e.key).map(e => [e.key!, e]));
  let changed = false;

  for (const [key, value] of Object.entries(updates)) {
    const existing = entryMap.get(key);
    if (value == null) {
      // null/undefined = remove the field
      if (existing) {
        const idx = entries.indexOf(existing);
        if (idx !== -1) { entries.splice(idx, 1); changed = true; }
      }
      continue;
    }
    const formatted = typeof value === "number"
      ? `${key}: ${value}`
      : Array.isArray(value)
        ? `${key}:\n${value.map(v => `  - ${yamlStr(String(v))}`).join("\n")}`
        : `${key}: ${yamlStr(value)}`;
    if (existing) {
      if (existing.fullBlock !== formatted) {
        existing.fullBlock = formatted;
        changed = true;
      }
    } else {
      // Insert before tags if present, otherwise at end
      const tagsIdx = entries.findIndex(e => e.key === "tags");
      const insertIdx = tagsIdx !== -1 ? tagsIdx : entries.length;
      entries.splice(insertIdx, 0, { key, fullBlock: formatted });
      changed = true;
    }
  }

  if (!changed) return null;
  const newFm = rebuildFrontmatter(entries);
  return `---\n${newFm}\n---\n${body}`;
}

/**
 * Write a note, falling back to modify if the file already exists.
 *
 * Guards against two failure modes in `vault.create`:
 * - `getAbstractFileByPath` returns null for files Obsidian hasn't indexed yet
 *   (paths with Unicode, accents, or files created in the current session).
 * - A race between sibling writes where the index lags the filesystem.
 *
 * On "File already exists", re-queries the adapter and does a direct `modify`.
 */
export async function writeNoteSafe(vault: Vault, path: string, content: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing) {
    await vault.modify(existing as TFile, content);
    return;
  }
  try {
    await vault.create(path, content);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists/i.test(msg)) throw e;
    const found = vault.getAbstractFileByPath(path);
    if (found) {
      await vault.modify(found as TFile, content);
    } else {
      await vault.adapter.write(path, content);
    }
  }
}

/**
 * Recursively create vault folders, memoizing to avoid repeated calls.
 */
export async function ensureFolder(vault: Vault, path: string, memo: Set<string>): Promise<void> {
  if (memo.has(path)) return;
  const parts = path.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!memo.has(current)) {
      try { await vault.createFolder(current); } catch { /* already exists */ }
      memo.add(current);
    }
  }
}

/**
 * Ensure a People/{handle}.md author note exists, memoizing to avoid duplicates.
 * Returns a wikilink string like `[[People/@username]]`.
 */
export async function ensureAuthorNote(
  vault: Vault,
  handle: string,
  platform: string,
  authorMemo: Set<string>,
  folderMemo: Set<string>,
): Promise<string> {
  const link = `[[People/${handle}]]`;
  if (authorMemo.has(handle)) return link;
  const notePath = `People/${handle}.md`;
  await ensureFolder(vault, "People", folderMemo);
  if (!vault.getAbstractFileByPath(notePath)) {
    try {
      const fm = `---\ntype: person\nplatform: ${platform}\nhandle: "${handle}"\n---\n\n# ${handle}\n`;
      await vault.create(notePath, fm);
    } catch { /* exists */ }
  }
  authorMemo.add(handle);
  return link;
}
