import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { resolveAnilist } from "../anilist-resolver";

function mkResponse(status: number, body: unknown): RequestUrlResponse {
  return {
    status,
    headers: {},
    text: typeof body === "string" ? body : JSON.stringify(body),
    json: typeof body === "string" ? null : body,
    arrayBuffer: new ArrayBuffer(0),
  } as RequestUrlResponse;
}

describe("resolveAnilist", () => {
  let captured: { url: string; body: string }[] = [];

  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("resolves an anime by title via GraphQL POST", async () => {
    __setRequestUrlImpl(async (opts) => {
      captured.push({ url: opts.url, body: opts.body as string });
      return mkResponse(200, {
        data: {
          Media: {
            id: 16498,
            title: { romaji: "Shingeki no Kyojin", english: "Attack on Titan" },
            startDate: { year: 2013 },
          },
        },
      });
    });

    const result = await resolveAnilist({ title: "Attack on Titan" });

    expect(result).toEqual({ anilistId: "16498" });
    expect(captured[0].url).toBe("https://graphql.anilist.co");
    const parsed = JSON.parse(captured[0].body);
    expect(parsed.query).toContain("Media(search:");
    expect(parsed.variables).toEqual({ search: "Attack on Titan" });
  });

  it("returns null when AniList finds no match", async () => {
    __setRequestUrlImpl(async () => mkResponse(200, { data: { Media: null } }));

    const result = await resolveAnilist({ title: "Nonexistent Anime 12345" });

    expect(result).toEqual({ anilistId: null });
  });

  it("returns null + error when AniList responds with GraphQL errors", async () => {
    __setRequestUrlImpl(async () =>
      mkResponse(200, {
        errors: [{ message: "Validation error" }],
        data: null,
      }),
    );

    const result = await resolveAnilist({ title: "Attack on Titan" });

    expect(result.anilistId).toBeNull();
    expect(result.error).toMatch(/Validation error/);
  });

  it("returns null when response shape is unexpected", async () => {
    __setRequestUrlImpl(async () => mkResponse(200, { unexpected: "shape" }));

    const result = await resolveAnilist({ title: "Attack on Titan" });

    expect(result).toEqual({ anilistId: null });
  });
});
