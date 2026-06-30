/**
 * Canonical helpers for reading Obsidian Bases entry properties.
 * Obsidian's getValue throws on null frontmatter values — always go through safeGetValue.
 */
import type { BasesEntry, BasesPropertyId } from "obsidian";

export function safeGetValue(entry: BasesEntry, key: string): unknown {
  try {
    return entry.getValue(key as BasesPropertyId);
  } catch {
    return null;
  }
}

/**
 * Read an OPTIONAL string property as a real string or null. A Base that
 * declares a column (e.g. link_url) hands back a null/empty Value wrapper for
 * notes lacking that field — and `wrapper.toString()` is the literal "null", so
 * `safeGetValue(...)?.toString() ?? null` wrongly yields the truthy string
 * "null". This collapses those wrapper sentinels ("null"/"undefined"/"") to null
 * so callers can treat absent fields as absent. Use for any optional string
 * frontmatter where a sentinel must NOT read as a present value.
 */
export function safeGetString(entry: BasesEntry, key: string): string | null {
  const v = safeGetValue(entry, key);
  if (v == null) return null;
  const s = v.toString();
  return s === "" || s === "null" || s === "undefined" ? null : s;
}

export function getRoostId(entry: BasesEntry): string {
  return safeGetValue(entry, "note.roost_id")?.toString() ?? entry.file.basename;
}

export function getNoteTitle(entry: BasesEntry): string {
  const raw = safeGetValue(entry, "note.title");
  return raw != null ? String(raw) : entry.file.basename;
}

/** Strip People/ wikilink brackets from author frontmatter for display. */
export function stripAuthorWiki(author: unknown): string | null {
  if (author == null) return null;
  return author.toString().replace(/\[\[People\/|\]\]/g, "");
}

export function getNoteAuthor(entry: BasesEntry): string | null {
  return stripAuthorWiki(safeGetValue(entry, "note.author"));
}

/** Parse comma-separated tags; returns undefined when absent (gallery expanded card). */
export function parseEntryTags(
  entry: BasesEntry,
  opts?: { excludePrefixes?: string[] },
): string[] | undefined {
  const tagsValue = safeGetValue(entry, "note.tags")?.toString();
  if (!tagsValue) return undefined;
  const exclude = opts?.excludePrefixes ?? [];
  const tags = tagsValue
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !exclude.some((p) => t.startsWith(p)));
  return tags.length > 0 ? tags : undefined;
}

export function entryStatsFromBases(entry: BasesEntry): {
  plays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
} {
  return {
    plays: Number(safeGetValue(entry, "note.stats_plays")) || undefined,
    likes: Number(safeGetValue(entry, "note.stats_likes")) || undefined,
    comments: Number(safeGetValue(entry, "note.stats_comments")) || undefined,
    shares: Number(safeGetValue(entry, "note.stats_shares")) || undefined,
  };
}
