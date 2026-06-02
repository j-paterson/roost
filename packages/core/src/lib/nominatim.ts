/**
 * Nominatim (OpenStreetMap) geocoding client with persistent cache.
 *
 * Used by the places pipeline to turn TikTok POI data ("Lake Como, Italy",
 * "2432 N Teutonia Ave, Milwaukee") into exact coordinates. Public endpoint
 * policy requires:
 *   - Max 1 req/sec (we throttle to 1100ms to be safe)
 *   - A descriptive User-Agent
 *   - Attribution in any UI displaying the results (rendered under the map)
 *
 * Cache lives at .roost/nominatim-cache.json. Both positive and negative
 * results are cached so reruns don't re-hit the network. Negative results
 * have no TTL — if a query genuinely resolves later, users can delete the
 * cache file to retry.
 */
import type { Vault } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { vaultBasePath } from "./vault-utils";
import { cachePath as roostCachePath, cacheDir } from "./roost-paths";

const CACHE_FILE = "nominatim-cache.json";
const CACHE_SCHEMA_VERSION = 1;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const THROTTLE_MS = 1100;
const USER_AGENT = "Roost-Obsidian/0.1 (obsidian bookmark plugin)";

export interface NominatimHit {
  coords: [number, number];
  /** OSM feature type, e.g. "attraction", "restaurant", "lake". Used by
   *  callers to decide whether the match is precise enough. */
  type?: string;
  /** OSM feature class, e.g. "natural", "building", "amenity", "tourism". */
  class?: string;
}

interface CacheEntry {
  coords: [number, number] | null;
  type?: string;
  class?: string;
  timestamp: number;
}

type Cache = Record<string, CacheEntry>;

let cache: Cache | null = null;
let cacheVault: Vault | null = null;
let lastCallTime = 0;

function cachePath(vault: Vault): string {
  return roostCachePath(vaultBasePath(vault), CACHE_FILE);
}

function loadCache(vault: Vault): Cache {
  if (cache && cacheVault === vault) return cache;
  cacheVault = vault;
  try {
    const text = fs.readFileSync(cachePath(vault), "utf8");
    const parsed = JSON.parse(text);
    cache = (parsed.cache as Cache) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache(vault: Vault): void {
  if (!cache) return;
  try {
    const dir = cacheDir(vaultBasePath(vault));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      cachePath(vault),
      JSON.stringify({ version: CACHE_SCHEMA_VERSION, cache }),
    );
  } catch (e: unknown) {
    console.warn("[roost] nominatim: failed to save cache:", e instanceof Error ? e.message : String(e));
  }
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < THROTTLE_MS) {
    await new Promise((r) => setTimeout(r, THROTTLE_MS - elapsed));
  }
  lastCallTime = Date.now();
}

/**
 * Resolve a free-form query to coordinates via Nominatim.
 *
 * Returns cached hits instantly. Fresh queries are throttled to 1 req/sec and
 * their results (positive or negative) are cached to disk before returning.
 *
 * Network errors are NOT cached — transient failures won't permanently
 * blacklist a query.
 */
export async function nominatimSearch(
  vault: Vault,
  query: string,
): Promise<NominatimHit | null> {
  const key = normalizeQuery(query);
  if (!key) return null;

  const c = loadCache(vault);
  if (key in c) {
    const hit = c[key];
    if (!hit.coords) return null;
    return { coords: hit.coords, type: hit.type, class: hit.class };
  }

  await throttle();

  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!resp.ok) {
      console.warn(`[roost] nominatim: HTTP ${resp.status} for "${query}"`);
      return null;
    }
    const rows = (await resp.json()) as Array<{
      lat: string;
      lon: string;
      type?: string;
      class?: string;
    }>;
    const first = rows[0];
    if (!first) {
      c[key] = { coords: null, timestamp: Date.now() };
      saveCache(vault);
      return null;
    }
    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      c[key] = { coords: null, timestamp: Date.now() };
      saveCache(vault);
      return null;
    }
    // 4 decimals ≈ 11m precision — enough for venue-level pins without
    // fingerprinting user data at sub-meter resolution.
    const round = (x: number) => Math.round(x * 10000) / 10000;
    const coords: [number, number] = [round(lat), round(lng)];
    c[key] = {
      coords,
      type: first.type,
      class: first.class,
      timestamp: Date.now(),
    };
    saveCache(vault);
    return { coords, type: first.type, class: first.class };
  } catch (e: unknown) {
    console.warn(`[roost] nominatim: fetch error for "${query}":`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export interface NominatimCacheStats {
  total: number;
  positive: number;
  negative: number;
}

export function nominatimCacheStats(vault: Vault): NominatimCacheStats {
  const c = loadCache(vault);
  let positive = 0;
  let negative = 0;
  for (const v of Object.values(c)) {
    if (v.coords) positive++;
    else negative++;
  }
  return { total: Object.keys(c).length, positive, negative };
}

/** Force a cache reload from disk. Exposed for tests. */
export function __resetCacheForTests(): void {
  cache = null;
  cacheVault = null;
  lastCallTime = 0;
}
