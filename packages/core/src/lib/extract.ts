/**
 * Bookmark extraction helpers — delegates to platform descriptors for tiktok/twitter
 * (via getPlatform from the registry); keeps direct logic for farcaster.
 *
 * Twitter/TikTok pure helpers live in lib/twitter-helpers.ts and lib/tiktok-helpers.ts
 * to keep the import graph cycle-free (descriptors must not import back into this file).
 */
import type { RawApiData } from "./normalize";
import { getPlatform, PLATFORMS } from "@/platforms/registry";
import type { Platform } from "@/types/sync";

// Re-export types and helpers that live in the helper modules so existing
// callers of @/lib/extract continue to work without path changes.
export type { BookmarkRecord } from "./twitter-helpers";
export {
  getBookmarkRawData,
  getTwitterUserName,
  getTwitterUserScreenName,
  stripMediaUrls,
  getTweetMediaUrls,
  expandTweetUrls,
  extractTwitterMedia,
} from "./twitter-helpers";
export { extractTikTokMedia, extractTikTokSubtitleUrl } from "./tiktok-helpers";

import { getBookmarkRawData } from "./twitter-helpers";
import type { BookmarkRecord } from "./twitter-helpers";

export function getBookmarkPlatform(record: BookmarkRecord): string {
  if (record?.platform) return record.platform;
  const raw = getBookmarkRawData(record);
  if (raw?.video?.playAddr || raw?.author?.uniqueId) return "tiktok";
  if (raw?.rest_id || raw?.legacy?.id_str || raw?.legacy?.full_text || raw?.core?.user_results) return "twitter";
  return "farcaster";
}

export function getBookmarkItemId(record: BookmarkRecord): string | null {
  const platform = getBookmarkPlatform(record);
  if (platform in PLATFORMS) {
    const desc = getPlatform(platform as Platform);
    if (desc.parse) return desc.parse.id(record);
  }
  const raw = getBookmarkRawData(record);
  return record?.itemId || record?.castHash || raw?.hash || null;
}

export function getTweetAuthorId(tweet: RawApiData | null | undefined): string | null {
  if (!tweet) return null;
  return tweet?.core?.user_results?.result?.rest_id
    || tweet?.legacy?.user_id_str
    || null;
}

export function getConversationId(tweet: RawApiData | null | undefined): string | null {
  return tweet?.legacy?.conversation_id_str || null;
}

/**
 * True when the tweet is the tail (or any later segment) of a self-thread —
 * part of a conversation whose immediate parent is by the same author.
 */
export function isSelfThreadTail(tweet: RawApiData | null | undefined): boolean {
  if (!tweet) return false;
  const convId = getConversationId(tweet);
  const restId = tweet?.rest_id;
  if (!convId || !restId || convId === restId) return false;
  const inReplyToUserId = tweet?.legacy?.in_reply_to_user_id_str;
  const authorId = getTweetAuthorId(tweet);
  return !!(inReplyToUserId && authorId && inReplyToUserId === authorId);
}

export function extractBookmarkText(record: BookmarkRecord): string {
  const platform = getBookmarkPlatform(record);
  if (platform in PLATFORMS) {
    const desc = getPlatform(platform as Platform);
    if (desc.parse) return desc.parse.caption(record);
  }
  const raw = getBookmarkRawData(record);
  if (!raw) return "";
  return raw.text || raw.body?.text || "";
}

export function extractBookmarkAuthor(record: BookmarkRecord): string {
  const platform = getBookmarkPlatform(record);
  if (platform in PLATFORMS) {
    const desc = getPlatform(platform as Platform);
    if (desc.parse) return desc.parse.authorName(record);
  }
  return "Unknown";
}

export function extractBookmarkAuthorUsername(record: BookmarkRecord): string | null {
  const platform = getBookmarkPlatform(record);
  if (platform in PLATFORMS) {
    const desc = getPlatform(platform as Platform);
    if (desc.parse) return desc.parse.authorHandle(record);
  }
  return null;
}

/** Build a TikTok video URL from handle and item ID. */
export function buildTikTokVideoUrl(handle: string, itemId: string): string {
  return `https://www.tiktok.com/@${handle}/video/${itemId}`;
}

export function extractBookmarkUrl(record: BookmarkRecord): string | null {
  const platform = getBookmarkPlatform(record);
  if (platform in PLATFORMS) {
    const desc = getPlatform(platform as Platform);
    if (desc.parse) return desc.parse.url(record);
  }
  return null;
}

export function extractBookmarkPublishedAt(record: BookmarkRecord): string | null {
  if (record?.published_at) return record.published_at;
  return null;
}

/** Parse WebVTT subtitle content into a single plain-text string. */
export function parseWebVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(line => {
      const t = line.trim();
      if (!t) return false;
      if (t === "WEBVTT") return false;
      if (t.includes("-->")) return false;
      if (/^\d+$/.test(t)) return false;
      if (t.startsWith("NOTE") || t.startsWith("STYLE")) return false;
      return true;
    })
    .map(line => line.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .filter((line, i, arr) => i === 0 || line !== arr[i - 1])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect platform from a URL and optional tags (for Eagle imports).
 */
export function detectPlatformFromUrl(url: string, tags?: string[]): string {
  if (url.includes("tiktok.com") || tags?.includes("tiktok")) return "tiktok";
  if (url.includes("x.com") || url.includes("twitter.com") || tags?.includes("twitter")) return "twitter";
  if (url.includes("instagram.com") || tags?.includes("instagram")) return "instagram";
  if (url.includes("reddit.com") || url.includes("redd.it") || tags?.includes("reddit")) return "reddit";
  return "other";
}

/** Pluck a Spotify track ID out of TikTok's raw.json. TikTok exposes
 *  the mapping under `music.tt2dsp.tt_to_dsp_song_infos[]` whenever the
 *  creator picked their sound from a DSP. `platform: 3` = Spotify.
 *  Returns null when no DSP-mapped sound is present. */
export function extractSpotifyTrackIdFromTikTok(raw: unknown): string | null {
  const r = raw as { music?: { tt2dsp?: { tt_to_dsp_song_infos?: Array<{ platform?: number; song_id?: string }> } } } | null;
  const songs = r?.music?.tt2dsp?.tt_to_dsp_song_infos;
  if (!Array.isArray(songs)) return null;
  for (const s of songs) {
    if (s?.platform === 3 && typeof s?.song_id === "string" && s.song_id) {
      return s.song_id;
    }
  }
  return null;
}

export function sanitizeFilename(value: string): string {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f#^[\]]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 200) || "untitled";
}
