import { describe, it, expect } from "vitest";
import { applyDecision, nextClaimId } from "../apply-decisions";
import type { ConceptNode, ClaimNoveltyDecision } from "../schema";

function mkConcept(): ConceptNode {
  return {
    slug: "x",
    name: "X",
    summary: "",
    embedding: [],
    created: "2026-04-26",
    lastUpdated: "2026-04-26",
    claimCount: 2,
    activeClaimCount: 2,
    related: [],
    sourceDigests: ["2026-04-26"],
    claims: [
      {
        id: "c1",
        range: { validFrom: "2026-04-26", validTo: null },
        relations: [],
        text: "old claim 1",
        sources: [{ path: "Bookmarks/X/a" }],
        logged: "2026-04-26",
        confidence: "auto",
        seenIn: ["2026-04-26"],
      },
      {
        id: "c2",
        range: { validFrom: "2026-04-26", validTo: null },
        relations: [],
        text: "old claim 2",
        sources: [{ path: "Bookmarks/X/b" }],
        logged: "2026-04-26",
        confidence: "auto",
        seenIn: ["2026-04-26"],
      },
    ],
  };
}

describe("nextClaimId", () => {
  it("returns c1 for empty concept", () => {
    const c = mkConcept();
    c.claims = [];
    expect(nextClaimId(c)).toBe("c1");
  });
  it("returns max+1 including superseded", () => {
    const c = mkConcept();
    c.claims[0].range.validTo = "2026-05-10";
    expect(nextClaimId(c)).toBe("c3");
  });
  it("returns max+1 across non-sequential IDs", () => {
    const c = mkConcept();
    c.claims[1].id = "c5";
    expect(nextClaimId(c)).toBe("c6");
  });
  it("skips malformed IDs when computing max", () => {
    const c = mkConcept();
    c.claims[0].id = "bogus";
    expect(nextClaimId(c)).toBe("c3");
  });
});

describe("applyDecision — ADD", () => {
  it("appends a new claim with next monotonic ID", () => {
    const c = mkConcept();
    const decision: ClaimNoveltyDecision = {
      action: "add",
      claimText: "brand new claim",
      relations: [],
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.claims).toHaveLength(3);
    expect(after.claims[2].id).toBe("c3");
    expect(after.claims[2].text).toBe("brand new claim");
    expect(after.claims[2].logged).toBe("2026-05-10");
    expect(after.claims[2].seenIn).toEqual(["2026-05-10"]);
    expect(after.claimCount).toBe(3);
    expect(after.activeClaimCount).toBe(3);
    expect(after.lastUpdated).toBe("2026-05-10");
    expect(after.sourceDigests).toContain("2026-05-10");
  });

  it("preserves relations on ADD", () => {
    const c = mkConcept();
    const decision: ClaimNoveltyDecision = {
      action: "add",
      claimText: "new",
      relations: [{ type: "supports", targetId: "c1" }],
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.claims[2].relations).toEqual([{ type: "supports", targetId: "c1" }]);
  });

  it("does not duplicate sourceDigests entries", () => {
    const c = mkConcept();
    c.sourceDigests = ["2026-05-10"]; // already present
    const decision: ClaimNoveltyDecision = {
      action: "add",
      claimText: "new",
      relations: [],
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.sourceDigests.filter((d) => d === "2026-05-10")).toHaveLength(1);
  });
});

describe("applyDecision — MERGE", () => {
  it("appends weekId to target claim's seenIn", () => {
    const c = mkConcept();
    const decision: ClaimNoveltyDecision = {
      action: "merge",
      targetId: "c1",
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.claims).toHaveLength(2);
    expect(after.claims[0].seenIn).toEqual(["2026-04-26", "2026-05-10"]);
    expect(after.claims[0].sources.some((s) => s.path === "Bookmarks/X/c")).toBe(true);
    expect(after.claimCount).toBe(2);
    expect(after.activeClaimCount).toBe(2);
  });

  it("does not duplicate weekId in seenIn if already present", () => {
    const c = mkConcept();
    c.claims[0].seenIn = ["2026-05-10"];
    const decision: ClaimNoveltyDecision = {
      action: "merge",
      targetId: "c1",
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.claims[0].seenIn).toEqual(["2026-05-10"]);
  });

  it("does not duplicate source if already present", () => {
    const c = mkConcept();
    c.claims[0].sources = [{ path: "Bookmarks/X/a" }, { path: "Bookmarks/X/c" }];
    const decision: ClaimNoveltyDecision = {
      action: "merge",
      targetId: "c1",
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.claims[0].sources.filter((s) => s.path === "Bookmarks/X/c")).toHaveLength(1);
  });
});

describe("applyDecision — INVALIDATE", () => {
  it("marks target superseded and adds new claim", () => {
    const c = mkConcept();
    const decision: ClaimNoveltyDecision = {
      action: "invalidate",
      targetId: "c1",
      newClaimText: "updated phrasing",
      relations: [{ type: "refines", targetId: "c2" }],
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    // c1 now invalidated
    expect(after.claims[0].range.validTo).toBe("2026-05-10");
    // c1 should have a forward marker pointing at the new claim
    expect(after.claims[0].relations.some((r) => r.type === "supersedes" && r.targetId === "c3")).toBe(true);
    // new c3 added with supersedes c1
    expect(after.claims).toHaveLength(3);
    const newClaim = after.claims[2];
    expect(newClaim.id).toBe("c3");
    expect(newClaim.text).toBe("updated phrasing");
    expect(newClaim.relations.some((r) => r.type === "supersedes" && r.targetId === "c1")).toBe(true);
    expect(newClaim.relations.some((r) => r.type === "refines" && r.targetId === "c2")).toBe(true);
    expect(after.activeClaimCount).toBe(2); // c2 + c3 active
    expect(after.claimCount).toBe(3);
  });
});

describe("applyDecision — SKIP", () => {
  it("appends weekId to target claim's seenIn (same as merge)", () => {
    const c = mkConcept();
    const decision: ClaimNoveltyDecision = {
      action: "skip",
      targetId: "c2",
      rationale: "x",
    };
    const after = applyDecision(c, decision, {
      weekId: "2026-05-10",
      source: "Bookmarks/X/c",
      confidence: "auto",
    });
    expect(after.claims[1].seenIn).toEqual(["2026-04-26", "2026-05-10"]);
    expect(after.activeClaimCount).toBe(2);
    expect(after.claimCount).toBe(2);
  });
});
