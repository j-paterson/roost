/**
 * Roost bookmark normalization — converts raw platform API objects into a uniform storage record.
 */
import type { Platform } from "@/types/sync";
import { getPlatform, PLATFORMS } from "@/platforms/registry";

/**
 * Raw API payload from Twitter, TikTok, or Farcaster.
 * Shape is platform-specific and cannot be statically typed — property
 * access is done via helper casts in the same file.
 */
export type RawApiData = Record<string, any>;

export interface NormalizedRecord {
  id: string;
  platform: string;
  itemId: string;
  rawData: RawApiData;
  saved_at: string;
  published_at: string | null;
  captured_via: string;
  castHash?: string;
}

export interface NormalizeOptions {
  savedAt?: string;
  capturedVia?: string;
}

export function roostUnwrapTweet(raw: RawApiData | null | undefined): RawApiData | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.__typename === "TweetWithVisibilityResults" && raw.tweet?.rest_id) return raw.tweet;
  if (raw.__typename === "Tweet" && raw.rest_id) return raw;
  if (raw.rest_id && raw.legacy) return raw;
  if (raw.tweet?.rest_id) return raw.tweet;
  if (raw.result) return roostUnwrapTweet(raw.result);
  return null;
}

export function roostParseTwitterDate(value: unknown): string | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return isNaN(ms) ? null : new Date(ms).toISOString();
}

export function roostParseEpoch(value: unknown): string | null {
  if (!value) return null;
  const n = Number(value);
  if (isNaN(n)) return null;
  return n > 1e12 ? new Date(n).toISOString()
    : n > 1e9 ? new Date(n * 1000).toISOString()
    : null;
}

export function roostTrimTikTok(item: RawApiData): RawApiData {
  return { ...item };
}

export function roostBookmarkId(platform: string, itemId: string): string {
  return `${platform}:${itemId}`;
}

export function roostNormalize(platform: string, item: RawApiData, options: NormalizeOptions = {}): NormalizedRecord | null {
  if (!item) return null;

  if (platform in PLATFORMS) {
    return getPlatform(platform as Platform).parse.normalize(item, options);
  }

  // Farcaster (default)
  const itemId: string | undefined = item.hash || item.castHash || item.cast_hash;
  if (!itemId) return null;
  return {
    id: roostBookmarkId("farcaster", itemId),
    platform: "farcaster", itemId,
    castHash: itemId,
    rawData: item,
    saved_at: options.savedAt || item.savedAt || item.saved_at || item.bookmarkedAt || item.timestamp || new Date().toISOString(),
    published_at: item.timestamp || item.publishedAt || item.published_at || null,
    captured_via: options.capturedVia || "sync",
  };
}
