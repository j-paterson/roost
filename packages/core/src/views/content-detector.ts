/**
 * Content type detection for vault entries.
 * Examines frontmatter to determine how a card should be rendered.
 */
import { type BasesEntry, type App, TFile } from "obsidian";
import { safeGetValue } from "@/lib/bases-entry";
import { stripWikilink } from "@/lib/vault-utils";

export enum ContentType {
  Bookmark = "bookmark",  // has roost_id — use existing bookmark rendering
  Media = "media",        // has image/video attachments but no roost_id
  Link = "link",          // has a url frontmatter field
  Note = "note",          // default — markdown text content
}

/** Check if a Bases Value is actually non-null/non-empty */
function hasValue(raw: unknown): boolean {
  if (raw == null) return false;
  const str = String(raw);
  return str !== "" && str !== "null" && str !== "undefined";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi"]);
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, "pdf"]);

/** Video files stored next to cover image in attachment folders */
const VIDEO_SIBLING_NAMES = ["media.mp4", "video.mp4", "media.mov"] as const;

function isImageExtension(ext: string | undefined): boolean {
  return !!ext && IMAGE_EXTS.has(ext.toLowerCase());
}

function isMediaExtension(ext: string | undefined): boolean {
  return !!ext && MEDIA_EXTS.has(ext.toLowerCase());
}

/** First sibling video file in the same folder as a cover/banner path */
function findSiblingVideoFile(app: App, coverOrBannerPath: string): TFile | null {
  const imgPath = stripWikilink(coverOrBannerPath);
  if (!imgPath) return null;
  const folder = imgPath.replace(/\/[^/]+$/, "");
  for (const name of VIDEO_SIBLING_NAMES) {
    const file = app.vault.getAbstractFileByPath(`${folder}/${name}`);
    if (file instanceof TFile) return file;
  }
  return null;
}

/** Resource URL when the vault file itself is an image */
export function imageResourcePathForFile(app: App, file: TFile): string | null {
  if (!isImageExtension(file.extension)) return null;
  return app.vault.getResourcePath(file);
}

export function detectContentType(entry: BasesEntry, app: App): ContentType {
  // 0. Check file extension — images, videos, PDFs are media
  if (isMediaExtension(entry.file.extension)) {
    return ContentType.Media;
  }

  // 1. Roost bookmark
  const roostId = safeGetValue(entry, "note.roost_id");
  if (hasValue(roostId)) {
    return ContentType.Bookmark;
  }

  // 2. Has cover/banner image or video attachments
  const cover = safeGetValue(entry, "note.cover");
  const banner = safeGetValue(entry, "note.banner");
  const coverStr = hasValue(cover) ? String(cover) : null;
  const bannerStr = hasValue(banner) ? String(banner) : null;
  if (coverStr || bannerStr) {
    const imgPath = (coverStr || bannerStr)!;
    if (findSiblingVideoFile(app, imgPath)) return ContentType.Media;
    const imgFile = app.vault.getAbstractFileByPath(stripWikilink(imgPath));
    if (imgFile instanceof TFile) return ContentType.Media;
  }

  // 3. Has a URL — link card
  const url = safeGetValue(entry, "note.url");
  const urlStr = hasValue(url) ? String(url) : null;
  if (urlStr && (urlStr.startsWith("http://") || urlStr.startsWith("https://"))) {
    return ContentType.Link;
  }

  // 4. Default — note
  return ContentType.Note;
}

/** Extract domain from a URL string */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Re-export hasValue for use by card renderers */
export { hasValue };
