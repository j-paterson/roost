/**
 * GeoNames lookup for TikTok POI data.
 *
 * Resolves a pin's coordinates by trying, in order:
 *   1. poi.cityCode (GeoNames numeric ID) — direct hit
 *   2. poi.city + country ISO2 — name-based fallback (for posts where
 *      cityCode is a TikTok-internal ID, not a real GeoNames ID)
 *   3. poi.name + country ISO2 — second fallback (for posts where city
 *      is empty but the POI name matches a known city, e.g. "London")
 *
 * Data built by scripts/build-geonames.mjs from the GeoNames cities5000 dump.
 * Covers ~77% of our TikTok POI corpus on top of a ~4MB bundle cost.
 */
import data from "@/data/geonames-cities.json";

type Coord = [number, number];
interface GeoNamesData {
  version: string;
  cities: Record<string, Coord>;
  byName: Record<string, Coord>;
  gidToIso: Record<string, string>;
}

// JSON shape is correct at runtime but TS infers literal `cities` keys that
// don't statically narrow to Record<string, Coord>. Cast through unknown so
// the assertion is permitted.
const DATA = data as unknown as GeoNamesData;

export function countryGidToIso(countryGid: string | undefined | null): string | null {
  if (!countryGid) return null;
  return DATA.gidToIso[String(countryGid)] ?? null;
}

function nameKey(name: string, iso: string): string {
  return name.toLowerCase().trim() + "|" + iso;
}

/**
 * Resolve a POI to coordinates. Returns null if nothing matches.
 *
 * `cityCode` is the TikTok `poi.cityCode` (may be a GeoNames ID or a
 * TikTok-internal ID). `countryGid` is TikTok's `poi.countryCode` — also a
 * GeoNames numeric ID (despite the field name), which we translate to ISO2.
 */
export function resolveGeoNames(
  cityCode: string | null | undefined,
  city: string | null | undefined,
  name: string | null | undefined,
  countryGid: string | null | undefined,
): Coord | null {
  if (cityCode && DATA.cities[cityCode]) return DATA.cities[cityCode];
  const iso = countryGidToIso(countryGid);
  if (!iso) return null;
  if (city) {
    const hit = DATA.byName[nameKey(city, iso)];
    if (hit) return hit;
  }
  if (name) {
    const hit = DATA.byName[nameKey(name, iso)];
    if (hit) return hit;
  }
  return null;
}

/** Name-based lookup only — used by buildMapPins when it has extraction.city but no poi context. */
export function resolveByCityName(city: string, iso: string): Coord | null {
  return DATA.byName[nameKey(city, iso)] ?? null;
}
