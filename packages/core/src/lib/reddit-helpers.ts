/** Reddit extraction helpers — pure, no platform/registry deps. Field map from
 *  docs/superpowers/specs/2026-06-30-reddit-saved-sync-design.md §4. */
import type { RawApiData } from "./normalize-helpers";
import type { BookmarkRecord } from "./twitter-helpers";
import type { LinkCard } from "@/lib/link-card";
import { domainFromUrl } from "@/lib/link-card";

function getRaw(record: BookmarkRecord): RawApiData | null {
  return record?.rawData || record?.castData || null;
}

/** preview.redd.it (signed, expiring) → permanent i.redd.it (query stripped). */
export function redditPreviewToPermanent(url: string): string {
  if (!url) return url;
  return url.split("?")[0].replace("/preview.", "/i.");
}

export function buildRedditUrl(permalink: string): string {
  if (!permalink) return "";
  return permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
}

function extOf(url: string): string {
  const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

export interface RedditMediaResult {
  kind: "text" | "image" | "gallery" | "video" | "link";
  images: { url: string; index: number; ext: string }[];
  videoUrl: string | null;   // fallback_url, query stripped
  dashUrl: string | null;    // DASHPlaylist.mpd
  videoId: string | null;
  hasAudio: boolean;
  isGif: boolean;
  coverUrl: string | null;   // permanent poster
  linkUrl: string | null;    // external link / non-media url
  selftext: string;
}

function empty(): RedditMediaResult {
  return { kind: "link", images: [], videoUrl: null, dashUrl: null, videoId: null, hasAudio: false, isGif: false, coverUrl: null, linkUrl: null, selftext: "" };
}

function posterFrom(raw: RawApiData): string | null {
  const u = raw?.preview?.images?.[0]?.source?.url;
  return typeof u === "string" ? redditPreviewToPermanent(u) : null;
}

export function extractRedditMedia(record: BookmarkRecord): RedditMediaResult {
  const rawInit = getRaw(record);
  if (!rawInit) return empty();

  // Crosspost: media lives on the parent (a full t3). Guard empty array.
  const raw: RawApiData = ("crosspost_parent" in rawInit && Array.isArray(rawInit.crosspost_parent_list) && rawInit.crosspost_parent_list.length > 0)
    ? (rawInit.crosspost_parent_list[0] as RawApiData)
    : rawInit;

  const out = empty();
  out.linkUrl = (raw.url_overridden_by_dest as string) || (raw.url as string) || null;
  out.selftext = typeof raw.selftext === "string" ? raw.selftext : "";
  out.coverUrl = posterFrom(raw);

  // Video (v.redd.it)
  if (raw.is_video) {
    const rv = raw.secure_media?.reddit_video || raw.media?.reddit_video || null;
    if (rv?.fallback_url) {
      out.kind = "video";
      out.videoUrl = String(rv.fallback_url).split("?")[0];
      out.dashUrl = rv.dash_url ? String(rv.dash_url) : null;
      out.hasAudio = rv.has_audio !== false; // default true unless explicitly false
      out.isGif = rv.is_gif === true;
      const m = String(rv.fallback_url).match(/v\.redd\.it\/([^/?]+)/);
      out.videoId = m ? m[1] : null;
      return out;
    }
  }

  // Gallery
  if (raw.is_gallery && raw.media_metadata && raw.gallery_data?.items) {
    out.kind = "gallery";
    const items = [...raw.gallery_data.items].sort((a: RawApiData, b: RawApiData) => (a.id ?? 0) - (b.id ?? 0));
    let idx = 0;
    for (const it of items) {
      const meta = raw.media_metadata[it.media_id];
      if (!meta || meta.status !== "valid") continue;
      const s = meta.s || {};
      const u = s.u || s.gif || s.mp4;
      if (!u) continue;
      const perm = redditPreviewToPermanent(String(u));
      out.images.push({ url: perm, index: idx, ext: extOf(perm) });
      idx++;
    }
    return out;
  }

  // Single image
  if (raw.post_hint === "image" && out.linkUrl) {
    out.kind = "image";
    out.images.push({ url: redditPreviewToPermanent(out.linkUrl), index: 0, ext: extOf(out.linkUrl) });
    return out;
  }

  // Self/text
  if (raw.is_self) { out.kind = "text"; return out; }

  // Link / rich:video / everything else
  out.kind = "link";
  return out;
}

/** External-link preview for a Reddit LINK post. Returns null unless
 *  extractRedditMedia classified the post as kind "link" with a real URL.
 *  Title is provisional (the Reddit post title); description is left empty
 *  for the OG backfill. The image is Reddit's own preview (permanent-ized). */
export function extractRedditLink(record: BookmarkRecord): LinkCard | null {
  const media = extractRedditMedia(record);
  if (media.kind !== "link" || !media.linkUrl) return null;
  const raw = getRaw(record);
  const title = typeof raw?.title === "string" ? raw.title.replace(/\n/g, " ") : undefined;
  const siteName = domainFromUrl(media.linkUrl) ?? undefined;
  return {
    url: media.linkUrl,
    title: title || undefined,
    siteName,
    image: media.coverUrl ?? undefined,
  };
}
