/**
 * Shared loader for an expanded card's structured body text.
 *
 * Pulls renderable body content as a list of segments — used by BOTH the digest
 * `roost-card` block and the gallery in-grid expand so text-only tweets and
 * threads render their real (backfilled) text instead of a rasterized card.png.
 *
 *  - threaded: each self-thread segment becomes {text, isFocal, photoUrls}.
 *    External replies (author replying to other users) are filtered out.
 *  - text-only non-threaded: a single segment with the note body.
 *  Returns an empty array when no useful text is available.
 */
import type { App, TFile } from "obsidian";
import { TFile as RealTFile } from "obsidian";

export interface ResolvedSegment {
  text: string;
  isFocal: boolean;
  photoUrls: string[];
}

interface ThreadSegment {
  text?: string;
  isFocal?: boolean;
  /** Numbered page files in the attach folder that belong to this segment.
   *  Each entry is a 1-indexed page number; the file is either `{N}.jpg` (real
   *  photo) or `{N}.png` (rasterized text card). */
  pages?: number[];
}

interface ThreadJson {
  focalIndex?: number;
  segments?: ThreadSegment[];
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip the YAML frontmatter block from a markdown file's contents. */
function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?\n---\n?/, "").trim();
}

/** Heuristic: identify thread segments that are actually external replies
 *  (the author replied to *another user*, not to themselves). When a segment's
 *  leading @-handle is not the OP author, it's noise. */
function isExternalReplySegment(text: string, opAuthor: string | null): boolean {
  if (!opAuthor) return false;
  const m = text.match(/^@(\w+)/);
  if (!m) return false;
  return m[1].toLowerCase() !== opAuthor.replace(/^@/, "").toLowerCase();
}

/** Resolve a segment's `pages` array to inline-photo resource paths. Only
 *  `{N}.jpg` files count as real photos — `{N}.png` files are rasterized text
 *  cards whose content is already rendered inline. */
function resolveSegmentPhotos(
  app: App,
  attachFolder: string,
  pages: number[] | undefined,
): string[] {
  if (!pages || pages.length === 0 || !attachFolder) return [];
  const out: string[] = [];
  for (const n of pages) {
    const jpg = app.vault.getAbstractFileByPath(`${attachFolder}/${n}.jpg`);
    if (jpg instanceof RealTFile) out.push(app.vault.getResourcePath(jpg));
  }
  return out;
}

export async function loadBodySegments(
  app: App,
  file: TFile,
  attachFolder: string,
  opAuthor: string | null,
): Promise<ResolvedSegment[]> {
  if (attachFolder) {
    const threadFile = app.vault.getAbstractFileByPath(`${attachFolder}/thread.json`);
    if (threadFile instanceof RealTFile) {
      try {
        const parsed = JSON.parse(await app.vault.cachedRead(threadFile)) as ThreadJson;
        const segs = Array.isArray(parsed.segments) ? parsed.segments : [];
        const hasFocalFlag = segs.some((s) => s?.isFocal === true);
        const focalIdx = typeof parsed.focalIndex === "number" ? parsed.focalIndex : 0;
        const out: ResolvedSegment[] = [];
        segs.forEach((seg, i) => {
          if (!seg?.text) return;
          const isFocal = hasFocalFlag ? seg.isFocal === true : i === focalIdx;
          if (!isFocal && isExternalReplySegment(seg.text, opAuthor)) return;
          out.push({
            text: decodeHtmlEntities(seg.text),
            isFocal,
            photoUrls: resolveSegmentPhotos(app, attachFolder, seg.pages),
          });
        });
        if (out.length > 0) return out;
      } catch {
        // fall through to the plain note body
      }
    }
  }
  const raw = await app.vault.cachedRead(file);
  const body = stripFrontmatter(raw)
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .trim();
  if (!body) return [];
  return [{ text: decodeHtmlEntities(body), isFocal: true, photoUrls: [] }];
}
