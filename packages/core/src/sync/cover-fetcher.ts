/**
 * Auto-fetch cover images for vault entries.
 * Uses free APIs to find covers based on content type:
 *   - Anime: Jikan (MyAnimeList API)
 *   - Film/TV: OMDB API
 *   - Podcast: iTunes Search API
 *   - URL notes: Open Graph image extraction
 */
import { App, TFile, requestUrl } from "obsidian";
import { getNoteAuthor, getNoteTitle, safeGetValue } from "@/lib/bases-entry";
import { hasValue } from "@/views/content-detector";
import type { BasesEntry } from "obsidian";
import { domainFromUrl } from "@/lib/link-card";

const COVERS_FOLDER = "assets/covers";

interface FetchResult {
  fetched: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/** Check if an entry already has a cover image */
function hasCover(entry: BasesEntry): boolean {
  return hasValue(safeGetValue(entry, "note.cover"));
}

/** Get the entry's media type from frontmatter */
function getType(entry: BasesEntry): string | null {
  const raw = safeGetValue(entry, "note.type");
  return hasValue(raw) ? String(raw) : null;
}

/** Get the entry's title */
function getTitle(entry: BasesEntry): string {
  return getNoteTitle(entry);
}

/** Get author from frontmatter */
function getAuthor(entry: BasesEntry): string | null {
  return getNoteAuthor(entry);
}

/** Get URL from frontmatter */
function getUrl(entry: BasesEntry): string | null {
  const raw = safeGetValue(entry, "note.url");
  if (!hasValue(raw)) return null;
  const str = String(raw);
  // Handle doubled URLs from Notion import
  const first = str.split(",")[0].trim();
  return first.startsWith("http") ? first : null;
}

// ─── API fetchers ─────────────────────────────────────────────

async function fetchAnimeCover(title: string): Promise<string | null> {
  try {
    const resp = await requestUrl({
      url: `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`,
    });
    const data = resp.json;
    return data?.data?.[0]?.images?.jpg?.large_image_url ?? null;
  } catch { return null; }
}

async function fetchOmdbCover(title: string, apiKey: string): Promise<string | null> {
  try {
    const resp = await requestUrl({
      url: `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(apiKey)}`,
    });
    const data = resp.json;
    return (data?.Poster && data.Poster !== "N/A") ? data.Poster : null;
  } catch { return null; }
}

async function fetchPodcastCover(title: string): Promise<string | null> {
  try {
    const resp = await requestUrl({
      url: `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=podcast&limit=1`,
    });
    const data = resp.json;
    return data?.results?.[0]?.artworkUrl600 ?? null;
  } catch { return null; }
}

async function fetchBookCover(title: string, author: string | null): Promise<string | null> {
  try {
    let url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1&fields=cover_i`;
    if (author) {
      url += `&author=${encodeURIComponent(author)}`;
    }
    const resp = await requestUrl({ url });
    const data = resp.json;
    const coverId = data?.docs?.[0]?.cover_i;
    if (coverId) {
      return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    }
    return null;
  } catch { return null; }
}

function metaContent(html: string, key: string): string | null {
  const m = html.match(new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`, "i"))
    || html.match(new RegExp(`<meta\\s+content="([^"]*)"\\s+(?:property|name)="${key}"`, "i"));
  return m ? m[1] : null;
}

export interface OgMetadata { title: string | null; description: string | null; image: string | null; siteName: string | null; }

/** Fetch a URL and parse Open Graph + fallbacks. Never throws — returns
 *  all-null on any failure (dead link, non-200, no tags). */
export async function fetchOgMetadata(url: string): Promise<OgMetadata> {
  try {
    const resp = await requestUrl({ url, headers: { "User-Agent": "ObsidianCoverFetcher/1.0" } });
    if (resp.status < 200 || resp.status >= 300) return { title: null, description: null, image: null, siteName: null };
    const html = resp.text;
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    const rawImage = metaContent(html, "og:image");
    return {
      title: metaContent(html, "og:title") || titleTag,
      description: metaContent(html, "og:description"),
      image: rawImage?.startsWith("//") ? "https:" + rawImage : (rawImage ?? null),
      siteName: metaContent(html, "og:site_name") || domainFromUrl(url),
    };
  } catch {
    return { title: null, description: null, image: null, siteName: null };
  }
}

