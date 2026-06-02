import { describe, it, expect } from "vitest";
import { claimEmbeddingGateDecision } from "../claim-novelty";
import type { ClaimEntry } from "../schema";

function mkClaim(id: string, embedding: number[]): ClaimEntry & { embedding: number[] } {
  return {
    id,
    range: { validFrom: "2026-04-26", validTo: null },
    relations: [],
    text: `text-${id}`,
    sources: [],
    logged: "2026-04-26",
    confidence: "auto",
    seenIn: ["2026-04-26"],
    embedding,
  };
}

describe("claimEmbeddingGateDecision", () => {
  const activeClaims = [
    mkClaim("c1", [1, 0, 0]),
    mkClaim("c2", [0, 1, 0]),
  ];

  it("returns skip_redundant when similarity > redundantThreshold", () => {
    const d = claimEmbeddingGateDecision(
      [1, 0, 0],
      activeClaims,
      { redundantThreshold: 0.92, refineThreshold: 0.75 },
    );
    expect(d.kind).toBe("skip_redundant");
    if (d.kind === "skip_redundant") expect(d.targetId).toBe("c1");
  });

  it("returns ambiguous when refineThreshold < similarity <= redundantThreshold", () => {
    // [0.8, 0.6, 0] has cosine similarity 0.8 vs c1=[1,0,0] — squarely in (0.75, 0.92]
    const d = claimEmbeddingGateDecision(
      [0.8, 0.6, 0],
      activeClaims,
      { redundantThreshold: 0.92, refineThreshold: 0.75 },
    );
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.topMatches.length).toBeGreaterThan(0);
      expect(d.topMatches[0].id).toBe("c1");
    }
  });

  it("returns add when similarity <= refineThreshold", () => {
    const d = claimEmbeddingGateDecision(
      [0, 0, 1],
      activeClaims,
      { redundantThreshold: 0.92, refineThreshold: 0.75 },
    );
    expect(d.kind).toBe("add");
  });

  it("returns add when no active claims exist", () => {
    const d = claimEmbeddingGateDecision(
      [1, 0, 0],
      [],
      { redundantThreshold: 0.92, refineThreshold: 0.75 },
    );
    expect(d.kind).toBe("add");
  });

  it("ignores claims with empty embedding", () => {
    const noEmb = { ...mkClaim("c3", []) };
    const d = claimEmbeddingGateDecision(
      [1, 0, 0],
      [noEmb, ...activeClaims],
      { redundantThreshold: 0.92, refineThreshold: 0.75 },
    );
    expect(d.kind).toBe("skip_redundant");
    if (d.kind === "skip_redundant") expect(d.targetId).toBe("c1");
  });

  it("sorts top matches by similarity descending", () => {
    const claims = [
      mkClaim("c1", [0.3, 0.3, 0.9]),    // far
      mkClaim("c2", [0.85, 0.15, 0]),    // near
      mkClaim("c3", [0.6, 0.4, 0]),      // mid
    ];
    const d = claimEmbeddingGateDecision(
      [0.85, 0.15, 0],
      claims,
      { redundantThreshold: 1.5, refineThreshold: 0.0 },  // force ambiguous
    );
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      const sims = d.topMatches.map((m) => m.similarity);
      for (let i = 1; i < sims.length; i++) {
        expect(sims[i - 1]).toBeGreaterThanOrEqual(sims[i]);
      }
    }
  });

  it("returns add when ALL active claims have empty embeddings", () => {
    const claims = [mkClaim("c1", []), mkClaim("c2", [])];
    const d = claimEmbeddingGateDecision(
      [1, 0, 0],
      claims,
      { redundantThreshold: 0.92, refineThreshold: 0.75 },
    );
    expect(d.kind).toBe("add");
  });
});

// ── LLM judge tests ──

import { afterEach } from "vitest";
import { runClaimNoveltyJudge } from "../claim-novelty";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";

function mkOllamaResponse(text: string): RequestUrlResponse {
  return {
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: { response: text, done: true },
    text: JSON.stringify({ response: text, done: true }),
  };
}

describe("runClaimNoveltyJudge", () => {
  afterEach(() => __resetRequestUrlImpl());

  const baseInput = {
    incomingClaim: "new claim text",
    incomingSource: "Bookmarks/X/twitter-1",
    conceptSummary: "concept summary",
    activeClaims: [
      { id: "c1", text: "existing claim 1", validFrom: "2026-04-26" },
      { id: "c2", text: "existing claim 2", validFrom: "2026-04-26" },
    ],
  };

  it("parses ADD decision", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"add","claim_text":"new claim text","rationale":"genuinely new"}'),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("add");
    if (d.action === "add") expect(d.claimText).toBe("new claim text");
  });

  it("parses MERGE decision", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"merge","target_id":"c1","rationale":"paraphrase"}'),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("merge");
    if (d.action === "merge") expect(d.targetId).toBe("c1");
  });

  it("parses INVALIDATE decision", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        '{"action":"invalidate","target_id":"c1","new_claim_text":"updated phrasing","rationale":"refinement"}',
      ),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("invalidate");
    if (d.action === "invalidate") {
      expect(d.targetId).toBe("c1");
      expect(d.newClaimText).toBe("updated phrasing");
    }
  });

  it("parses SKIP decision", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"skip","target_id":"c1","rationale":"too similar"}'),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.targetId).toBe("c1");
  });

  it("falls back to ADD on malformed JSON", async () => {
    __setRequestUrlImpl(async () => mkOllamaResponse("not json"));
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("add");
    if (d.action === "add") expect(d.claimText).toBe("new claim text");
  });

  it("falls back to ADD when MERGE references unknown target_id", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"merge","target_id":"c999","rationale":"x"}'),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("add");
  });

  it("parses relations array when present on ADD", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        '{"action":"add","claim_text":"x","relations":[{"type":"supports","target_id":"c1"}],"rationale":"r"}',
      ),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    if (d.action === "add") {
      expect(d.relations).toEqual([{ type: "supports", targetId: "c1" }]);
    }
  });

  it("filters out unknown relation types (keeps known ones)", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        '{"action":"add","claim_text":"x","relations":[{"type":"unrelates","target_id":"c1"},{"type":"refines","target_id":"c2"}],"rationale":"r"}',
      ),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    if (d.action === "add") {
      expect(d.relations ?? []).toEqual([{ type: "refines", targetId: "c2" }]);
    }
  });

  it("filters out 'supersedes' from emitted LLM relations (implicit in invalidate)", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        '{"action":"add","claim_text":"x","relations":[{"type":"supersedes","target_id":"c1"}],"rationale":"r"}',
      ),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    if (d.action === "add") {
      expect(d.relations ?? []).toEqual([]);
    }
  });

  it("handles markdown code-fenced JSON", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        '```json\n{"action":"merge","target_id":"c1","rationale":"ok"}\n```',
      ),
    );
    const d = await runClaimNoveltyJudge(baseInput);
    expect(d.action).toBe("merge");
  });
});
