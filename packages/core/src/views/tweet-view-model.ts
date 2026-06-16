/**
 * Structured view model for the native tweet reading layout (expanded card).
 *
 * Built from the stored raw record (`raw.json`, which keeps `_thread` /
 * `_quoted_thread`) using the same extraction primitives the writer used, so
 * the gallery can render a Twitter-like layout — header, real entity links,
 * quoted tweets as nested cards, reply-to context, and threads as a connected
 * vertical list — instead of the rasterized card.png.
 *
 * Pure (no vault I/O): photoUrls are filled in by the async loader that has the
 * attach folder + thread.json page mapping. Unit-testable from a plain object.
 */
import type { App } from "obsidian";
import { TFile } from "obsidian";
import {
  extractBookmarkText,
  extractBookmarkAuthorUsername,
  extractTwitterMedia,
  type BookmarkRecord,
} from "@/lib/extract";
import type { RawApiData } from "@/lib/normalize";

export interface TweetQuote {
  author: string | null;
  text: string;
}

export interface TweetSegmentView {
  /** @handle of the segment author (no leading @). */
  author: string | null;
  /** ISO timestamp, or null when the raw lacks created_at. */
  date: string | null;
  /** Clean tweet text (entities tokenized at render time, not markdown). */
  text: string;
  /** Resolved inline-photo resource paths (filled by the loader). */
  photoUrls: string[];
  /** External reply target (@handle) — only set when replying to *another*
   *  user, so self-thread replies don't show noise. */
  replyTo: string | null;
  /** Quoted tweet, when this segment quotes another post. */
  quoted: TweetQuote | null;
  /** True for the bookmarked (focal) tweet in a thread. */
  isFocal: boolean;
  /** rest_id — lets the loader map thread.json pages to this segment. */
  restId: string;
}

export interface TweetThreadView {
  segments: TweetSegmentView[];
  quotedThread: TweetSegmentView[];
}

interface RawThreadSegment {
  rest_id: string;
  raw: RawApiData;
}

function tweetText(raw: RawApiData, restId: string): string {
  const rec: BookmarkRecord = { platform: "twitter", itemId: restId, rawData: raw };
  return extractBookmarkText(rec);
}

function segmentFromRaw(raw: RawApiData, restId: string, isFocal: boolean): TweetSegmentView {
  const rec: BookmarkRecord = { platform: "twitter", itemId: restId, rawData: raw };
  const media = extractTwitterMedia(rec);
  const author = extractBookmarkAuthorUsername(rec) || null;
  const createdAt = raw?.legacy?.created_at;
  const date = createdAt ? new Date(createdAt).toISOString() : null;

  // Only surface a reply pill when replying to a *different* user (an actual
  // "responded to" context) — a self-thread reply to the same handle is noise.
  const replyTo =
    media.replyTo && media.replyTo.toLowerCase() !== (author ?? "").toLowerCase()
      ? media.replyTo
      : null;

  const quoted: TweetQuote | null = media.quotedTweet
    ? { author: media.quotedTweet.author, text: media.quotedTweet.text }
    : null;

  return {
    author,
    date,
    text: tweetText(raw, restId),
    photoUrls: [],
    replyTo,
    quoted,
    isFocal,
    restId,
  };
}

function buildSegments(raws: RawThreadSegment[], focalId: string | null): TweetSegmentView[] {
  const single = raws.length <= 1;
  return raws.map((s) =>
    segmentFromRaw(s.raw, s.rest_id, single || s.rest_id === focalId),
  );
}

/**
 * Build the structured thread view from a stored raw tweet record. Non-threaded
 * tweets yield a single focal segment; threaded tweets yield one segment per
 * `_thread` entry (plus any `_quoted_thread`). photoUrls start empty.
 */
export function buildTweetThreadView(rawData: RawApiData): TweetThreadView {
  const mainThread = (rawData._thread as RawThreadSegment[] | undefined) ?? [];
  const quotedThread = (rawData._quoted_thread as RawThreadSegment[] | undefined) ?? [];
  const focalId = typeof rawData.rest_id === "string" ? rawData.rest_id : null;

  const mainRaws: RawThreadSegment[] =
    mainThread.length > 0
      ? mainThread
      : [{ rest_id: focalId ?? "", raw: rawData }];

  return {
    segments: buildSegments(mainRaws, focalId),
    quotedThread: buildSegments(quotedThread, focalId),
  };
}

interface ThreadJsonSegment {
  rest_id?: string;
  pages?: number[];
}

/** Resolve a segment's thread.json `pages` to real downloaded jpg resource
 *  paths (png pages are rasterized text cards — skipped, their text is inline). */
function resolvePagePhotos(app: App, attachFolder: string, pages: number[] | undefined): string[] {
  if (!pages || !attachFolder) return [];
  const out: string[] = [];
  for (const n of pages) {
    const jpg = app.vault.getAbstractFileByPath(`${attachFolder}/${n}.jpg`);
    if (jpg instanceof TFile) out.push(app.vault.getResourcePath(jpg));
  }
  return out;
}

/**
 * Load + build the native tweet view for an attach folder: reads `raw.json`
 * (the full stored record) for structure and `thread.json` for the per-segment
 * downloaded-photo page mapping. Returns null when there's no raw.json to read
 * (caller falls back to the generic body-segment renderer). `fallbackAuthor` is
 * used when a segment's raw lacks an extractable handle.
 */
export async function loadTweetThreadView(
  app: App,
  attachFolder: string,
  fallbackAuthor: string | null,
): Promise<TweetThreadView | null> {
  if (!attachFolder) return null;
  const rawFile = app.vault.getAbstractFileByPath(`${attachFolder}/raw.json`);
  if (!(rawFile instanceof TFile)) return null;

  let rawData: RawApiData;
  try {
    rawData = JSON.parse(await app.vault.cachedRead(rawFile)) as RawApiData;
  } catch {
    return null;
  }

  const view = buildTweetThreadView(rawData);

  // Fill photoUrls from thread.json page mapping, keyed by rest_id.
  const threadFile = app.vault.getAbstractFileByPath(`${attachFolder}/thread.json`);
  const pagesById = new Map<string, number[]>();
  if (threadFile instanceof TFile) {
    try {
      const parsed = JSON.parse(await app.vault.cachedRead(threadFile)) as {
        segments?: ThreadJsonSegment[];
      };
      for (const s of parsed.segments ?? []) {
        if (s?.rest_id) pagesById.set(s.rest_id, s.pages ?? []);
      }
    } catch {
      // no page mapping — segments simply render text-only
    }
  }

  const fill = (seg: TweetSegmentView): void => {
    if (!seg.author && fallbackAuthor) seg.author = fallbackAuthor.replace(/^@/, "");
    seg.photoUrls = resolvePagePhotos(app, attachFolder, pagesById.get(seg.restId));
  };
  view.segments.forEach(fill);
  view.quotedThread.forEach(fill);

  return view;
}
