import { describe, it, expect } from "vitest";
import {
  isValidSlug,
  isValidClaimId,
  isValidDateString,
  parseBitemporalRange,
  formatBitemporalRange,
  type RelationType,
} from "../schema";

describe("slug validation", () => {
  it("accepts kebab-case lowercased slugs", () => {
    expect(isValidSlug("ai-agents")).toBe(true);
    expect(isValidSlug("rl-from-human-feedback")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });
  it("rejects uppercase, spaces, special chars", () => {
    expect(isValidSlug("AI-agents")).toBe(false);
    expect(isValidSlug("ai agents")).toBe(false);
    expect(isValidSlug("ai/agents")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });
  it("accepts numeric segments and digit-only slugs (intentional)", () => {
    expect(isValidSlug("c4-explosives")).toBe(true);
    expect(isValidSlug("rl-from-2024")).toBe(true);
  });
});

describe("claim ID validation", () => {
  it("accepts cN with positive integer", () => {
    expect(isValidClaimId("c1")).toBe(true);
    expect(isValidClaimId("c42")).toBe(true);
    expect(isValidClaimId("c999")).toBe(true);
  });
  it("rejects non-conforming", () => {
    expect(isValidClaimId("c0")).toBe(false);
    expect(isValidClaimId("c-1")).toBe(false);
    expect(isValidClaimId("C1")).toBe(false);
    expect(isValidClaimId("claim1")).toBe(false);
  });
  it("rejects claim IDs with leading zeros", () => {
    expect(isValidClaimId("c01")).toBe(false);
    expect(isValidClaimId("c007")).toBe(false);
  });
});

describe("date string validation", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isValidDateString("2026-05-18")).toBe(true);
    expect(isValidDateString("2025-01-01")).toBe(true);
  });
  it("rejects malformed", () => {
    expect(isValidDateString("2026-5-18")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-05-32")).toBe(false);
    expect(isValidDateString("present")).toBe(false);
  });
  it("accepts Feb 29 in leap years", () => {
    expect(isValidDateString("2024-02-29")).toBe(true);
  });
  it("rejects Feb 29 in non-leap years", () => {
    expect(isValidDateString("2023-02-29")).toBe(false);
  });
  it("rejects day 31 in 30-day months", () => {
    expect(isValidDateString("2026-04-31")).toBe(false);
  });
  it("rejects Feb 30 (always invalid)", () => {
    expect(isValidDateString("2026-02-30")).toBe(false);
  });
});

describe("bitemporal range round-trip", () => {
  it("round-trips active claim", () => {
    const parsed = parseBitemporalRange("2026-04-26 → present");
    expect(parsed).toEqual({ validFrom: "2026-04-26", validTo: null });
    expect(formatBitemporalRange(parsed!)).toBe("2026-04-26 → present");
  });
  it("round-trips superseded claim", () => {
    const parsed = parseBitemporalRange("2026-04-26 → 2026-05-10");
    expect(parsed).toEqual({ validFrom: "2026-04-26", validTo: "2026-05-10" });
    expect(formatBitemporalRange(parsed!)).toBe("2026-04-26 → 2026-05-10");
  });
  it("returns null for malformed", () => {
    expect(parseBitemporalRange("garbage")).toBeNull();
    expect(parseBitemporalRange("2026-04-26")).toBeNull();
    expect(parseBitemporalRange("2026-04-26 -> present")).toBeNull();
  });
  it("returns null when validFrom > validTo (reversed range)", () => {
    expect(parseBitemporalRange("2026-05-10 → 2026-04-01")).toBeNull();
  });
  it("returns null for regex-valid but calendar-invalid validFrom", () => {
    expect(parseBitemporalRange("2026-13-01 → present")).toBeNull();
  });
  it("returns null for regex-valid but calendar-invalid validTo", () => {
    expect(parseBitemporalRange("2026-04-26 → 2026-02-30")).toBeNull();
  });
});

describe("relation types", () => {
  it("covers all 4 types via exhaustive switch", () => {
    const all: RelationType[] = ["supports", "refines", "contradicts", "supersedes"];
    // Compile-time exhaustiveness: this switch must cover every variant or TS will complain.
    function describe_(r: RelationType): string {
      switch (r) {
        case "supports": return "s";
        case "refines": return "r";
        case "contradicts": return "c";
        case "supersedes": return "x";
      }
    }
    expect(all.map(describe_).sort()).toEqual(["c", "r", "s", "x"]);
  });
});
