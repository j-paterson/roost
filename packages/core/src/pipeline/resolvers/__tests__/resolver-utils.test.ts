import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { canonicalizeTitle, fetchWithRetry } from "../resolver-utils";

describe("canonicalizeTitle", () => {
  it("returns title unchanged when there's nothing to strip", () => {
    expect(canonicalizeTitle("The Matrix")).toEqual({ title: "The Matrix", year: null });
  });

  it("parses trailing parenthesized year", () => {
    expect(canonicalizeTitle("The Matrix (1999)")).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("strips bracketed annotations", () => {
    expect(canonicalizeTitle("The Matrix [Trailer]")).toEqual({
      title: "The Matrix",
      year: null,
    });
  });

  it("handles trailing year inside brackets too", () => {
    expect(canonicalizeTitle("The Matrix [1999]")).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("strips both brackets and parens combined", () => {
    expect(canonicalizeTitle("The Matrix (1999) [HD]")).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("rejects non-year-looking numbers in parens", () => {
    expect(canonicalizeTitle("Room (101)")).toEqual({
      title: "Room (101)",
      year: null,
    });
  });

  it("accepts 4-digit years in valid film range", () => {
    expect(canonicalizeTitle("Some Film (2024)").year).toBe(2024);
    expect(canonicalizeTitle("Some Film (1895)").year).toBe(1895);
  });

  it("rejects years outside film range", () => {
    expect(canonicalizeTitle("Some Film (1800)").year).toBeNull();
    expect(canonicalizeTitle("Some Film (2200)").year).toBeNull();
  });

  it("trims whitespace from result title", () => {
    expect(canonicalizeTitle("  The Matrix  ").title).toBe("The Matrix");
  });

  it("collapses internal whitespace runs", () => {
    expect(canonicalizeTitle("The   Matrix")).toEqual({
      title: "The Matrix",
      year: null,
    });
  });

  it("handles empty input", () => {
    expect(canonicalizeTitle("")).toEqual({ title: "", year: null });
  });
});

function mkResponse(status: number, body: unknown, headers: Record<string, string> = {}): RequestUrlResponse {
  return {
    status,
    headers,
    text: typeof body === "string" ? body : JSON.stringify(body),
    json: typeof body === "string" ? null : body,
    arrayBuffer: new ArrayBuffer(0),
  } as RequestUrlResponse;
}

describe("fetchWithRetry", () => {
  let calls: { url: string; opts: unknown }[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("returns the response on a 2xx first try", async () => {
    __setRequestUrlImpl(async (opts) => {
      calls.push({ url: opts.url, opts });
      return mkResponse(200, { ok: true });
    });

    const res = await fetchWithRetry({ url: "https://example.com/" });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("retries on 500 and succeeds on second try", async () => {
    let count = 0;
    __setRequestUrlImpl(async () => {
      count++;
      return count === 1 ? mkResponse(500, "boom") : mkResponse(200, { ok: true });
    });

    const res = await fetchWithRetry({ url: "https://example.com/" }, { retries: 2, baseDelayMs: 1 });

    expect(res.status).toBe(200);
    expect(count).toBe(2);
  });

  it("throws after exhausting retries on persistent 500", async () => {
    __setRequestUrlImpl(async () => mkResponse(500, "boom"));

    await expect(
      fetchWithRetry({ url: "https://example.com/" }, { retries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(/500/);
  });

  it("honors Retry-After header on 429", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    let count = 0;
    __setRequestUrlImpl(async () => {
      count++;
      return count === 1
        ? mkResponse(429, "rate-limited", { "Retry-After": "2" })
        : mkResponse(200, { ok: true });
    });

    const res = await fetchWithRetry(
      { url: "https://example.com/" },
      { retries: 2, baseDelayMs: 1, sleep },
    );

    expect(res.status).toBe(200);
    // Retry-After: 2 → 2000ms delay
    expect(delays[0]).toBe(2000);
  });

  it("does NOT retry on 4xx other than 429", async () => {
    let count = 0;
    __setRequestUrlImpl(async () => {
      count++;
      return mkResponse(401, "unauthorized");
    });

    await expect(
      fetchWithRetry({ url: "https://example.com/" }, { retries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(/401/);
    expect(count).toBe(1);
  });

  it("retries on thrown network error", async () => {
    let count = 0;
    __setRequestUrlImpl(async () => {
      count++;
      if (count < 2) throw new Error("ECONNREFUSED");
      return mkResponse(200, { ok: true });
    });

    const res = await fetchWithRetry(
      { url: "https://example.com/" },
      { retries: 2, baseDelayMs: 1 },
    );

    expect(res.status).toBe(200);
    expect(count).toBe(2);
  });
});

describe("fetchWithRetry timeout", () => {
  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("times out a hung request and retries the full budget", async () => {
    let calls = 0;
    __setRequestUrlImpl(() => {
      calls++;
      return new Promise(() => {});
    });

    await expect(
      fetchWithRetry({ url: "https://x" }, { timeoutMs: 10, retries: 1, sleep: async () => {} }),
    ).rejects.toThrow(/timed out/);

    expect(calls).toBe(2);
  });

  it("fast success is unaffected by the timeout race", async () => {
    const fakeResponse = mkResponse(200, {});
    __setRequestUrlImpl(async () => fakeResponse);

    const res = await fetchWithRetry({ url: "https://x" }, { timeoutMs: 1000 });
    expect(res.status).toBe(200);
  });
});
