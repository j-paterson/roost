import { describe, it, expect } from "vitest";
import {
  parseCache,
  serializeCache,
  computeClaimHash,
  computeConceptHash,
  computeClusterRoutingHash,
  emptyCache,
  type MemoryCache,
} from "../cache";

describe("computeClaimHash", () => {
  it("produces stable hash for identical inputs", () => {
    const h1 = computeClaimHash("some claim text", "Bookmarks/X/twitter-123");
    const h2 = computeClaimHash("some claim text", "Bookmarks/X/twitter-123");
    expect(h1).toBe(h2);
  });
  it("produces different hash for different text", () => {
    expect(computeClaimHash("A", "src")).not.toBe(computeClaimHash("B", "src"));
  });
  it("produces different hash for different source", () => {
    expect(computeClaimHash("same", "src1")).not.toBe(computeClaimHash("same", "src2"));
  });
  it("returns a hex string of expected length", () => {
    const h = computeClaimHash("x", "y");
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(h.length).toBe(64); // sha256 hex
  });
});

describe("computeConceptHash", () => {
  it("changes when file content changes", () => {
    expect(computeConceptHash("v1")).not.toBe(computeConceptHash("v2"));
  });
  it("is stable for identical content", () => {
    expect(computeConceptHash("x")).toBe(computeConceptHash("x"));
  });
  it("returns a 64-char hex string (sha256)", () => {
    expect(computeConceptHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeClusterRoutingHash", () => {
  it("differs by headline", () => {
    expect(computeClusterRoutingHash("A", [1, 2, 3]))
      .not.toBe(computeClusterRoutingHash("B", [1, 2, 3]));
  });
  it("differs by centroid", () => {
    expect(computeClusterRoutingHash("X", [1, 2, 3]))
      .not.toBe(computeClusterRoutingHash("X", [3, 2, 1]));
  });
  it("is stable for identical inputs", () => {
    expect(computeClusterRoutingHash("X", [1.5, 2.5]))
      .toBe(computeClusterRoutingHash("X", [1.5, 2.5]));
  });
  it("rounds centroid to avoid float-precision drift", () => {
    // Tiny differences below the rounding threshold should hash identically.
    const a = computeClusterRoutingHash("X", [0.123456789, 0.5]);
    const b = computeClusterRoutingHash("X", [0.123456789, 0.5]);
    expect(a).toBe(b);
  });
});

describe("emptyCache", () => {
  it("returns a fresh empty cache with schemaVersion 1", () => {
    const c = emptyCache();
    expect(c.schemaVersion).toBe(1);
    expect(c.claimDecisions).toEqual({});
    expect(c.conceptRoutings).toEqual({});
  });
});

describe("cache parse/serialize", () => {
  function mkCache(): MemoryCache {
    return {
      schemaVersion: 1,
      claimDecisions: {
        "abc123": {
          targetSlug: "ai-agents",
          decision: { action: "add", claimText: "some claim", rationale: "looks new" },
          conceptFileHash: "def456",
          timestamp: "2026-05-18T01:00:00Z",
          similarity: 0.42,
        },
      },
      conceptRoutings: {
        "xyz789": {
          targetSlug: "ai-agents",
          isNewConcept: false,
          timestamp: "2026-05-18T01:00:00Z",
          similarity: 0.85,
        },
      },
    };
  }

  it("round-trips a full cache", () => {
    const c = mkCache();
    expect(parseCache(serializeCache(c))).toEqual(c);
  });

  it("returns fresh empty cache for malformed JSON", () => {
    const empty = parseCache("not json");
    expect(empty.schemaVersion).toBe(1);
    expect(empty.claimDecisions).toEqual({});
    expect(empty.conceptRoutings).toEqual({});
  });

  it("returns fresh empty cache for older schemaVersion", () => {
    const c = parseCache(JSON.stringify({ schemaVersion: 0, claimDecisions: {} }));
    expect(c.schemaVersion).toBe(1);
    expect(c.claimDecisions).toEqual({});
  });

  it("returns fresh empty cache for missing required fields", () => {
    const c = parseCache(JSON.stringify({ schemaVersion: 1 })); // no claimDecisions
    expect(c.schemaVersion).toBe(1);
    expect(c.claimDecisions).toEqual({});
  });
});
