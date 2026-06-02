import { describe, it, expect } from "vitest";
import { watchableUrl, type WatchableRow } from "./watchable-url";

function row(overrides: Partial<WatchableRow>): WatchableRow {
  return {
    subcategory: "films",
    title: "The Matrix",
    year: null,
    tmdbId: null,
    tmdbType: null,
    anilistId: null,
    ...overrides,
  };
}

describe("watchableUrl", () => {
  describe("Films", () => {
    it("returns canonical Letterboxd URL when tmdbId + tmdbType are set", () => {
      const result = watchableUrl(row({ tmdbId: "603", tmdbType: "movie" }));
      expect(result).toEqual({
        url: "https://letterboxd.com/tmdb/603/",
        kind: "canonical",
      });
    });

    it("returns Letterboxd search URL when tmdbId is null", () => {
      const result = watchableUrl(row({ title: "The Matrix", year: 1999 }));
      expect(result).toEqual({
        url: "https://letterboxd.com/search/films/The%20Matrix%201999/",
        kind: "search",
      });
    });

    it("omits year from search URL when year is null", () => {
      const result = watchableUrl(row({ title: "The Matrix", year: null }));
      expect(result?.url).toBe("https://letterboxd.com/search/films/The%20Matrix/");
    });
  });

  describe("Series", () => {
    it("returns search URL for series even when tmdbId + tmdbType are set", () => {
      const result = watchableUrl(
        row({ subcategory: "series", tmdbId: "1399", tmdbType: "tv", title: "Game of Thrones" }),
      );
      // Letterboxd's TMDB redirect is films-only; series always uses search.
      expect(result).toEqual({
        url: "https://letterboxd.com/search/tv/Game%20of%20Thrones/",
        kind: "search",
      });
    });

    it("uses /search/tv/ path when unresolved", () => {
      const result = watchableUrl(
        row({ subcategory: "series", title: "Severance" }),
      );
      expect(result?.url).toBe("https://letterboxd.com/search/tv/Severance/");
    });
  });

  describe("Documentaries", () => {
    it("routes to Letterboxd /tmdb/ path (same as Films)", () => {
      const result = watchableUrl(
        row({ subcategory: "documentaries", tmdbId: "12345", tmdbType: "movie" }),
      );
      expect(result?.url).toBe("https://letterboxd.com/tmdb/12345/");
    });

    it("uses /search/films/ path when unresolved", () => {
      const result = watchableUrl(
        row({ subcategory: "documentaries", title: "Citizenfour" }),
      );
      expect(result?.url).toBe("https://letterboxd.com/search/films/Citizenfour/");
    });
  });

  describe("Anime", () => {
    it("returns canonical AniList URL when anilistId is set", () => {
      const result = watchableUrl(
        row({ subcategory: "anime", anilistId: "16498" }),
      );
      expect(result).toEqual({
        url: "https://anilist.co/anime/16498",
        kind: "canonical",
      });
    });

    it("returns AniList search URL when anilistId is null", () => {
      const result = watchableUrl(
        row({ subcategory: "anime", title: "Attack on Titan", year: 2013 }),
      );
      expect(result).toEqual({
        url: "https://anilist.co/search/anime?search=Attack%20on%20Titan%202013",
        kind: "search",
      });
    });
  });

  describe("Non-watchable subcategories", () => {
    it("returns null for music", () => {
      expect(watchableUrl(row({ subcategory: "music" }))).toBeNull();
    });

    it("returns null for books", () => {
      expect(watchableUrl(row({ subcategory: "books" }))).toBeNull();
    });

    it("returns null for unknown subcategory", () => {
      expect(watchableUrl(row({ subcategory: "podcasts" }))).toBeNull();
    });
  });

  describe("Case insensitivity", () => {
    it("accepts uppercase subcategory", () => {
      const result = watchableUrl(row({ subcategory: "Films", tmdbId: "603", tmdbType: "movie" }));
      expect(result?.kind).toBe("canonical");
    });
  });
});
