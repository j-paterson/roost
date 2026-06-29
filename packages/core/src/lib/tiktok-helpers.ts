/**
 * TikTok extraction helpers — pure functions, no platform deps.
 *
 * Moved here from lib/extract.ts to break the extract.ts → registry → tiktok.ts → extract.ts
 * circular import. All functions are self-contained with only normalize.ts dependencies.
 */
import type { RawApiData } from "./normalize";
import type { BookmarkRecord } from "./twitter-helpers";

function getBookmarkRawData(record: BookmarkRecord): RawApiData | null {
  return record?.rawData || record?.castData || null;
}

// TikTok-specific: extract images, video, sound, stats
export function extractTikTokMedia(record: BookmarkRecord): {
  images: { url: string; index: number }[];
  videoUrl: string | null;
  coverUrl: string | null;
  sound: { title: string; author: string } | null;
  stats: { plays: number; likes: number; comments: number; shares: number; saves: number } | null;
  hashtags: string[];
  collection: string | null;
} {
  const raw = getBookmarkRawData(record);

  // Photo carousel
  const images: { url: string; index: number }[] = [];
  if (raw?.imagePost?.images?.length) {
    for (let i = 0; i < raw.imagePost.images.length; i++) {
      const img = raw.imagePost.images[i];
      const url = typeof img.imageURL === "string" ? img.imageURL : img.imageURL?.urlList?.[0] || img.imageURL?.url;
      if (url) images.push({ url, index: i });
    }
  }

  // Video
  const videoUrl = raw?.video?.playAddr || raw?.video?.downloadAddr || null;
  const coverUrl = raw?.video?.originCover || raw?.video?.cover || null;

  // Sound
  const sound = raw?.music ? { title: raw.music.title || "", author: raw.music.authorName || "" } : null;

  // Stats
  const s = raw?.stats;
  const stats = s ? {
    plays: s.playCount || 0,
    likes: s.diggCount || 0,
    comments: s.commentCount || 0,
    shares: s.shareCount || 0,
    saves: s.collectCount || 0,
  } : null;

  // Hashtags from challenges
  const hashtags = (raw?.challenges || []).map((c: RawApiData) => c.title).filter(Boolean);

  // Collection
  const collection = raw?._collection || null;

  return { images, videoUrl, coverUrl, sound, stats, hashtags, collection };
}

// TikTok subtitle extraction — pick the best subtitle track URL
export function extractTikTokSubtitleUrl(record: BookmarkRecord): string | null {
  const raw = getBookmarkRawData(record);
  const infos = raw?.video?.subtitleInfos;
  if (!Array.isArray(infos) || infos.length === 0) return null;

  type SubtitleInfo = { Url?: string; url?: string; Source?: string; source?: string; LanguageCodeName?: string; languageCodeName?: string };
  // Prefer: creator-provided > ASR > MT, English > other
  const scored = (infos as SubtitleInfo[])
    .filter(s => s.Url || s.url)
    .map(s => {
      const source = (s.Source || s.source || "").toLowerCase();
      const lang = (s.LanguageCodeName || s.languageCodeName || "").toLowerCase();
      return {
        url: s.Url || s.url,
        score: (source === "creator" ? 4 : source === "asr" ? 2 : 0)
             + (lang.startsWith("eng") ? 1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.url || null;
}