async function fetchOgImage(url: string): Promise<string | null> {
  return (await fetchOgMetadata(url)).image;
}

// ─── Cover resolution ─────────────────────────────────────────

const OMDB_TYPES = new Set(["Film", "TV Series", "Series"]);

async function resolveCoverUrl(
  entry: BasesEntry,
  type: string | null,
  title: string,
  omdbApiKey?: string,
): Promise<string | null> {
  if (type === "anime") {
    return fetchAnimeCover(title);
  }
  if (type && OMDB_TYPES.has(type)) {
    if (!omdbApiKey) return null;
    return fetchOmdbCover(title, omdbApiKey);
  }
  if (type === "Podcast") {
    return fetchPodcastCover(title);
  }

  // Books — look up by title + author via Open Library
  const author = getAuthor(entry);
  if (author || isLikelyBook(entry, type)) {
    const cover = await fetchBookCover(title, author);
    if (cover) return cover;
  }

  // URL-bearing notes — try OG image
  const url = getUrl(entry);
  if (url) {
    return fetchOgImage(url);
  }

  return null;
}

/** Heuristic: does this look like a book entry? */
function isLikelyBook(entry: BasesEntry, type: string | null): boolean {
  if (type === "book" || type === "Book") return true;
  if (entry.file.path.includes("Library") && getAuthor(entry)) return true;
  return false;
}

/** Whether cover fetch can run for this entry (mirrors resolveCoverUrl eligibility) */
export function canFetchCover(entry: BasesEntry, omdbApiKey?: string): boolean {
  if (hasCover(entry)) return false;
  const type = getType(entry);
  if (type === "anime" || type === "Podcast") return true;
  if (type && OMDB_TYPES.has(type)) return !!omdbApiKey;
  if (isLikelyBook(entry, type)) return true;
  return getUrl(entry) != null;
}

export interface FetchCoversOptions {
  omdbApiKey?: string;
}

// ─── Main fetch function ──────────────────────────────────────

export async function fetchCoversForEntries(
  app: App,
  entries: BasesEntry[],
  onProgress?: (current: number, total: number, title: string) => void,
  options?: FetchCoversOptions,
): Promise<FetchResult> {
  const result: FetchResult = { fetched: 0, skipped: 0, failed: 0, errors: [] };
  const omdbApiKey = options?.omdbApiKey?.trim() || undefined;

  const needsCover = entries.filter(e => canFetchCover(e, omdbApiKey));

  if (needsCover.length === 0) return result;

  // Ensure covers folder exists
  const folder = app.vault.getAbstractFileByPath(COVERS_FOLDER);
  if (!folder) {
    await app.vault.createFolder(COVERS_FOLDER);
  }

  for (let i = 0; i < needsCover.length; i++) {
    const entry = needsCover[i];
    const title = getTitle(entry);
    const type = getType(entry);
    const slug = slugify(title);

    onProgress?.(i + 1, needsCover.length, title);

    // Check if cover file already exists
    const coverFilename = `${slug}.jpg`;
    const coverPath = `${COVERS_FOLDER}/${coverFilename}`;
    const existing = app.vault.getAbstractFileByPath(coverPath);

    if (existing) {
      // Cover exists but frontmatter not set — just update frontmatter
      await setCoverProperty(app, entry.file, coverPath);
      result.fetched++;
      continue;
    }

    // Fetch cover URL
    try {
      const coverUrl = await resolveCoverUrl(entry, type, title, omdbApiKey);
      if (!coverUrl) {
        result.failed++;
        continue;
      }

      const imgResp = await requestUrl({ url: coverUrl });
      await app.vault.createBinary(coverPath, imgResp.arrayBuffer);

      await setCoverProperty(app, entry.file, coverPath);
      result.fetched++;
    } catch (e: unknown) {
      result.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${title}: ${msg}`);
    }

    // Rate limiting
    if (type === "anime") {
      await sleep(500); // Jikan: 3 req/sec
    } else {
      await sleep(300);
    }
  }

  return result;
}

async function setCoverProperty(app: App, file: TFile, coverPath: string) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (!fm.cover) {
      fm.cover = `[[${coverPath}]]`;
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { hasCover, getType, getTitle, getUrl, COVERS_FOLDER };
