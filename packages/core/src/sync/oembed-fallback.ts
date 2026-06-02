/**
 * oEmbed fallback — fetch minimal metadata from TikTok's public oEmbed endpoint
 * when the full API data is unreachable (deleted/private videos, expired sessions).
 */
import { requestUrl } from "obsidian";

interface OembedData {
  title: string;
  author_name: string;
  author_url: string;
  html: string;
  thumbnail_url?: string;
}

/**
 * Fetch oEmbed data for a TikTok video URL.
 * Returns null if the video is unavailable or the request fails.
 */
export async function fetchTikTokOembed(videoUrl: string): Promise<OembedData | null> {
  try {
    const resp = await requestUrl({
      url: `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`,
    });
    const data = resp.json;
    if (!data || data.code || !data.title) return null;
    return data as OembedData;
  } catch {
    return null;
  }
}

/**
 * Extract sound info from oEmbed HTML (♬ title - author pattern in title attribute).
 */
function extractSoundFromOembed(html: string): { title: string; author: string } | null {
  const m = html.match(/title="\u266c\s*([^"]+)"/);
  if (!m) return null;
  const raw = m[1].trim();
  const dashIdx = raw.lastIndexOf(" - ");
  if (dashIdx === -1) return { title: raw, author: "" };
  return { title: raw.slice(0, dashIdx), author: raw.slice(dashIdx + 3) };
}

/** Shape of the minimal TikTok raw JSON sidecar produced from oEmbed data. */
interface OembedRawJson {
  _source: string;
  id: string;
  desc: string;
  author: { uniqueId: string; nickname: string };
  music: { title: string; authorName: string };
  stats: { playCount: number; diggCount: number; commentCount: number; shareCount: number; collectCount: number };
  _oembed?: { title: string; author_name: string; thumbnail_url?: string };
}

/**
 * Build a minimal raw.json object from oEmbed data + known fields.
 */
export function buildOembedRawJson(
  itemId: string,
  oembed: OembedData | null,
  existingFields?: { author?: string; title?: string },
): OembedRawJson {
  const raw: OembedRawJson = {
    _source: "oembed-fallback",
    id: itemId,
    desc: oembed?.title || existingFields?.title || "",
    author: {
      uniqueId: existingFields?.author || oembed?.author_name || "",
      nickname: oembed?.author_name || existingFields?.author || "",
    },
    music: { title: "", authorName: "" },
    stats: { playCount: 0, diggCount: 0, commentCount: 0, shareCount: 0, collectCount: 0 },
  };

  if (oembed) {
    const sound = extractSoundFromOembed(oembed.html || "");
    if (sound) {
      raw.music = { title: sound.title, authorName: sound.author };
    }
    raw._oembed = {
      title: oembed.title,
      author_name: oembed.author_name,
      thumbnail_url: oembed.thumbnail_url,
    };
  }

  return raw;
}
