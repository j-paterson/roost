/**
 * Instagram extraction helpers — pure functions, no platform/registry deps.
 * Mirrors the shape of tiktok-helpers.ts. Field paths come from
 * docs/superpowers/specs/2026-06-30-instagram-saved-api-findings.md.
 */
import type { RawApiData } from "./normalize-helpers";
import type { BookmarkRecord } from "./twitter-helpers";

function getRaw(record: BookmarkRecord): RawApiData | null {
  return record?.rawData || record?.castData || null;
}

/** First image candidate URL for a media node (post or carousel child). */
function imageUrlOf(node: RawApiData | null | undefined): string | null {
  const c = node?.image_versions2?.candidates;
  return Array.isArray(c) && c[0]?.url ? c[0].url : null;
}

/** First video version URL for a media node. */
function videoUrlOf(node: RawApiData | null | undefined): string | null {
  const v = node?.video_versions;
  return Array.isArray(v) && v[0]?.url ? v[0].url : null;
}

export interface InstagramMediaResult {
  images: { url: string; index: number }[];
  videoUrl: string | null;
  coverUrl: string | null;
  mediaType: number | null;
  isCarousel: boolean;
  carousel: { type: number; url: string; coverUrl: string | null; index: number }[];
  collections: string[];
  stats: { likes: number; comments: number } | null;
}

export function extractInstagramMedia(record: BookmarkRecord): InstagramMediaResult {
  const raw = getRaw(record);
  const empty: InstagramMediaResult = {
    images: [], videoUrl: null, coverUrl: null, mediaType: null,
    isCarousel: false, carousel: [], collections: [], stats: null,
  };
  if (!raw) return empty;

  const mediaType: number | null = typeof raw.media_type === "number" ? raw.media_type : null;
  const collections: string[] = Array.isArray(raw._roost_collections) ? raw._roost_collections : [];
  const stats = (raw.like_count != null || raw.comment_count != null)
    ? { likes: raw.like_count || 0, comments: raw.comment_count || 0 }
    : null;

  if (mediaType === 8 && Array.isArray(raw.carousel_media)) {
    const carousel = raw.carousel_media
      .map((child: RawApiData, index: number) => {
        const t = typeof child.media_type === "number" ? child.media_type : 1;
        if (t === 2) {
          const url = videoUrlOf(child);
          return url ? { type: 2, url, coverUrl: imageUrlOf(child), index } : null;
        }
        const url = imageUrlOf(child);
        return url ? { type: 1, url, coverUrl: null, index } : null;
      })
      .filter(Boolean) as InstagramMediaResult["carousel"];
    return {
      ...empty,
      mediaType: 8,
      isCarousel: true,
      carousel,
      coverUrl: carousel[0]?.type === 1 ? carousel[0].url : (carousel[0]?.coverUrl ?? null),
      collections,
      stats,
    };
  }

  if (mediaType === 2) {
    return { ...empty, mediaType: 2, videoUrl: videoUrlOf(raw), coverUrl: imageUrlOf(raw), collections, stats };
  }

  // media_type 1 (image) or unknown → treat as single image
  const url = imageUrlOf(raw);
  return {
    ...empty,
    mediaType: mediaType ?? 1,
    images: url ? [{ url, index: 0 }] : [],
    coverUrl: url,
    collections,
    stats,
  };
}

export function buildInstagramUrl(code: string): string {
  return `https://www.instagram.com/p/${code}/`;
}
