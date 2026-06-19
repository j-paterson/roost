/**
 * Spicy-facet image detector — thin TS layer over the Python NSFW sidecar.
 *
 * Contract:
 *   POST http://127.0.0.1:11435/classify-nsfw
 *   body    {"paths":["/abs/path/cover.jpg", "/abs/path/video.mp4", ...]}
 *   response {"results":[{"path":"...","nsfw_score":<0..1>},...]}
 *
 * Model: Marqo/nsfw-image-detection-384 via timm.
 *   label_names=['NSFW','SFW'] → softmax index 0 = NSFW score.
 *   For a video.mp4 path the sidecar samples ~5 evenly-spaced keyframes
 *   and returns the max nsfw_score for that path.
 *
 * classifySpicyImage returns the MAX nsfw_score across all supplied paths,
 * or 0 when the sidecar is unreachable or the paths list is empty.
 *
 * spicyEnsemble — OR logic:
 *   image precision is high (~90%); text recall is high (~73%).
 *   Combining with OR targets ~80%+ recall at moderate precision.
 */

import * as path from "path";
import * as fs from "fs";

// ── Sidecar contract ──────────────────────────────────────────────────────────

const NSFW_ENDPOINT = "http://127.0.0.1:11435/classify-nsfw";

interface NsfwResult {
  path: string;
  nsfw_score: number;
}

interface NsfwResponse {
  results: NsfwResult[];
}

// ── Note shape accepted by resolveSpicyImagePaths ─────────────────────────────

/**
 * Minimal frontmatter fields needed to resolve cover + attachment paths.
 *
 * `roost_id` carries `<platform>:<id>` (e.g. "tiktok:7123456789").
 * `cover` is stored as a wikilink string: "[[Bookmarks/TikTok/tiktok-XXX/cover.jpg]]"
 *   or a bare vault-relative path.
 */
export interface SpicyNoteInfo {
  /** Absolute filesystem path to the vault root. */
  vaultPath: string;
  /** Vault-relative path to the note file (e.g. "Bookmarks/TikTok/foo.md"). */
  notePath: string;
  /** Raw frontmatter `roost_id` string, e.g. "tiktok:7123456789". */
  roostId: string;
  /**
   * Raw frontmatter `cover` value, typically a wikilink:
   *   "[[Bookmarks/TikTok/tiktok-7123456789/cover.jpg]]"
   * or a bare vault-relative path like:
   *   "Bookmarks/TikTok/tiktok-7123456789/cover.jpg"
   */
  cover?: string;
}

// ── resolveSpicyImagePaths ────────────────────────────────────────────────────

/** Known static thumbnail filenames, in priority order. */
const COVER_NAMES = [
  "cover.jpg",
  "video-poster.jpg",
  "card-thumb.jpg",
  "card.png",
  "thumb.png",
] as const;

/** Maximum numbered image index to probe (1.jpg … N.jpg). */
const MAX_NUMBERED_IMG = 11;

/**
 * Resolve the set of absolute image/video paths for a note.
 *
 * Attachment folder layout: `<noteDir>/<platform>-<id>/`
 *   e.g. Bookmarks/TikTok/tiktok-7123456789/
 *
 * Probes (in order):
 *  1. Absolute path derived from the `cover` wikilink / bare path in frontmatter.
 *  2. Named thumbnails (cover.jpg, video-poster.jpg, …) in the attachment folder.
 *  3. Numbered images 1.jpg … 11.jpg in the attachment folder.
 *  4. video.mp4 in the attachment folder (sidecar samples keyframes from it).
 *
 * Only paths that exist on disk are included.
 * Duplicate paths are de-duplicated (cover wikilink often points at cover.jpg).
 */
export function resolveSpicyImagePaths(note: SpicyNoteInfo): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  function add(absPath: string): void {
    const norm = path.normalize(absPath);
    if (!seen.has(norm) && fs.existsSync(norm)) {
      seen.add(norm);
      paths.push(norm);
    }
  }

  // 1. Frontmatter cover wikilink / bare path
  if (note.cover) {
    const coverRel = note.cover
      .replace(/^\[\[/, "")
      .replace(/\]\]$/, "")
      .replace(/^"/, "")
      .replace(/"$/, "");
    if (coverRel) {
      add(path.join(note.vaultPath, coverRel));
    }
  }

  // 2 & 3 & 4. Attachment folder: <noteDir>/<platform>-<id>/
  const [platform, itemId] = note.roostId.split(":", 2);
  if (platform && itemId) {
    const noteDir = path.dirname(path.join(note.vaultPath, note.notePath));
    const attachDir = path.join(noteDir, `${platform}-${itemId}`);

    // Named thumbnails
    for (const name of COVER_NAMES) {
      add(path.join(attachDir, name));
    }

    // Numbered images
    for (let i = 1; i <= MAX_NUMBERED_IMG; i++) {
      add(path.join(attachDir, `${i}.jpg`));
    }

    // Video (sidecar samples ~5 evenly-spaced keyframes)
    add(path.join(attachDir, "video.mp4"));
  }

  return paths;
}

// ── classifySpicyImage ────────────────────────────────────────────────────────

/**
 * Send `coverPaths` to the NSFW sidecar and return the maximum nsfw_score.
 *
 * Returns 0 when:
 *  - `coverPaths` is empty.
 *  - The sidecar is unreachable or returns an unexpected response.
 *  - All returned scores are absent/malformed.
 *
 * @param coverPaths  Absolute paths to images and/or video.mp4 files.
 */
export async function classifySpicyImage(coverPaths: string[]): Promise<number> {
  if (coverPaths.length === 0) return 0;

  try {
    const response = await fetch(NSFW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: coverPaths }),
    });

    if (!response.ok) return 0;

    const data = (await response.json()) as NsfwResponse;
    if (!Array.isArray(data?.results) || data.results.length === 0) return 0;

    let maxScore = 0;
    for (const result of data.results) {
      const score = typeof result?.nsfw_score === "number" ? result.nsfw_score : 0;
      if (score > maxScore) maxScore = score;
    }
    return maxScore;
  } catch {
    // Sidecar not running or network error — degrade gracefully
    return 0;
  }
}

// ── spicyEnsemble ─────────────────────────────────────────────────────────────

/**
 * Combine image and text NSFW scores with OR logic.
 *
 * The image detector is precision-high (~90%) and the text detector is
 * recall-high (~73%).  OR-ing them achieves ~80%+ recall.
 *
 * @param imageScore  nsfw_score from classifySpicyImage (0–1).
 * @param textScore   Spicy text-detector score (0–1).
 * @param imgThr      Image threshold (default 0.5).
 * @param textThr     Text threshold (caller-supplied; no default — must be explicit).
 * @returns           true when either signal fires.
 */
export function spicyEnsemble(
  imageScore: number,
  textScore: number,
  imgThr: number = 0.5,
  textThr: number,
): boolean {
  return imageScore >= imgThr || textScore >= textThr;
}
