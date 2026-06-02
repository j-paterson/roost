import { describe, it, expect, afterEach } from "vitest";
import { embeddingGateDecision, runConceptRouterJudge, slugFromHeadline } from "../concept-router";
import type { ConceptNode } from "../schema";
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

const VEC_A = [1, 0, 0];
const VEC_B = [0, 1, 0];
const VEC_AB = [0.7, 0.7, 0]; // sim w/ A ≈ 0.7

function mkConcept(slug: string, embedding: number[]): ConceptNode {
  return {
    slug,
    name: slug,
    summary: "",
    embedding,
    created: "2026-04-26",
    lastUpdated: "2026-04-26",
    claimCount: 0,
    activeClaimCount: 0,
    related: [],
    sourceDigests: [],
    claims: [],
  };
}

describe("embeddingGateDecision", () => {
  const concepts = [
    mkConcept("ai-agents", VEC_A),
    mkConcept("llm-eval", VEC_B),
  ];

  it("returns attach when top similarity > matchThreshold", () => {
    const d = embeddingGateDecision(VEC_A, concepts, {
      matchThreshold: 0.75,
      createThreshold: 0.55,
    });
    expect(d.kind).toBe("attach");
    if (d.kind === "attach") {
      expect(d.slug).toBe("ai-agents");
      expect(d.similarity).toBeCloseTo(1, 5);
    }
  });

  it("returns ambiguous when similarity in (createThreshold, matchThreshold]", () => {
    const d = embeddingGateDecision(VEC_AB, concepts, {
      matchThreshold: 0.75,
      createThreshold: 0.55,
    });
    expect(d.kind).toBe("ambiguous");
  });

  it("returns create_new when top similarity <= createThreshold", () => {
    const orth = [0, 0, 1];
    const d = embeddingGateDecision(orth, concepts, {
      matchThreshold: 0.75,
      createThreshold: 0.55,
    });
    expect(d.kind).toBe("create_new");
  });

  it("returns create_new with similarity 0 when no concepts exist", () => {
    const d = embeddingGateDecision(VEC_A, [], {
      matchThreshold: 0.75,
      createThreshold: 0.55,
    });
    expect(d.kind).toBe("create_new");
    if (d.kind === "create_new") expect(d.similarity).toBe(0);
  });

  it("includes top-K candidates in ambiguous result for LLM input", () => {
    const d = embeddingGateDecision(VEC_AB, concepts, {
      matchThreshold: 0.75,
      createThreshold: 0.55,
    });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.topCandidates.length).toBeGreaterThan(0);
      expect(d.topCandidates[0].slug).toBeDefined();
      expect(d.topCandidates[0].similarity).toBeGreaterThan(0);
    }
  });

  it("skips concepts with empty embedding (returns similarity 0 for them, not NaN)", () => {
    const concepts2 = [
      mkConcept("with-emb", VEC_A),
      mkConcept("no-emb", []),
    ];
    const d = embeddingGateDecision(VEC_A, concepts2, {
      matchThreshold: 0.75,
      createThreshold: 0.55,
    });
    expect(d.kind).toBe("attach");
    if (d.kind === "attach") expect(d.slug).toBe("with-emb");
  });

  it("sorts top candidates by similarity descending", () => {
    const concepts2 = [
      mkConcept("low", [0.2, 0.2, 0.96]),    // far from VEC_AB
      mkConcept("mid", VEC_AB),               // exact match for headline = VEC_AB
      mkConcept("high", [0.7, 0.7, 0.1]),    // very close to VEC_AB
    ];
    const d = embeddingGateDecision(VEC_AB, concepts2, {
      matchThreshold: 1.1,    // force ambiguous so we can inspect ordering (> max cosine sim)
      createThreshold: 0.0,
    });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      const sims = d.topCandidates.map((c) => c.similarity);
      for (let i = 1; i < sims.length; i++) {
        expect(sims[i - 1]).toBeGreaterThanOrEqual(sims[i]);
      }
    }
  });
});

