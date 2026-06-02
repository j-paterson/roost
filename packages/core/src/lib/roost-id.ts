/**
 * Roost ID utilities — canonical functions for building and extracting roost_ids.
 */

/**
 * Extract a roost_id from a URL (e.g., TikTok video URL or X/Twitter status URL).
 * Returns null if the URL doesn't match a known platform pattern.
 */
export function roostIdFromUrl(url: string): string | null {
  if (url.includes("tiktok.com")) {
    const match = url.match(/video\/(\d+)/);
    return match ? `tiktok:${match[1]}` : null;
  }
  if (url.includes("x.com") || url.includes("twitter.com")) {
    const match = url.match(/status\/(\d+)/);
    return match ? `twitter:${match[1]}` : null;
  }
  return null;
}
