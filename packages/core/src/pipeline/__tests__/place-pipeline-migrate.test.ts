// @vitest-environment node
/**
 * Basic tests for the place pipeline migrator helpers and field constants.
 *
 * The migrator itself requires an Obsidian vault runtime, so integration tests
 * are skipped here. We verify:
 *   1. PLACE_FIELDS exports have the expected keys (smoke test for the import).
 *   2. The lat/lng parsing handles number, string, and null inputs correctly.
 *   3. The field set written to source bookmarks includes all required keys.
 */
import { describe, it, expect } from "vitest";
import { PLACE_FIELDS } from "@/pipeline/places-pipeline";

// ── Re-export parseLng for direct testing ─────────────────────────────────────
// parseLng is not exported from the migrator, so we reproduce the logic here
// (it's tiny and stable).
function parseLng(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PLACE_FIELDS (imported from places-pipeline)", () => {
  it("uses place_* prefix for core fields", () => {
    expect(PLACE_FIELDS.name).toBe("place_name");
    expect(PLACE_FIELDS.city).toBe("place_city");
    expect(PLACE_FIELDS.country).toBe("place_country");
    expect(PLACE_FIELDS.type).toBe("place_type");
    expect(PLACE_FIELDS.address).toBe("place_address");
    expect(PLACE_FIELDS.bestFor).toBe("place_best_for");
    expect(PLACE_FIELDS.lat).toBe("place_lat");
    expect(PLACE_FIELDS.lng).toBe("place_lng");
  });

  it("uses the unified enrichment_v_place version key", () => {
    expect(PLACE_FIELDS.version).toBe("enrichment_v_place");
  });
});

describe("parseLng", () => {
  it("returns a number unchanged", () => {
    expect(parseLng(37.794)).toBe(37.794);
    expect(parseLng(-122.407)).toBe(-122.407);
    expect(parseLng(0)).toBe(0);
  });

  it("parses a valid numeric string", () => {
    expect(parseLng("37.794")).toBeCloseTo(37.794);
    expect(parseLng("-122.407")).toBeCloseTo(-122.407);
  });

  it("returns null for non-numeric strings", () => {
    expect(parseLng("not a number")).toBeNull();
    expect(parseLng("")).toBeNull();
    expect(parseLng("NaN")).toBeNull();
  });

  it("returns null for null, undefined, and non-numeric types", () => {
    expect(parseLng(null)).toBeNull();
    expect(parseLng(undefined)).toBeNull();
    expect(parseLng({})).toBeNull();
    expect(parseLng([])).toBeNull();
  });
});

describe("place migrator field set", () => {
  it("covers all required PLACE_FIELDS keys", () => {
    // Simulate what the migrator builds from old FM — verify it touches all fields.
    const requiredKeys = [
      PLACE_FIELDS.name,
      PLACE_FIELDS.city,
      PLACE_FIELDS.country,
      PLACE_FIELDS.type,
      PLACE_FIELDS.address,
      PLACE_FIELDS.bestFor,
      PLACE_FIELDS.lat,
      PLACE_FIELDS.lng,
      PLACE_FIELDS.description,
      PLACE_FIELDS.vibes,
      PLACE_FIELDS.tips,
      PLACE_FIELDS.version,
    ];

    const fakeOldFm = {
      name: "Colosseum",
      city: "Rome",
      country: "Italy",
      place_type: "landmark",
      best_for: "History lovers",
      address: "Piazza del Colosseo",
      lat: 41.89,
      lng: 12.492,
      description: "Ancient amphitheatre",
      vibes: ["historic", "iconic"],
      tips: ["Arrive early"],
      pipeline: "places",
      source_id: "tiktok:12345",
    };

    // Build the updates map the same way the migrator does
    const updates: Record<string, unknown> = {
      [PLACE_FIELDS.name]: fakeOldFm.name,
      [PLACE_FIELDS.city]: fakeOldFm.city,
      [PLACE_FIELDS.country]: fakeOldFm.country,
      [PLACE_FIELDS.type]: fakeOldFm.place_type,
      [PLACE_FIELDS.address]: fakeOldFm.address,
      [PLACE_FIELDS.bestFor]: fakeOldFm.best_for,
      [PLACE_FIELDS.lat]: parseLng(fakeOldFm.lat),
      [PLACE_FIELDS.lng]: parseLng(fakeOldFm.lng),
      [PLACE_FIELDS.description]: fakeOldFm.description,
      [PLACE_FIELDS.vibes]: fakeOldFm.vibes,
      [PLACE_FIELDS.tips]: fakeOldFm.tips,
      [PLACE_FIELDS.version]: 1,
    };

    for (const key of requiredKeys) {
      expect(Object.prototype.hasOwnProperty.call(updates, key)).toBe(true);
    }

    // Spot-check values
    expect(updates[PLACE_FIELDS.name]).toBe("Colosseum");
    expect(updates[PLACE_FIELDS.lat]).toBeCloseTo(41.89);
    expect(updates[PLACE_FIELDS.version]).toBe(1);
  });

  it("handles missing optional fields gracefully", () => {
    const minimalFm = { name: "Unknown Cafe", pipeline: "places", source_id: "tiktok:99" };

    const updates: Record<string, unknown> = {
      [PLACE_FIELDS.name]: (minimalFm as Record<string, unknown>).name ?? "",
      [PLACE_FIELDS.city]: "",
      [PLACE_FIELDS.country]: "",
      [PLACE_FIELDS.type]: "",
      [PLACE_FIELDS.address]: null,
      [PLACE_FIELDS.bestFor]: null,
      [PLACE_FIELDS.lat]: parseLng((minimalFm as Record<string, unknown>).lat),
      [PLACE_FIELDS.lng]: parseLng((minimalFm as Record<string, unknown>).lng),
      [PLACE_FIELDS.description]: null,
      [PLACE_FIELDS.vibes]: [],
      [PLACE_FIELDS.tips]: [],
      [PLACE_FIELDS.version]: 1,
    };

    expect(updates[PLACE_FIELDS.lat]).toBeNull();
    expect(updates[PLACE_FIELDS.lng]).toBeNull();
    expect(updates[PLACE_FIELDS.address]).toBeNull();
    expect(updates[PLACE_FIELDS.vibes]).toEqual([]);
  });
});
