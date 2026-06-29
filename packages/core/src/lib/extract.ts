/**
 * Bookmark extraction helpers — pure functions, no platform deps.
 */
import { roostUnwrapTweet, type RawApiData } from "./normalize";
import { getPlatform } from "@/platforms/registry";
import type { Platform } from "@/types/sync";

/**
 * Minimum shape needed by extract helpers — a superset of NormalizedRecord
 * to also handle ad-hoc partial objects (e.g. { platform, itemId, rawData }).
 */
export type BookmarkRecord = {
  platform?: string;
  rawData?: RawApiData;
  // Farcaster only — legacy field name
  castData?: RawApiData;
  itemId?: string;
  castHash?: string;
  published_at?: string | null;
};

function getBookmarkRawData(record: BookmarkRecord): RawApiData | null {
  return record?.rawData || record?.castData || null;
}

export function getBookmarkPlatform(record: BookmarkRecord): string {
  if (record?.platform) return record.platform;
  const raw = getBookmarkRawData(record);
  if (raw?.video?.playAddr || raw?.author?.uniqueId) return "tiktok";
  if (raw?.rest_id || raw?.legacy?.id_str || raw?.legacy?.full_text || raw?.core?.user_results) return "twitter";
  return "farcaster";
}

export function getBookmarkItemId(record: BookmarkRecord): string | null {
  const platform = getBookmarkPlatform(record);
  if (platform === "tiktok" || platform === "twitter") {
    return getPlatform(platform as Platform).parse.id(record);
  }
  const raw = getBookmarkRawData(record);
  return record?.itemId || record?.castHash || raw?.hash || null;
}

function getTwitterUser(raw: RawApiData): RawApiData | null {
  const tweet = roostUnwrapTweet(raw) || raw;
  return tweet?.core?.user_results?.result || null;
}

function getTwitterUserLegacy(raw: RawApiData): RawApiData | null { return getTwitterUser(raw)?.legacy || null; }

/** X migrated `name` and `screen_name` from `user.legacy` to `user.core` in
 *  early 2026. Prefer the new path; fall back to the old one for raw.json
 *  files captured before the migration. */
function getTwitterUserCore(raw: RawApiData): RawApiData | null {
  return getTwitterUser(raw)?.core || null;
}

export function getTwitterUserName(raw: RawApiData): string | null {
  return getTwitterUserCore(raw)?.name || getTwitterUserLegacy(raw)?.name || null;
}

