/**
 * TMDB search resolver for Films, Series, Documentaries. Maps a subcategory
 * to /search/movie vs /search/tv, optionally filters by year, returns the
 * canonical TMDB id.
 *
 * Letterboxd accepts /film/tmdb:{id}/ and /tv/tmdb:{id}/ as redirect URLs,
 * so the TMDB id is all we need to construct the destination.
 */
import { fetchWithRetry, HttpError } from "./resolver-utils";

export interface TmdbResolveInput {
  title: string;
  /** Optional year to disambiguate. */
  year: number | null;
  /** Case-insensitive: "Films" | "Series" | "Documentaries". Anything
   *  else returns null. */
  subcategory: string;
}

export interface TmdbResolveResult {
  tmdbId: string | null;
  tmdbType: "movie" | "tv" | null;
  /** Set on permanent errors (401, malformed response). Transient errors
   *  (5xx, network) propagate as thrown exceptions for the caller to handle. */
  error?: string;
}

interface TmdbSearchResult {
  id: number;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
}

function endpoint(subcategory: string): "movie" | "tv" | null {
  const sub = subcategory.toLowerCase();
  if (sub === "films" || sub === "documentaries") return "movie";
  if (sub === "series") return "tv";
  return null;
}

function yearOf(result: TmdbSearchResult, kind: "movie" | "tv"): number | null {
  const dateStr = kind === "movie" ? result.release_date : result.first_air_date;
  if (!dateStr) return null;
  const parsed = parseInt(dateStr.slice(0, 4), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function resolveTmdb(
  input: TmdbResolveInput,
  apiKey: string,
): Promise<TmdbResolveResult> {
  if (!apiKey) {
    return { tmdbId: null, tmdbType: null };
  }

  const kind = endpoint(input.subcategory);
  if (!kind) {
    return { tmdbId: null, tmdbType: null };
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    query: input.title,
  });
  if (input.year != null) {
    params.set(kind === "movie" ? "year" : "first_air_date_year", String(input.year));
  }

  let res;
  try {
    res = await fetchWithRetry({
      url: `https://api.themoviedb.org/3/search/${kind}?${params.toString()}`,
      method: "GET",
    });
  } catch (err) {
    // 401 is permanent (bad key) — surface as error without throwing so
    // the pipeline can log + skip without crashing.
    if (err instanceof HttpError && err.status === 401) {
      return { tmdbId: null, tmdbType: null, error: err.message };
    }
    throw err;
  }

  const body = res.json as { results?: TmdbSearchResult[] } | null;
  const results = body?.results ?? [];
  if (results.length === 0) {
    return { tmdbId: null, tmdbType: null };
  }

  // Disambiguation: if year is provided and the top result's year differs
  // by >1, prefer a year-matching second result. Otherwise top result wins.
  let picked = results[0];
  if (input.year != null && results.length > 1) {
    const topYear = yearOf(results[0], kind);
    if (topYear == null || Math.abs(topYear - input.year) > 1) {
      const better = results.slice(1, 5).find((r) => {
        const y = yearOf(r, kind);
        return y != null && Math.abs(y - input.year!) <= 1;
      });
      if (better) picked = better;
    }
  }

  return { tmdbId: String(picked.id), tmdbType: kind };
}
