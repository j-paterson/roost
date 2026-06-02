import { describe, it, expect } from "vitest";
import { serializeConcept, parseConcept } from "../parser";
import type { ConceptNode } from "../schema";

function mkConcept(overrides: Partial<ConceptNode> = {}): ConceptNode {
  return {
    slug: "ai-agents",
    name: "AI agents and orchestration",
    summary: "Movement from tool-integrated assistants to outcome-driven workflows.",
    embedding: [0.1, 0.2, 0.3],
    created: "2026-04-26",
    lastUpdated: "2026-05-17",
    claimCount: 1,
    activeClaimCount: 1,
    related: [],
    sourceDigests: ["2026-04-26"],
    claims: [
      {
        id: "c1",
        range: { validFrom: "2026-04-26", validTo: null },
        relations: [],
        text: "agentic workflows are shifting from tool integration to outcome-driven execution",
        sources: [{ path: "Bookmarks/X/Unknown - 2050202786386563415" }],
        logged: "2026-04-26",
        confidence: "auto",
        seenIn: ["2026-04-26"],
      },
    ],
    ...overrides,
  };
}

describe("serializeConcept", () => {
  it("emits frontmatter with all 11 fields", () => {
    const out = serializeConcept(mkConcept());
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("type: concept");
    expect(out).toContain("slug: ai-agents");
    expect(out).toContain('name: "AI agents and orchestration"');
    expect(out).toContain('summary: "Movement from tool-integrated assistants to outcome-driven workflows."');
    expect(out).toContain("embedding: [0.1, 0.2, 0.3]");
    expect(out).toContain("created: 2026-04-26");
    expect(out).toContain("last_updated: 2026-05-17");
    expect(out).toContain("claim_count: 1");
    expect(out).toContain("active_claim_count: 1");
    expect(out).toContain("related: []");
    expect(out).toContain("source_digests: [2026-04-26]");
  });

  it("emits H1 with concept name", () => {
    const out = serializeConcept(mkConcept());
    expect(out).toContain("# AI agents and orchestration");
  });

  it("emits summary paragraph below H1", () => {
    const out = serializeConcept(mkConcept());
    expect(out).toContain(
      "Movement from tool-integrated assistants to outcome-driven workflows.",
    );
  });

  it("emits claim entry with default confidence omitted", () => {
    const out = serializeConcept(mkConcept());
    expect(out).toContain(
      "- **c1** · 2026-04-26 → present · agentic workflows are shifting from tool integration to outcome-driven execution",
    );
    expect(out).toContain(
      "Sources: [[Bookmarks/X/Unknown - 2050202786386563415]] · logged: 2026-04-26 · seen in: 2026-04-26 digest",
    );
    expect(out).not.toContain("confidence: auto");
  });

  it("emits confidence when non-default", () => {
    const c = mkConcept();
    c.claims[0].confidence = "medium";
    const out = serializeConcept(c);
    expect(out).toContain("logged: 2026-04-26 · confidence: medium · seen in:");
  });

  it("emits relations segment when claim has relations", () => {
    const c = mkConcept();
    c.claims[0].relations = [
      { type: "refines", targetId: "c1" },
      { type: "supports", targetId: "c2" },
    ];
    const out = serializeConcept(c);
    expect(out).toContain("· refines c1, supports c2 ·");
  });

  it("emits supersession range for invalidated claims", () => {
    const c = mkConcept();
    c.claims[0].range = { validFrom: "2026-04-26", validTo: "2026-05-10" };
    c.claims[0].relations = [{ type: "supersedes", targetId: "c3" }];
    const out = serializeConcept(c);
    expect(out).toContain("**c1** · 2026-04-26 → 2026-05-10 · supersedes c3 ·");
  });

  it("emits multiple seen-in digests joined with comma", () => {
    const c = mkConcept();
    c.claims[0].seenIn = ["2026-04-26", "2026-05-03"];
    const out = serializeConcept(c);
    expect(out).toContain("seen in: 2026-04-26, 2026-05-03 digests");
  });

  it("emits singular 'digest' for single seen-in", () => {
    const c = mkConcept();
    c.claims[0].seenIn = ["2026-04-26"];
    const out = serializeConcept(c);
    expect(out).toContain("seen in: 2026-04-26 digest");
    // Specifically: the seen-in line should NOT use plural "digests".
    // (Frontmatter `source_digests:` legitimately contains "digests" — that's a different field.)
    expect(out).not.toMatch(/seen in:[^\n]*digests/);
  });

  it("emits source_digests as a plural key with array", () => {
    const out = serializeConcept(mkConcept());
    expect(out).toContain("source_digests: [2026-04-26]");
  });

  it("escapes double quotes in name field", () => {
    const c = mkConcept({ name: 'AI "agents"' });
    const out = serializeConcept(c);
    expect(out).toContain('name: "AI \\"agents\\""');
  });

  it("escapes newlines and tabs in name/summary", () => {
    const c = mkConcept({ name: "Line one\nLine two", summary: "Has\ttab" });
    const out = serializeConcept(c);
    expect(out).toContain('name: "Line one\\nLine two"');
    expect(out).toContain('summary: "Has\\ttab"');
    // Ensure no literal newline made it into the YAML scalar (which would break parsing).
    const nameLine = out.split("\n").find((l) => l.startsWith("name:"));
    expect(nameLine).toBe('name: "Line one\\nLine two"');
  });

  it("emits empty embedding as []", () => {
    const c = mkConcept({ embedding: [] });
    const out = serializeConcept(c);
    expect(out).toContain("embedding: []");
  });
});