describe("slugFromHeadline", () => {
  it("kebab-cases lowercased headline", () => {
    expect(slugFromHeadline("AI Agents Move Beyond Tools")).toBe("ai-agents-move-beyond-tools");
  });
  it("collapses non-alphanumeric runs to single hyphens", () => {
    expect(slugFromHeadline("RLHF & PPO: a Survey")).toBe("rlhf-ppo-a-survey");
  });
  it("trims to first 5 words", () => {
    expect(slugFromHeadline("one two three four five six seven")).toBe("one-two-three-four-five");
  });
  it("strips leading/trailing hyphens", () => {
    expect(slugFromHeadline("--Hello world--")).toBe("hello-world");
  });
  it("returns 'unknown-concept' for empty input (guard against empty slug)", () => {
    expect(slugFromHeadline("")).toBe("unknown-concept");
  });
  it("returns 'unknown-concept' for whitespace-only input", () => {
    expect(slugFromHeadline("   ")).toBe("unknown-concept");
  });
});

describe("runConceptRouterJudge", () => {
  afterEach(() => __resetRequestUrlImpl());

  it("returns attach decision when LLM picks an existing concept", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"attach","slug":"ai-agents","rationale":"clear match"}'),
    );
    const out = await runConceptRouterJudge({
      headline: "AI Agents Take Off",
      summary: "...",
      sampleClaims: ["claim 1", "claim 2"],
      candidates: [
        { slug: "ai-agents", name: "AI agents", summary: "...", activeClaimCount: 5 },
      ],
    });
    expect(out.action).toBe("attach");
    if (out.action === "attach") expect(out.slug).toBe("ai-agents");
  });

  it("returns create_new decision when LLM proposes new concept", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        '{"action":"create_new","suggested_slug":"my-new-topic","aliases":["new topic","novel area"],"rationale":"distinct"}',
      ),
    );
    const out = await runConceptRouterJudge({
      headline: "Something New",
      summary: "...",
      sampleClaims: [],
      candidates: [],
    });
    expect(out.action).toBe("create_new");
    if (out.action === "create_new") {
      expect(out.suggestedSlug).toBe("my-new-topic");
      expect(out.aliases).toEqual(["new topic", "novel area"]);
    }
  });

  it("falls back to create_new from headline when LLM returns malformed JSON", async () => {
    __setRequestUrlImpl(async () => mkOllamaResponse("garbage non-json"));
    const out = await runConceptRouterJudge({
      headline: "Fallback Headline Test",
      summary: "",
      sampleClaims: [],
      candidates: [],
    });
    expect(out.action).toBe("create_new");
    if (out.action === "create_new") {
      expect(out.suggestedSlug).toBe("fallback-headline-test");
      expect(out.aliases).toEqual([]);
    }
  });

  it("falls back to create_new when LLM picks a slug not in candidates", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"attach","slug":"nonexistent","rationale":"x"}'),
    );
    const out = await runConceptRouterJudge({
      headline: "Existing Cluster",
      summary: "",
      sampleClaims: [],
      candidates: [{ slug: "real-slug", name: "real", summary: "", activeClaimCount: 1 }],
    });
    expect(out.action).toBe("create_new");
  });

  it("handles markdown code-fenced JSON output", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('```json\n{"action":"attach","slug":"x","rationale":"ok"}\n```'),
    );
    const out = await runConceptRouterJudge({
      headline: "",
      summary: "",
      sampleClaims: [],
      candidates: [{ slug: "x", name: "x", summary: "", activeClaimCount: 1 }],
    });
    expect(out.action).toBe("attach");
  });

  it("falls back when required fields are missing from JSON", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse('{"action":"attach","slug":"only-slug"}'), // missing rationale
    );
    const out = await runConceptRouterJudge({
      headline: "Test Headline",
      summary: "",
      sampleClaims: [],
      candidates: [{ slug: "only-slug", name: "only", summary: "", activeClaimCount: 1 }],
    });
    expect(out.action).toBe("create_new");
  });
});
