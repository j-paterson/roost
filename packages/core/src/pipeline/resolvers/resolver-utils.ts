/**
 * Shared helpers for the watchable-id resolvers (TMDB, AniList):
 * - canonicalizeTitle: parse trailing year + strip annotations
 * - fetchWithRetry: Obsidian requestUrl wrapper with 5xx + 429 backoff
 */

import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

/** Error thrown by `fetchWithRetry` on non-retriable HTTP failures. Carries
 *  the status code so callers can branch on auth (401), forbidden (403), etc.
 *  without parsing the message string. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface CanonicalTitle {
  /** Title stripped of trailing year + bracketed annotations, whitespace-normalized. */
  title: string;
  /** Parsed year if a 4-digit number in film range (1888-2100) was found. */
  year: number | null;
}

/** Min year matches the oldest known film (Roundhay Garden Scene, 1888);
 *  max year leaves headroom for upcoming releases. Anything outside is
 *  treated as a non-year number that happens to be parenthesized. */
const MIN_YEAR = 1888;
const MAX_YEAR = 2100;

/**
 * Pull out trailing `(YYYY)` or `[YYYY]` as the year, strip remaining
 * bracketed annotations, normalize whitespace.
 *
 *   "The Matrix (1999)"          → { title: "The Matrix", year: 1999 }
 *   "The Matrix [Trailer]"       → { title: "The Matrix", year: null }
 *   "Severance s2 ep1 reaction"  → { title: "Severance s2 ep1 reaction", year: null }
 *
 * The resolver retries with the raw title if the canonical query returns
 * nothing, so over-aggressive stripping isn't catastrophic.
 */
export function canonicalizeTitle(raw: string): CanonicalTitle {
  let title = raw;
  let year: number | null = null;

  // Year extraction — find the first (YYYY) or [YYYY] in valid film range.
  // We scan all bracketed tokens and take the first valid year found.
  // The matching token is then removed from the title.
  title = title.replace(/\s*[(\[](\d{4})[)\]]\s*/g, (match, digits, offset, str) => {
    const parsed = parseInt(digits, 10);
    if (year === null && parsed >= MIN_YEAR && parsed <= MAX_YEAR) {
      year = parsed;
      return " "; // remove from title
    }
    return match; // leave in place for next pass
  });

  // Strip remaining bracketed annotations that are NOT bare numeric tokens
  // (to preserve titles like "Room (101)" where (101) isn't a year annotation).
  // A "bare numeric" token is one whose content is purely digits — we leave
  // those alone because stripping them would change the semantics of the title.
  title = title.replace(/\s*[(\[][^)\]]*[)\]]\s*/g, (match) => {
    const inner = match.trim().slice(1, -1);
    // Leave purely-numeric tokens (non-year numbers) intact.
    if (/^\d+$/.test(inner.trim())) return match;
    return " ";
  });

  // Normalize whitespace.
  title = title.replace(/\s+/g, " ").trim();

  return { title, year };
}

export interface FetchRetryOpts {
  /** Number of retries after the initial attempt. Default 2 (so up to 3 total attempts). */
  retries?: number;
  /** Base delay in ms for exponential backoff. Default 250. */
  baseDelayMs?: number;
  /** Injectable sleep for tests. Default is a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrapper around Obsidian's requestUrl with retry semantics for transient
 * failures: 5xx, 429 (respecting Retry-After), thrown network errors.
 * Other 4xx are returned as errors immediately — no retry budget wasted.
 */
export async function fetchWithRetry(
  params: RequestUrlParam,
  opts: FetchRetryOpts = {},
): Promise<RequestUrlResponse> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = opts.sleep ?? realSleep;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Obsidian's requestUrl throws on non-2xx by default — pass throw: false
      // so we can inspect the status code ourselves.
      const res = await requestUrl({ ...params, throw: false });

      if (res.status >= 200 && res.status < 300) {
        return res;
      }

      // 429 → respect Retry-After if present; otherwise exponential backoff.
      if (res.status === 429 && attempt < retries) {
        const retryAfter = res.headers["Retry-After"] ?? res.headers["retry-after"];
        const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const delayMs = Number.isFinite(seconds)
          ? Math.max(1000, seconds * 1000)
          : baseDelay * Math.pow(4, attempt);
        await sleep(delayMs);
        continue;
      }

      // 5xx → retry with exponential backoff.
      if (res.status >= 500 && attempt < retries) {
        await sleep(baseDelay * Math.pow(4, attempt));
        continue;
      }

      // Other 4xx or final retry exhausted → throw.
      throw new HttpError(res.status, `HTTP ${res.status}: ${res.text?.slice(0, 200) ?? ""}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Network-style errors: retry if budget remains. HttpError means we
      // already made a decision about the status code (4xx permanent, or 5xx
      // budget exhausted) — don't retry those. Everything else is a genuine
      // network error worth retrying.
      if (attempt < retries && !(lastError instanceof HttpError)) {
        await sleep(baseDelay * Math.pow(4, attempt));
        continue;
      }
      throw lastError;
    }
  }

  // Unreachable but TypeScript wants a fallback.
  throw lastError ?? new Error("fetchWithRetry: unknown error");
}
