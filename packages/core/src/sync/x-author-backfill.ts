/**
 * One-shot backfill: re-extract author for X bookmark notes whose `author`
 * frontmatter is "[[People/Unknown]]". Needed because X migrated the User
 * schema (early 2026) — `name` and `screen_name` moved from `user.legacy`
 * to `user.core`. Notes synced before src/lib/extract.ts was updated have
 * `Unknown` baked in.
 *
 * For each affected note:
 *   1. Find raw.json in the note's attachment folder.
 *   2. Run the (now-fixed) extractor to get the real author + screen_name.
 *   3. Rewrite the note's `author` and `url` frontmatter fields.
 *   4. Ensure the corresponding `People/@{handle}.md` author note exists.
 *
 * Returns counts so the UI can summarize the run.
 */

import { App, TFile } from "obsidian";
import { extractBookmarkAuthor, extractBookmarkAuthorUsername } from "@/lib/extract";
import { ensureAuthorNote, updateNoteFrontmatter } from "@/lib/vault-helpers";
import type { NormalizedRecord } from "@/types/sync";

export interface BackfillResult {
  scanned: number;
  matchedUnknown: number;
  rawJsonMissing: number;
  stillUnknown: number;
  updated: number;
  failed: number;
}

const UNKNOWN_AUTHOR_RE = /^\s*\[\[People\/Unknown\]\]\s*$/;

export async function backfillXAuthors(
  app: App,
  syncFolder: string,
  log: (msg: string) => void,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    matchedUnknown: 0,
    rawJsonMissing: 0,
    stillUnknown: 0,
    updated: 0,
    failed: 0,
  };

  const xFolder = `${syncFolder}/X`;
  const allFiles = app.vault.getMarkdownFiles().filter((f) =>
    f.path.startsWith(`${xFolder}/`),
  );

  const createdAuthors = new Set<string>();
  const ensuredFolders = new Set<string>();

  for (const file of allFiles) {
    result.scanned++;

    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) continue;
    const author = typeof fm.author === "string" ? fm.author : "";
    if (!UNKNOWN_AUTHOR_RE.test(author)) continue;

    result.matchedUnknown++;

    // Find raw.json — note path is e.g. "Bookmarks/X/Unknown - 12345.md"
    // and the attach folder is "Bookmarks/X/twitter-12345/raw.json".
    const itemId =
      (typeof fm.roost_id === "string" && fm.roost_id.split(":")[1]) ||
      file.basename.split(" - ").pop();
    if (!itemId) {
      result.failed++;
      continue;
    }
    const rawPath = `${xFolder}/twitter-${itemId}/raw.json`;
    const rawFile = app.vault.getAbstractFileByPath(rawPath);
    if (!(rawFile instanceof TFile)) {
      result.rawJsonMissing++;
      continue;
    }

    let rawData: unknown;
    try {
      rawData = JSON.parse(await app.vault.read(rawFile));
    } catch (err) {
      log(`backfill: failed to parse ${rawPath}: ${err instanceof Error ? err.message : String(err)}`);
      result.failed++;
      continue;
    }

    const record = { platform: "twitter", itemId, rawData } as unknown as NormalizedRecord;
    const newAuthorName = extractBookmarkAuthor(record);
    const newUsername = extractBookmarkAuthorUsername(record);
    if (newAuthorName === "Unknown" || !newUsername) {
      result.stillUnknown++;
      continue;
    }

    const handle = `@${newUsername}`;
    const authorLink = await ensureAuthorNote(
      app.vault,
      handle,
      "twitter",
      createdAuthors,
      ensuredFolders,
    );

    const url = `https://x.com/${newUsername}/status/${itemId}`;

    try {
      const content = await app.vault.read(file);
      const updated = updateNoteFrontmatter(content, {
        author: authorLink,
        url,
      });
      if (updated && updated !== content) {
        await app.vault.modify(file, updated);
        result.updated++;
      }
    } catch (err) {
      log(`backfill: failed to update ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      result.failed++;
    }
  }

  return result;
}
