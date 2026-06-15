/**
 * Shared card-render helpers used by both the gallery
 * (BookmarksBasesView) and the feed view (BookmarksFeedView).
 *
 * Extracted from bookmarks-bases-view.ts so both views read covers and
 * videos the same way. Pure functions of (app, entry) — no view state.
 */
import type { App, BasesEntry } from "obsidian";
import { TFile } from "obsidian";
import { safeGetValue } from "@/lib/bases-entry";
import { stripWikilink } from "@/lib/vault-utils";

/** Folder that holds the entry's attachments, derived from `note.cover`. */
export function getCoverFolder(entry: BasesEntry): string | null {
  const coverValue = safeGetValue(entry, "note.cover");
  if (!coverValue) return null;
  return stripWikilink(coverValue.toString()).replace(/\/[^/]+$/, "");
}

/** Local video file for the entry (media.mp4, video.mp4, media.mov). */
export function resolveVideoUrl(app: App, entry: BasesEntry): string | null {
  const folder = getCoverFolder(entry);
  if (!folder) return null;
  for (const name of ["media.mp4", "video.mp4", "media.mov"]) {
    const file = app.vault.getAbstractFileByPath(`${folder}/${name}`);
    if (file instanceof TFile) return app.vault.getResourcePath(file);
  }
  return null;
}

/** Cover image resource path or http URL, resolved from the given property. */
export function resolveImageUrl(app: App, entry: BasesEntry, propId: string): string | null {
  const value = safeGetValue(entry, propId);
  if (!value) return null;
  let pathStr = value.toString();
  if (!pathStr) return null;
  pathStr = stripWikilink(pathStr);
  const file = app.vault.getAbstractFileByPath(pathStr);
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  if (pathStr.startsWith("http")) return pathStr;
  return null;
}

/**
 * True when the entry's cover is a generated text-card image rather than real
 * downloaded media — `card.png` (non-threaded text-only tweet) or a threaded
 * numbered `.png` focal page (cover is `N.png` and a `thread.json` sidecar
 * exists). Now that tweet bodies are backfilled into the note, these covers are
 * redundant: the gallery renders a text tile from `note.title` instead. The
 * digest path uses the same rule to suppress rasterized-text covers.
 */
export function isRasterizedTextCover(app: App, entry: BasesEntry): boolean {
  const coverValue = safeGetValue(entry, "note.cover");
  if (!coverValue) return false;
  const coverRaw = stripWikilink(coverValue.toString());
  if (!coverRaw) return false;
  if (/\/card\.png$/i.test(coverRaw)) return true;
  if (/\/\d+\.png$/i.test(coverRaw)) {
    const folder = coverRaw.replace(/\/[^/]+$/, "");
    return app.vault.getAbstractFileByPath(`${folder}/thread.json`) instanceof TFile;
  }
  return false;
}

/** Quick check: does the entry's folder contain a second image (e.g. 2.jpg)? */
export function hasMultipleImages(app: App, entry: BasesEntry): boolean {
  const folder = getCoverFolder(entry);
  if (!folder) return false;
  return !!app.vault.getAbstractFileByPath(`${folder}/2.jpg`);
}

/** All numbered images in the attachment folder (1.jpg, 2.jpg, …). */
export function resolveAllImages(app: App, entry: BasesEntry): string[] {
  const folder = getCoverFolder(entry);
  if (!folder) return [];
  const urls: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const jpg = app.vault.getAbstractFileByPath(`${folder}/${i}.jpg`);
    if (jpg instanceof TFile) { urls.push(app.vault.getResourcePath(jpg)); continue; }
    const png = app.vault.getAbstractFileByPath(`${folder}/${i}.png`);
    if (png instanceof TFile) { urls.push(app.vault.getResourcePath(png)); continue; }
    break;
  }
  return urls;
}
