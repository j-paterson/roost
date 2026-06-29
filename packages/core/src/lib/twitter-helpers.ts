/**
 * Twitter/X extraction helpers — pure functions, no platform deps.
 *
 * Moved here from lib/extract.ts to break the extract.ts → registry → twitter.ts → extract.ts
 * circular import. All functions are self-contained with no platform registry dependencies.
 */
import { roostUnwrapTweet, type RawApiData } from "./normalize";
import {
  extractArticleContent,
  renderArticleNoteBody,
  renderArticleStubBody,
  type ArticleResultRaw,
} from "./article-extract";

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

export function getBookmarkRawData(record: BookmarkRecord): RawApiData | null {
  return record?.rawData || record?.castData || null;
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
      const qtMedia = qt?.legacy?.extended_entities?.media || qt?.legacy?.entities?.media || [];
      let photoUrl: string | null = null;
      for (const m of qtMedia) {
        if (m.type === "photo" && m.media_url_https) {
          photoUrl = `${m.media_url_https}?format=jpg&name=small`;
          break;
        }
      }
      // Replicate twitter.parse.caption for the quoted tweet (articles + plain text).
      const qtArticleResult: ArticleResultRaw | null =
        (qt as { article?: { article_results?: { result?: ArticleResultRaw } } })
          .article?.article_results?.result ??
        (qt as { quoted_status_result?: { result?: { article?: { article_results?: { result?: ArticleResultRaw } } } } })
          .quoted_status_result?.result?.article?.article_results?.result ??
        null;
      let qtText: string;
      if (qtArticleResult) {
        const parsed = extractArticleContent(qtArticleResult);
        qtText = parsed ? renderArticleNoteBody(parsed) : renderArticleStubBody(qtArticleResult);
      } else {
        qtText = expandTweetUrls(roostUnwrapTweet(qt));
      }
      quotedTweet = {
        author: getTwitterUserScreenName(qt) || "unknown",
        text: qtText,
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
