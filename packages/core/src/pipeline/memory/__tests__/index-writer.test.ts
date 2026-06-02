import { describe, it, expect } from "vitest";
import { partitionTiers, renderIndex, renderArchive, type IndexConcept } from "../index-writer";

function mkIdx(slug: string, lastUpdated: string, activeClaimCount: number): IndexConcept {
  return {
    slug,
    name: `Name of ${slug}`,
    summary: `Summary of ${slug}.`,
    lastUpdated,
    activeClaimCount,
  };
}

describe("partitionTiers", () => {
  const today = "2026-05-18";

  it("places concepts with >= 3 claims and < 90 days old in Tier 1", () => {
    const concepts = [
      mkIdx("a", "2026-05-10", 5),
      mkIdx("b", "2026-05-15", 3),
    ];
    const { tier1, tier2 } = partitionTiers(concepts, today, {
      maxConcepts: 20,
      maxAgeDays: 90,
    });
    expect(tier1.map((c) => c.slug)).toEqual(["b", "a"]); // sorted by lastUpdated desc
    expect(tier2).toEqual([]);
  });

  it("demotes concepts older than maxAgeDays to Tier 2", () => {
    const concepts = [
      mkIdx("fresh", "2026-05-10", 5),
      mkIdx("stale", "2026-01-01", 5),
    ];
    const { tier1, tier2 } = partitionTiers(concepts, today, {
      maxConcepts: 20,
      maxAgeDays: 90,
    });
    expect(tier1.map((c) => c.slug)).toEqual(["fresh"]);
    expect(tier2.map((c) => c.slug)).toEqual(["stale"]);
  });

  it("demotes concepts with < 3 active claims to Tier 2", () => {
    const concepts = [
      mkIdx("dense", "2026-05-10", 5),
      mkIdx("sparse", "2026-05-10", 2),
    ];
    const { tier1, tier2 } = partitionTiers(concepts, today, {
      maxConcepts: 20,
      maxAgeDays: 90,
    });
    expect(tier1.map((c) => c.slug)).toEqual(["dense"]);
    expect(tier2.map((c) => c.slug)).toEqual(["sparse"]);
  });

  it("caps Tier 1 at maxConcepts; overflow goes to Tier 2", () => {
    const concepts = Array.from({ length: 25 }, (_, i) =>
      mkIdx(`c${i}`, `2026-05-${String((i % 28) + 1).padStart(2, "0")}`, 5),
    );
    const { tier1, tier2 } = partitionTiers(concepts, today, {
      maxConcepts: 20,
      maxAgeDays: 90,
    });
    expect(tier1).toHaveLength(20);
    expect(tier2).toHaveLength(5);
  });

  it("handles empty input", () => {
    const { tier1, tier2 } = partitionTiers([], "2026-05-18", { maxConcepts: 20, maxAgeDays: 90 });
    expect(tier1).toEqual([]);
    expect(tier2).toEqual([]);
  });
});

describe("renderIndex", () => {
  it("renders frontmatter + table", () => {
    const concepts = [
      mkIdx("a", "2026-05-10", 5),
      mkIdx("b", "2026-05-15", 3),
    ];
    const out = renderIndex(concepts, "2026-05-18T01:00:00Z");
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("roost_memory_index: true");
    expect(out).toContain("concept_count: 2");
    expect(out).toContain("active_claim_count: 8");
    expect(out).toContain("| Slug | Topic | Updated | Active | Summary |");
    expect(out).toContain("| a |");
    expect(out).toContain("| b |");
  });

  it("renders empty table when no concepts", () => {
    const out = renderIndex([], "2026-05-18T01:00:00Z");
    expect(out).toContain("concept_count: 0");
    expect(out).toContain("| Slug | Topic | Updated | Active | Summary |");
  });

  it("escapes pipe characters in name and summary", () => {
    const c = [mkIdx("x", "2026-05-10", 5)];
    c[0].name = "A|B|C";
    c[0].summary = "has | pipes";
    const out = renderIndex(c, "2026-05-18T01:00:00Z");
    expect(out).toContain("A\\|B\\|C");
    expect(out).toContain("has \\| pipes");
  });
});

describe("renderArchive", () => {
  it("renders archive frontmatter + table", () => {
    const concepts = [mkIdx("old", "2026-01-01", 1)];
    const out = renderArchive(concepts, "2026-05-18T01:00:00Z");
    expect(out).toContain("roost_memory_archive: true");
    expect(out).toContain("concept_count: 1");
    expect(out).toContain("| Slug | Topic | Updated | Active | Summary |");
    expect(out).toContain("| old |");
  });
});