describe("parseConcept", () => {
  it("round-trips a serialized concept", () => {
    const original = mkConcept();
    const serialized = serializeConcept(original);
    const parsed = parseConcept(serialized);
    expect(parsed).toEqual(original);
  });

  it("parses 3-part claim headers (no relations)", () => {
    const c = mkConcept();
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].relations).toEqual([]);
    expect(parsed?.claims[0].text).toBe(c.claims[0].text);
  });

  it("parses 4-part claim headers (with relations)", () => {
    const c = mkConcept();
    c.claims[0].relations = [
      { type: "refines", targetId: "c1" },
      { type: "contradicts", targetId: "c2" },
    ];
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].relations).toEqual(c.claims[0].relations);
  });

  it("parses invalidated claim with valid_to date", () => {
    const c = mkConcept();
    c.claims[0].range = { validFrom: "2026-04-26", validTo: "2026-05-10" };
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].range).toEqual({
      validFrom: "2026-04-26",
      validTo: "2026-05-10",
    });
  });

  it("parses confidence field when present", () => {
    const c = mkConcept();
    c.claims[0].confidence = "high";
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].confidence).toBe("high");
  });

  it("defaults confidence to 'auto' when field is absent", () => {
    const c = mkConcept();
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].confidence).toBe("auto");
  });

  it("returns null for invalid frontmatter", () => {
    expect(parseConcept("no frontmatter here")).toBeNull();
    expect(parseConcept("---\ntype: not-concept\n---\n")).toBeNull();
  });

  it("parses concept with multiple claims preserving order", () => {
    const c = mkConcept();
    c.claims = [
      c.claims[0],
      {
        id: "c2",
        range: { validFrom: "2026-05-03", validTo: null },
        relations: [{ type: "refines", targetId: "c1" }],
        text: "second claim",
        sources: [{ path: "Bookmarks/X/foo" }],
        logged: "2026-05-03",
        confidence: "auto",
        seenIn: ["2026-05-03"],
      },
    ];
    c.claimCount = 2;
    c.activeClaimCount = 2;
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims).toHaveLength(2);
    expect(parsed?.claims.map((x) => x.id)).toEqual(["c1", "c2"]);
  });

  it("round-trips escaped newlines and tabs in name/summary", () => {
    const c = mkConcept({ name: "Line\nbreak", summary: "Tab\there" });
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.name).toBe("Line\nbreak");
    expect(parsed?.summary).toBe("Tab\there");
  });

  it("round-trips empty embedding", () => {
    const c = mkConcept({ embedding: [] });
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.embedding).toEqual([]);
  });

  it("round-trips empty related array", () => {
    const c = mkConcept({ related: [] });
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.related).toEqual([]);
  });

  it("round-trips multi-source claim", () => {
    const c = mkConcept();
    c.claims[0].sources = [{ path: "Bookmarks/X/a" }, { path: "Bookmarks/X/b" }];
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].sources).toEqual([{ path: "Bookmarks/X/a" }, { path: "Bookmarks/X/b" }]);
  });

  it("round-trips sources with display labels (Obsidian [[path|label]] form)", () => {
    const c = mkConcept();
    c.claims[0].sources = [
      { path: "Bookmarks/X/Unknown - 12345", label: "@uzairansar — Hermes Agent on M1" },
      { path: "Bookmarks/X/Unknown - 67890" }, // mixed: one labeled, one not
    ];
    const md = serializeConcept(c);
    expect(md).toContain("[[Bookmarks/X/Unknown - 12345|@uzairansar — Hermes Agent on M1]]");
    expect(md).toContain("[[Bookmarks/X/Unknown - 67890]]");
    const parsed = parseConcept(md);
    expect(parsed?.claims[0].sources).toEqual([
      { path: "Bookmarks/X/Unknown - 12345", label: "@uzairansar — Hermes Agent on M1" },
      { path: "Bookmarks/X/Unknown - 67890" },
    ]);
  });

  it("round-trips a concept with empty claims (all superseded scenario)", () => {
    const c = mkConcept({ claims: [], claimCount: 0, activeClaimCount: 0 });
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims).toEqual([]);
    expect(parsed?.claimCount).toBe(0);
    expect(parsed?.activeClaimCount).toBe(0);
  });

  it("round-trips a concept with a fully-superseded claim still present", () => {
    const c = mkConcept();
    c.claims[0].range = { validFrom: "2026-04-26", validTo: "2026-05-10" };
    c.activeClaimCount = 0;
    const md = serializeConcept(c);
    const parsed = parseConcept(md);
    expect(parsed?.claims).toHaveLength(1);
    expect(parsed?.claims[0].range.validTo).toBe("2026-05-10");
    expect(parsed?.activeClaimCount).toBe(0);
  });
});

describe("serializeConcept invariants", () => {
  it("throws when claim text contains the reserved ' · ' separator", () => {
    const c = mkConcept();
    c.claims[0].text = "this contains · the separator";
    expect(() => serializeConcept(c)).toThrow(/reserved separator/);
  });
  it("throws when concept name contains the reserved ' · ' separator", () => {
    expect(() => serializeConcept(mkConcept({ name: "name · with separator" })))
      .toThrow(/reserved separator/);
  });
});
