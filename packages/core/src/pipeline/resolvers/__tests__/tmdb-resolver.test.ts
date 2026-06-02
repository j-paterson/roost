import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { resolveTmdb } from "../tmdb-resolver";

function mkResponse(status: number, body: unknown): RequestUrlResponse {
  return {
    status,
    headers: {},
    text: typeof body === "string" ? body : JSON.stringify(body),
    json: typeof body === "string" ? null : body,
    arrayBuffer: new ArrayBuffer(0),
  } as RequestUrlResponse;
}

const MOVIE_HIT = {
  results: [
    { id: 603, title: "The Matrix", release_date: "1999-03-30", popularity: 87.2 },
  ],
};

const MOVIE_AMBIGUOUS = {
  results: [
    { id: 999, title: "The Matrix Reloaded", release_date: "2003-05-15", popularity: 50.0 },
    { id: 603, title: "The Matrix", release_date: "1999-03-30", popularity: 87.2 },
  ],
};

const TV_HIT = {
  results: [
    { id: 1399, name: "Game of Thrones", first_air_date: "2011-04-17", popularity: 120.0 },
  ],
};

describe("resolveTmdb", () => {
  let urls: string[] = [];

  beforeEach(() => {
    urls = [];
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("returns null tmdbId when API key is empty", async () => {
    __setRequestUrlImpl(async (opts) => {
      urls.push(opts.url);
      return mkResponse(200, MOVIE_HIT);
    });

    const result = await resolveTmdb(
      { title: "The Matrix", year: null, subcategory: "Films" },
      "",
    );

    expect(result).toEqual({ tmdbId: null, tmdbType: null });
    expect(urls).toEqual([]); // no API call attempted
  });

  it("resolves a film via /search/movie", async () => {
    __setRequestUrlImpl(async (opts) => {
      urls.push(opts.url);
      return mkResponse(200, MOVIE_HIT);
    });

    const result = await resolveTmdb(
      { title: "The Matrix", year: 1999, subcategory: "Films" },
      "key123",
    );

    expect(result).toEqual({ tmdbId: "603", tmdbType: "movie" });
    expect(urls[0]).toContain("api.themoviedb.org/3/search/movie");
    expect(urls[0]).toContain("api_key=key123");
    expect(urls[0]).toContain("year=1999");
  });

  it("routes Documentaries to /search/movie (same as Films)", async () => {
    __setRequestUrlImpl(async (opts) => {
      urls.push(opts.url);
      return mkResponse(200, MOVIE_HIT);
    });

    await resolveTmdb(
      { title: "Citizenfour", year: null, subcategory: "Documentaries" },
      "key123",
    );

    expect(urls[0]).toContain("/search/movie");
  });

  it("routes Series to /search/tv", async () => {
    __setRequestUrlImpl(async (opts) => {
      urls.push(opts.url);
      return mkResponse(200, TV_HIT);
    });

    const result = await resolveTmdb(
      { title: "Game of Thrones", year: null, subcategory: "Series" },
      "key123",
    );

    expect(result).toEqual({ tmdbId: "1399", tmdbType: "tv" });
    expect(urls[0]).toContain("/search/tv");
  });

  it("falls back to second result when top result year mismatches", async () => {
    __setRequestUrlImpl(async () => mkResponse(200, MOVIE_AMBIGUOUS));

    const result = await resolveTmdb(
      { title: "The Matrix", year: 1999, subcategory: "Films" },
      "key123",
    );

    // Top result (Reloaded, 2003) misses year=1999 by 4; second result (Matrix, 1999) hits.
    expect(result).toEqual({ tmdbId: "603", tmdbType: "movie" });
  });

  it("takes top result when no year is provided", async () => {
    __setRequestUrlImpl(async () => mkResponse(200, MOVIE_AMBIGUOUS));

    const result = await resolveTmdb(
      { title: "The Matrix", year: null, subcategory: "Films" },
      "key123",
    );

    // No year → don't filter, take top.
    expect(result).toEqual({ tmdbId: "999", tmdbType: "movie" });
  });

  it("returns null on empty results", async () => {
    __setRequestUrlImpl(async () => mkResponse(200, { results: [] }));

    const result = await resolveTmdb(
      { title: "Nonexistent Title 12345", year: null, subcategory: "Films" },
      "key123",
    );

    expect(result).toEqual({ tmdbId: null, tmdbType: null });
  });

  it("falls through to next result when top result has no release_date", async () => {
    __setRequestUrlImpl(async () => mkResponse(200, {
      results: [
        { id: 999, title: "Mystery Movie", popularity: 99.0 },  // no release_date
        { id: 603, title: "The Matrix", release_date: "1999-03-30", popularity: 87.2 },
      ],
    }));

    const result = await resolveTmdb(
      { title: "The Matrix", year: 1999, subcategory: "Films" },
      "key123",
    );

    // Top result has no release_date, year is requested → yearOf returns null → scan next 4.
    expect(result).toEqual({ tmdbId: "603", tmdbType: "movie" });
  });

  it("returns null and surfaces error on 401 (invalid key)", async () => {
    __setRequestUrlImpl(async () => mkResponse(401, "invalid api key"));

    const result = await resolveTmdb(
      { title: "The Matrix", year: null, subcategory: "Films" },
      "bad-key",
    );

    expect(result.tmdbId).toBeNull();
    expect(result.tmdbType).toBeNull();
    expect(result.error).toMatch(/401/);
  });
});
