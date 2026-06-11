/**
 * Roost bookmark normalization — converts raw platform API objects into a uniform storage record.
 */

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

interface NormalizeOptions {
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

function roostParseTwitterDate(value: unknown): string | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return isNaN(ms) ? null : new Date(ms).toISOString();
}

function roostParseEpoch(value: unknown): string | null {
  if (!value) return null;
  const n = Number(value);
  if (isNaN(n)) return null;
  return n > 1e12 ? new Date(n).toISOString()
    : n > 1e9 ? new Date(n * 1000).toISOString()
    : null;
}

function roostTrimTikTok(item: RawApiData): RawApiData {
  return { ...item };
}

function roostBookmarkId(platform: string, itemId: string): string {
  return `${platform}:${itemId}`;
}

export function roostNormalize(platform: string, item: RawApiData, options: NormalizeOptions = {}): NormalizedRecord | null {
  if (!item) return null;

  if (platform === "twitter") {
    const tweet = roostUnwrapTweet(item);
    const itemId: string | undefined = tweet?.rest_id || item?.rest_id || item?.legacy?.id_str;
    if (!itemId) return null;
    const published = roostParseTwitterDate(tweet?.legacy?.created_at);
    return {
      id: roostBookmarkId("twitter", itemId),
      platform: "twitter", itemId,
      rawData: tweet || item,
      saved_at: options.savedAt || published || new Date().toISOString(),
      published_at: published,
      captured_via: options.capturedVia || "sync",
    };
  }

  if (platform === "tiktok") {
    const itemId: string | undefined = item.id || item.video?.id;
    if (!itemId) return null;
    const published = roostParseEpoch(item.createTime);
    return {
      id: roostBookmarkId("tiktok", itemId),
      platform: "tiktok", itemId,
      rawData: roostTrimTikTok(item),
      saved_at: options.savedAt || published || new Date().toISOString(),
      published_at: published,
      captured_via: options.capturedVia || "sync",
    };
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
