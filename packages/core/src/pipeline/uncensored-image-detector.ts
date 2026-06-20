/**
 * Uncensored content image detector — a general, category-agnostic side branch.
 *
 * This is NOT tied to any specific category name. It answers "does this image
 * contain explicit/uncensored content?" via a local classifier, and the caller
 * decides which of the USER's categories (settings.uncensoredCategories) are
 * uncensored and should route through here. The classifier knows nothing about
 * "Spicy"/"Adult"/etc — those live only in the user's vault data + config.
 *
 * This module exists because cloud LLMs refuse explicit/uncensored content;
 * the local classifier path is censorship-resistant by design.
 *
 * Contract:
 *   POST http://127.0.0.1:11435/classify-uncensored
 *   body    {"paths":["/abs/path/cover.jpg", "/abs/path/video.mp4", ...]}
 *   response {"results":[{"path":"...","score":<0..1>},...]}
 *
 * Model: Marqo/nsfw-image-detection-384 via timm.
 *   label_names=['NSFW','SFW'] → softmax index 0 = NSFW score.
 *   For a video.mp4 path the sidecar samples ~5 evenly-spaced keyframes
 *   and returns the max score for that path.
 *
 * classifyUncensoredImage returns the MAX score across all supplied paths,
 * or 0 when the sidecar is unreachable or the paths list is empty.
 *
 * uncensoredEnsemble — OR logic: the image signal is precision-high (~90%), a text
 * detector is recall-high (~73%); OR-ing targets ~80%+ recall. Refusal-proof:
 * the image path is independent of the cloud LLM that declines explicit/uncensored content.
 */

import * as path from "path";
import * as fs from "fs";

// ── Sidecar contract ──────────────────────────────────────────────────────────

const UNCENSORED_ENDPOINT = "http://127.0.0.1:11435/classify-uncensored";

interface UncensoredResult {
  path: string;
  score: number;
}

interface UncensoredResponse {
  results: UncensoredResult[];
}

// ── Note shape accepted by resolveAttachmentImagePaths ────────────────────────

/**
 * Minimal frontmatter fields needed to resolve cover + attachment paths.
 *
 * `roostId` carries `<platform>:<id>` (e.g. "tiktok:7123456789").
 * `cover` is stored as a wikilink string: "[[Bookmarks/TikTok/tiktok-XXX/cover.jpg]]"
 *   or a bare vault-relative path.
 */
export interface NoteImageInfo {
  /** Absolute filesystem path to the vault root. */
  vaultPath: string;
  /** Vault-relative path to the note file (e.g. "Bookmarks/TikTok/foo.md"). */
  notePath: string;
  /** Raw frontmatter `roost_id` string, e.g. "tiktok:7123456789". */
  roostId: string;
  /**
   * Raw frontmatter `cover` value, typically a wikilink:
   *   "[[Bookmarks/TikTok/tiktok-7123456789/cover.jpg]]"
   * or a bare vault-relative path.
   */
  cover?: string;
}

// ── resolveAttachmentImagePaths ───────────────────────────────────────────────

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
 * Probes (in order): the `cover` frontmatter wikilink/bare path; named
 * thumbnails; numbered images 1.jpg…11.jpg; video.mp4 (the sidecar samples
 * keyframes from it). Only existing, de-duplicated paths are returned.
 */
export function resolveAttachmentImagePaths(note: NoteImageInfo): string[] {
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

    for (const name of COVER_NAMES) {
      add(path.join(attachDir, name));
    }
    for (let i = 1; i <= MAX_NUMBERED_IMG; i++) {
      add(path.join(attachDir, `${i}.jpg`));
    }
    add(path.join(attachDir, "video.mp4"));
  }

  return paths;
}

// ── classifyUncensoredImage ───────────────────────────────────────────────────

/**
 * Send `imagePaths` to the uncensored-content sidecar and return the maximum score.
 * Returns 0 on empty input, an unreachable sidecar, or a malformed response.
 *
 * The underlying classifier (Marqo/nsfw-image-detection-384) detects explicit
 * image content; the local path is censorship-resistant (cloud LLMs refuse
 * explicit/uncensored content).
 *
 * @param imagePaths  Absolute paths to images and/or video.mp4 files.
 */
export async function classifyUncensoredImage(imagePaths: string[]): Promise<number> {
  if (imagePaths.length === 0) return 0;

  try {
    const response = await fetch(UNCENSORED_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: imagePaths }),
    });

    if (!response.ok) return 0;

    const data = (await response.json()) as UncensoredResponse;
    if (!Array.isArray(data?.results) || data.results.length === 0) return 0;

    let maxScore = 0;
    for (const result of data.results) {
      const score = typeof result?.score === "number" ? result.score : 0;
      if (score > maxScore) maxScore = score;
    }
    return maxScore;
  } catch {
    // Sidecar not running or network error — degrade gracefully
    return 0;
  }
}

// ── uncensoredEnsemble ────────────────────────────────────────────────────────

/**
 * Combine image and text explicit-content scores with OR logic. The image detector is
 * precision-high (~90%) and a text detector is recall-high (~73%); OR-ing them
 * reaches ~80%+ recall. Used to decide whether an item belongs to a user's
 * uncensored-content category — the category name is the caller's concern, not this
 * module's.
 *
 * @param imageScore  score from classifyUncensoredImage (0–1).
 * @param textScore   text detector score (0–1).
 * @param imgThr      image threshold (default 0.5).
 * @param textThr     text threshold (caller-supplied; explicit).
 */
export function uncensoredEnsemble(
  imageScore: number,
  textScore: number,
  imgThr: number = 0.5,
  textThr: number,
): boolean {
  return imageScore >= imgThr || textScore >= textThr;
}
