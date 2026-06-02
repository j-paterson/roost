/**
 * AniList GraphQL search for Anime. No auth required for public reads.
 * Endpoint: https://graphql.anilist.co
 *
 * SEARCH_MATCH sort returns the best fuzzy match first; we take Media.id.
 * Year filtering isn't needed — anime titles are distinctive enough that
 * the top match is right.
 */
import { fetchWithRetry } from "./resolver-utils";

export interface AnilistResolveInput {
  title: string;
}

export interface AnilistResolveResult {
  anilistId: string | null;
  error?: string;
}

const ANILIST_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
    id
    title { romaji english }
    startDate { year }
  }
}
`.trim();

interface AnilistResponse {
  data?: {
    Media?: { id: number } | null;
  } | null;
  errors?: { message: string }[];
}

export async function resolveAnilist(
  input: AnilistResolveInput,
): Promise<AnilistResolveResult> {
  const res = await fetchWithRetry({
    url: "https://graphql.anilist.co",
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { search: input.title },
    }),
  });

  const body = res.json as AnilistResponse | null;

  if (body?.errors && body.errors.length > 0) {
    return { anilistId: null, error: body.errors.map((e) => e.message).join("; ") };
  }

  const id = body?.data?.Media?.id;
  if (id == null) {
    return { anilistId: null };
  }

  return { anilistId: String(id) };
}