export function getTwitterUserScreenName(raw: RawApiData): string | null {
  return (
    getTwitterUserCore(raw)?.screen_name ||
    getTwitterUserLegacy(raw)?.screen_name ||
    null
  );
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

/**
 * Strip Twitter media t.co URLs from tweet text. Twitter auto-appends a
 * t.co short URL for each attached image/video to the end of the tweet
 * body — those links don't add any signal and clutter both the gallery
 * caption and any downstream LLM prompts.
 *
 * Uses the entities.media + extended_entities.media arrays as the source
 * of truth so we only strip URLs Twitter confirms point at media (not
 * arbitrary t.co links the author typed). Strips trailing-only by default
 * to match how Twitter places them.
 */
export function stripMediaUrls(text: string, mediaUrls: string[]): string {
  if (!text || mediaUrls.length === 0) return text;
  let out = text;
  for (const url of mediaUrls) {
    if (!url) continue;
    // Strip with optional leading whitespace/newline. Apply globally so a
    // tweet with multiple media items (each producing the SAME t.co URL,
    // as Twitter actually does for galleries) gets all instances removed.
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\s*${escaped}\\b`, "g"), "");
  }
  return out.trimEnd();
}

/** Pull the set of media t.co URLs from a tweet's entities. Returns the
 *  same string multiple times if Twitter listed the URL once per media
 *  item (gallery posts) — stripMediaUrls handles dedup via global regex. */
export function getTweetMediaUrls(tweet: RawApiData | null): string[] {
  if (!tweet) return [];
  const urls: string[] = [];
  const legacy = tweet.legacy;
  for (const m of (legacy?.entities?.media || [])) {
    if (m?.url) urls.push(m.url);
  }
  for (const m of (legacy?.extended_entities?.media || [])) {
    if (m?.url) urls.push(m.url);
  }
  return urls;
}

export function expandTweetUrls(tweet: RawApiData | null): string {
  let text = tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text || "";
  for (const u of (tweet?.legacy?.entities?.urls || [])) {
    if (u.url && u.expanded_url) text = text.replace(u.url, u.expanded_url);
  }
  // Strip the trailing media t.co URL Twitter auto-appends (if any).
  text = stripMediaUrls(text, getTweetMediaUrls(tweet));
  return text;
}

export function extractBookmarkText(record: BookmarkRecord): string {
  const platform = getBookmarkPlatform(record);
  if (platform === "tiktok" || platform === "twitter") {
    return getPlatform(platform as Platform).parse.caption(record);
  }
  const raw = getBookmarkRawData(record);
  if (!raw) return "";
  return raw.text || raw.body?.text || "";
}

export function extractBookmarkAuthor(record: BookmarkRecord): string {
  const platform = getBookmarkPlatform(record);
  if (platform === "tiktok" || platform === "twitter") {
    return getPlatform(platform as Platform).parse.authorName(record);
  }
  return "Unknown";
}

export function extractBookmarkAuthorUsername(record: BookmarkRecord): string | null {
  const platform = getBookmarkPlatform(record);
  if (platform === "tiktok" || platform === "twitter") {
    return getPlatform(platform as Platform).parse.authorHandle(record);
  }
  return null;
}

/** Build a TikTok video URL from handle and item ID. */
export function buildTikTokVideoUrl(handle: string, itemId: string): string {
  return `https://www.tiktok.com/@${handle}/video/${itemId}`;
}

export function extractBookmarkUrl(record: BookmarkRecord): string | null {
  const platform = getBookmarkPlatform(record);
  if (platform === "tiktok" || platform === "twitter") {
    return getPlatform(platform as Platform).parse.url(record);
  }
  return null;
}

export function extractBookmarkPublishedAt(record: BookmarkRecord): string | null {
  if (record?.published_at) return record.published_at;
  return null;
}

// Twitter-specific: extract photos, video, card, quote
export function extractTwitterMedia(record: BookmarkRecord): {
  photos: { url: string; index: number }[];
  videoUrl: string | null;
  videoPosterUrl: string | null;
  cardMeta: { title: string | null; description: string | null; thumbnail: string | null } | null;
  quotedTweet: { author: string; text: string; photoUrl: string | null } | null;
  replyTo: string | null;
  folder: string | null;
} {
  const raw = getBookmarkRawData(record);
  const tweet = roostUnwrapTweet(raw) || raw;
  const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];

  // Photos
  const photos: { url: string; index: number }[] = [];
  for (let i = 0; i < media.length; i++) {
    if (media[i].type === "photo" && media[i].media_url_https) {
      photos.push({ url: `${media[i].media_url_https}?format=jpg&name=large`, index: i });
    }
  }

  // Video (+ poster JPG from the same media entry). The gallery renders cover
  // via <img>, so pointing cover at video.mp4 produces a broken-image icon —
  // we need a real image poster to sit behind the scrub-video overlay.
  let videoUrl: string | null = null;
  let videoPosterUrl: string | null = null;
  for (const m of media) {
    if ((m.type === "video" || m.type === "animated_gif") && m.video_info?.variants) {
      type VideoVariant = { content_type?: string; url?: string; bitrate?: number };
      const mp4s = (m.video_info.variants as VideoVariant[])
        .filter(v => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      videoUrl = (mp4s[1] || mp4s[0])?.url || null;
      if (typeof m.media_url_https === "string") {
        videoPosterUrl = `${m.media_url_https}?format=jpg&name=large`;
      }
      break;
    }
  }

  // Card metadata
  let cardMeta: { title: string | null; description: string | null; thumbnail: string | null } | null = null;
  const card = tweet?.card?.legacy || tweet?.card || tweet?.card_results?.result?.legacy || tweet?.card_results?.result || null;
  if (card?.binding_values) {
    type BindingEntry = { key: string; value: RawApiData };
    const vals: BindingEntry[] = Array.isArray(card.binding_values)
      ? (card.binding_values as BindingEntry[])
      : Object.entries(card.binding_values as Record<string, RawApiData>).map(([key, value]) => ({ key, value }));
    const get = (k: string) => { const e = vals.find(v => v.key === k); return e?.value?.string_value || null; };
    const getImage = (k: string) => { const e = vals.find(v => v.key === k); return e?.value?.image_value?.url || null; };
    const title = get("title"), description = get("description");
    const thumbnail = getImage("thumbnail_image_original") || getImage("thumbnail_image") || getImage("summary_photo_image_original");
    if (title || description) cardMeta = { title, description, thumbnail };
  }

  // Quoted tweet (author + text + first-photo URL when the quoted post has media)
  let quotedTweet: { author: string; text: string; photoUrl: string | null } | null = null;
  const quoted = tweet?.quoted_status_result?.result || tweet?.quotedRefResult?.result || null;
  if (quoted) {
    const qt = roostUnwrapTweet(quoted);
    if (qt?.rest_id) {
      const qtRec = { platform: "twitter", itemId: qt.rest_id, rawData: qt };
      const qtMedia = qt?.legacy?.extended_entities?.media || qt?.legacy?.entities?.media || [];
      let photoUrl: string | null = null;
      for (const m of qtMedia) {
        if (m.type === "photo" && m.media_url_https) {
          photoUrl = `${m.media_url_https}?format=jpg&name=small`;
          break;
        }
      }
      quotedTweet = {
        author: extractBookmarkAuthorUsername(qtRec) || "unknown",
        text: extractBookmarkText(qtRec),
        photoUrl,
      };
    }
  }

  // Reply
  const replyTo = tweet?.legacy?.in_reply_to_screen_name || null;

  // Bookmark folder (set by Twitter probe when bookmark belongs to a folder)
  const folder = (typeof raw?._bookmark_folder === "string" && raw._bookmark_folder) ? raw._bookmark_folder : null;

  return { photos, videoUrl, videoPosterUrl, cardMeta, quotedTweet, replyTo, folder };
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
