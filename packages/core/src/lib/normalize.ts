/**
 * Roost bookmark normalization — converts raw platform API objects into a uniform storage record.
 */
import type { Platform } from "@/types/sync";
import { getPlatform, PLATFORMS } from "@/platforms/registry";
import {
  roostBookmarkId,
  type RawApiData,
  type NormalizeOptions,
  type NormalizedRecord,
} from "@/lib/normalize-helpers";

// Re-export types so existing importers of @/lib/normalize don't need to change.
export type { RawApiData, NormalizedRecord, NormalizeOptions } from "@/lib/normalize-helpers";

export function roostNormalize(platform: string, item: RawApiData, options: NormalizeOptions = {}): NormalizedRecord | null {
  if (!item) return null;

  if (platform in PLATFORMS) {
    const desc = getPlatform(platform as Platform);
    if (desc.parse) return desc.parse.normalize(item, options);
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
