/**
 * Stage A — concept routing. The embedding gate is the cheap first pass:
 * cosine similarity of cluster centroid vs all existing concept embeddings,
 * then route to one of three decisions (attach / ambiguous / create_new).
 * The LLM judge in this file handles the ambiguous band.
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §8.2.
 */
import { cosineSimilarity, ollamaGenerate, stripJsonFence } from "@/pipeline/shared";
import type { ConceptNode, ConceptRouterDecision } from "./schema";

export interface RouterThresholds {
  matchThreshold: number;
  createThreshold: number;
}

interface CandidateScore {
  slug: string;
  similarity: number;
  concept: ConceptNode;
}

export type GateDecision =
  | { kind: "attach"; slug: string; similarity: number }
  | { kind: "ambiguous"; topCandidates: CandidateScore[] }
  | { kind: "create_new"; similarity: number };

const TOP_K_FOR_LLM = 5;

/**
 * Stage A embedding gate. Compares a cluster centroid against every existing
 * concept's embedding via cosine similarity. Returns one of three decisions:
 *
 *   - attach     when top similarity > matchThreshold (no LLM call)
 *   - ambiguous  when createThreshold < top similarity <= matchThreshold (LLM needed)
 *   - create_new when top similarity <= createThreshold (no LLM, just make new)
 *
 * Concepts with empty embeddings score 0 (so they don't trip an attach by
 * accident — they'd be near-zero compared to anything real anyway).
 */
export function embeddingGateDecision(
  centroid: number[],
  concepts: ConceptNode[],
  thresholds: RouterThresholds,
): GateDecision {
  if (concepts.length === 0) {
    return { kind: "create_new", similarity: 0 };
  }

  const scored: CandidateScore[] = concepts.map((c) => ({
    slug: c.slug,
    similarity:
      c.embedding.length > 0 ? cosineSimilarity(centroid, c.embedding) : 0,
    concept: c,
  }));
  scored.sort((a, b) => b.similarity - a.similarity);

  const top = scored[0];

  if (top.similarity > thresholds.matchThreshold) {
    return { kind: "attach", slug: top.slug, similarity: top.similarity };
  }
  if (top.similarity <= thresholds.createThreshold) {
    return { kind: "create_new", similarity: top.similarity };
  }
  return { kind: "ambiguous", topCandidates: scored.slice(0, TOP_K_FOR_LLM) };
}

export type { CandidateScore };

// ── LLM judge (Stage A, ambiguous-band only) ──

export interface ConceptCandidate {
  slug: string;
  name: string;
  summary: string;
  activeClaimCount: number;
}

export interface ConceptRouterInput {
  headline: string;
  summary: string;
  sampleClaims: string[];
  candidates: ConceptCandidate[];
}

/**
 * Derive a kebab-case slug from a headline. Used both for fallback when the
 * LLM judge fails AND for new-concept slug generation when below the
 * createThreshold band.
 */
export function slugFromHeadline(headline: string): string {
  const slug = headline
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return slug || "unknown-concept";
}

function buildPrompt(input: ConceptRouterInput): string {
  const candidatesBlock = input.candidates
    .map(
      (c, i) =>
        `Candidate ${i + 1}: { "slug": "${c.slug}", "name": "${c.name}", "summary": "${c.summary}", "active_claim_count": ${c.activeClaimCount} }`,
    )
    .join("\n");
  const sampleBlock = input.sampleClaims.length > 0
    ? input.sampleClaims.map((c) => `- ${c}`).join("\n")
    : "(no claims provided)";

  return `You are routing a new topic cluster into an existing knowledge graph of domain interests.

Incoming cluster:
  Headline: "${input.headline}"
  Summary: "${input.summary}"
  Sample claims:
${sampleBlock}

Candidate existing concepts:
${candidatesBlock || "(none)"}

Decide whether the incoming cluster (a) belongs to one of the candidate concepts (because it's the same domain interest), or (b) represents a meaningfully different concept that should get its own node.

Rules:
- "Belongs to" means the cluster's claims would all fit naturally as new claims under that concept's existing summary. A cluster that introduces a new sub-topic of an existing concept BELONGS TO it.
- "Different concept" means the cluster's central topic is distinct enough that mixing it in would muddy the existing concept.
- When unsure, prefer BELONGS TO over creating a new concept. Concept fragmentation degrades retrieval quality more than over-grouping.

Respond with ONLY valid JSON (no markdown, no commentary). Two shapes are valid:

For BELONGS TO:
{"action":"attach","slug":"<exact slug from a candidate>","rationale":"<short reason>"}

For DIFFERENT CONCEPT:
{"action":"create_new","suggested_slug":"<kebab-case>","aliases":["<surface form 1>","<surface form 2>"],"rationale":"<short reason>"}`;
}

function tryParseRouterOutput(
  raw: string,
  candidates: ConceptCandidate[],
): ConceptRouterDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.action === "attach") {
    if (typeof obj.slug !== "string" || typeof obj.rationale !== "string") return null;
    if (!candidates.some((c) => c.slug === obj.slug)) return null;
    return { action: "attach", slug: obj.slug, rationale: obj.rationale };
  }
  if (obj.action === "create_new") {
    if (typeof obj.suggested_slug !== "string" || typeof obj.rationale !== "string") return null;
    const aliases = Array.isArray(obj.aliases)
      ? (obj.aliases.filter((a) => typeof a === "string") as string[])
      : [];
    return {
      action: "create_new",
      suggestedSlug: obj.suggested_slug,
      aliases,
      rationale: obj.rationale,
    };
  }
  return null;
}

/**
 * Stage A LLM judge. Fires only when the embedding gate returns "ambiguous"
 * (similarity in the mid band). The judge picks an existing concept or
 * proposes a new one with suggested aliases.
 *
 * On any parse failure (malformed JSON, missing fields, slug not in
 * candidates), falls back to `create_new` with a slug derived from the
 * headline. Over-creating is recoverable noise; mis-attaching destroys
 * information.
 */
export async function runConceptRouterJudge(
  input: ConceptRouterInput,
  opts: { model?: string } = {},
): Promise<ConceptRouterDecision> {
  const raw = await ollamaGenerate(buildPrompt(input), {
    model: opts.model,
    numPredict: 200,
    numCtx: 2048,
    temperature: 0,
  });
  const parsed = tryParseRouterOutput(raw, input.candidates);
  if (parsed) return parsed;
  return {
    action: "create_new",
    suggestedSlug: slugFromHeadline(input.headline),
    aliases: [],
    rationale: "fallback: LLM output unparseable",
  };
}
