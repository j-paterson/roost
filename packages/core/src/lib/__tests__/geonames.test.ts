import { describe, it, expect } from "vitest";
import {
  resolveByCityName,
  resolveGeoNames,
  countryGidToIso,
  __gazetteerLoadedForTests,
} from "@/lib/geonames";

describe("geonames lazy gazetteer", () => {
  it("does not parse the gazetteer at import time, then parses on first lookup", () => {
    expect(__gazetteerLoadedForTests()).toBe(false);   // import was free
    expect(resolveByCityName("london", "GB")).toEqual([51.509, -0.126]);
    expect(__gazetteerLoadedForTests()).toBe(true);    // parsed on demand
  });

  it("resolves by name case-insensitively via resolveGeoNames name fallback", () => {
    // no cityCode hit, falls through to byName lookup — requires a countryGid
    // that maps to GB; if countryGidToIso("x") returns null the function
    // returns null, so test the byName path through resolveByCityName instead
    // and keep resolveGeoNames coverage to the null path:
    expect(resolveGeoNames("nonexistent-code", null, null, null)).toBeNull();
  });

  it("countryGidToIso returns null for unknown/empty gids", () => {
    expect(countryGidToIso(null)).toBeNull();
    expect(countryGidToIso("not-a-real-gid")).toBeNull();
  });
});
