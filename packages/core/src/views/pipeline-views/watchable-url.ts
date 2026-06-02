/**
 * Pure URL construction for watchable media rows (Films, Series, Anime,
 * Documentaries). Returns a canonical destination URL when a resolved ID
 * is present, otherwise a search URL. Returns null for non-watchable
 * subcategories so the caller falls through to existing rendering.
 *
 * URL construction stays at render time so format changes (e.g. a
 * Letterboxd redesign) don't require rewriting frontmatter across the
 * vault. Frontmatter stores IDs; this function turns them into URLs.
 */

export interface WatchableRow {
  /** Case-insensitive: "Films" | "films" | "Series" | "series" |
   *  "Anime" | "anime" | "Documentaries" | "documentaries" — anything
   *  else returns null. */
  subcategory: string;
  title: string;
  year: number | null;
  tmdbId: string | null;
  /**
   * Preserved for future use and populated by the resolver, but not
   * currently consulted in URL construction. Letterboxd's TMDB redirect
   * is films-only (verified pre-merge: /tmdb/{id}/ works; TV TMDB IDs
   * land on a "Film not found" page), so we no longer branch on tmdbType
   * here. Series always uses the search-URL fallback.
   */
  tmdbType: "movie" | "tv" | null;
  anilistId: string | null;
}

export type WatchableUrl = { url: string; kind: "canonical" | "search" };

export function watchableUrl(row: WatchableRow): WatchableUrl | null {
  const sub = row.subcategory.toLowerCase();
  const titleQuery = encodeURIComponent(
    row.title + (row.year ? ` ${row.year}` : ""),
  );

  if (sub === "anime") {
    if (row.anilistId) {
      return { url: `https://anilist.co/anime/${row.anilistId}`, kind: "canonical" };
    }
    return {
      url: `https://anilist.co/search/anime?search=${titleQuery}`,
      kind: "search",
    };
  }

  if (sub === "films" || sub === "documentaries") {
    if (row.tmdbId) {
      return { url: `https://letterboxd.com/tmdb/${row.tmdbId}/`, kind: "canonical" };
    }
    return {
      url: `https://letterboxd.com/search/films/${titleQuery}/`,
      kind: "search",
    };
  }

  if (sub === "series") {
    // Letterboxd's TMDB redirect only supports films. TV TMDB IDs land on a
    // "Film not found" page (verified pre-merge). Always use search for TV.
    return {
      url: `https://letterboxd.com/search/tv/${titleQuery}/`,
      kind: "search",
    };
  }

  return null;
}
