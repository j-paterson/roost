import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { nominatimSearch, nominatimCacheStats, __resetCacheForTests } from "@/lib/nominatim";

vi.mock("@/lib/vault-utils", () => ({
  vaultBasePath: (v: any) => v.__base,
}));

function makeVault() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "roost-nominatim-"));
  return { __base: base, __cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

describe("nominatim", () => {
  let vault: ReturnType<typeof makeVault>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetCacheForTests();
    vault = makeVault();
  });

  afterEach(() => {
    vault.__cleanup();
    globalThis.fetch = originalFetch;
  });

  it("returns coords on a successful fetch and writes them to cache", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{ lat: "45.9871", lon: "9.2572", type: "lake", class: "natural" }],
    })) as any;

    const hit = await nominatimSearch(vault as any, "Lake Como, Italy");
    expect(hit).toEqual({ coords: [45.9871, 9.2572], type: "lake", class: "natural" });

    const cacheFile = path.join(vault.__base, ".roost", "cache", "nominatim-cache.json");
    expect(fs.existsSync(cacheFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(parsed.cache["lake como, italy"]).toMatchObject({
      coords: [45.9871, 9.2572],
      type: "lake",
    });
  });

  it("caches negative results (empty response) so repeats skip the network", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [] })) as any;
    globalThis.fetch = fetchSpy;

    const first = await nominatimSearch(vault as any, "NowhereLand");
    expect(first).toBeNull();

    const second = await nominatimSearch(vault as any, "NowhereLand");
    expect(second).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call hit the cache
  });

  it("does NOT cache network errors (transient failures retriable)", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("boom");
    }) as any;
    globalThis.fetch = fetchSpy;

    const first = await nominatimSearch(vault as any, "Lake Como, Italy");
    expect(first).toBeNull();

    const second = await nominatimSearch(vault as any, "Lake Como, Italy");
    expect(second).toBeNull();
    // Both calls hit the network — transient errors don't poison the cache.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache HTTP errors either", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 503, json: async () => [] })) as any;
    globalThis.fetch = fetchSpy;

    await nominatimSearch(vault as any, "Lake Como, Italy");
    await nominatimSearch(vault as any, "Lake Como, Italy");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("loads cache from disk on first call", async () => {
    const cacheFile = path.join(vault.__base, ".roost", "cache", "nominatim-cache.json");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        cache: {
          "lake como, italy": {
            coords: [45.9871, 9.2572],
            type: "lake",
            class: "natural",
            timestamp: Date.now(),
          },
        },
      }),
    );

    const fetchSpy = vi.fn() as any;
    globalThis.fetch = fetchSpy;

    const hit = await nominatimSearch(vault as any, "Lake Como, Italy");
    expect(hit).toEqual({ coords: [45.9871, 9.2572], type: "lake", class: "natural" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes queries — whitespace and case collapse to the same cache key", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => [{ lat: "45.9871", lon: "9.2572" }],
    })) as any;
    globalThis.fetch = fetchSpy;

    await nominatimSearch(vault as any, "Lake Como, Italy");
    await nominatimSearch(vault as any, "  lake   COMO, italy  ");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null for empty or whitespace-only queries without a fetch", async () => {
    const fetchSpy = vi.fn() as any;
    globalThis.fetch = fetchSpy;

    expect(await nominatimSearch(vault as any, "")).toBeNull();
    expect(await nominatimSearch(vault as any, "   ")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache stats count positive vs negative entries", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ lat: "1", lon: "2" }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) as any;

    await nominatimSearch(vault as any, "A");
    await nominatimSearch(vault as any, "B");
    const stats = nominatimCacheStats(vault as any);
    expect(stats).toEqual({ total: 2, positive: 1, negative: 1 });
  });
});
