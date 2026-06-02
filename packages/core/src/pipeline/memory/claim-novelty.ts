/**
 * Stage B — claim novelty detection. The embedding gate compares an
 * incoming claim's embedding to the target concept's active claims.
 * Routes to one of three decisions; the LLM judge in this file handles
 * the ambiguous band.
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §8.3.
 */
import { cosineSimilarity } from "@/pipeline/shared";
import type { ClaimEntry } from "./schema";

export interface NoveltyThresholds {
  redundantThreshold: number; // > this → SKIP (redundant)
  refineThreshold: number;    // > this AND <= redundant → LLM judge
}

export interface ClaimWithEmbedding extends ClaimEntry {
  embedding: number[];
}

interface ClaimMatch {
  id: string;
  similarity: number;
  text: string;
}

export type ClaimGateDecision =
  | { kind: "skip_redundant"; targetId: string; similarity: number }
  | { kind: "ambiguous"; topMatches: ClaimMatch[] }
  | { kind: "add"; similarity: number };

const TOP_K_FOR_LLM = 3;

/**
 * Stage B embedding gate. Filters out claims without embeddings (treats them
 * as non-comparable). Routes by top similarity:
 *
 *   - skip_redundant when top > redundantThreshold
 *   - ambiguous     when refineThreshold < top <= redundantThreshold
 *   - add           when top <= refineThreshold OR no comparable claims exist
 */
export function claimEmbeddingGateDecision(
  incomingEmbedding: number[],
  activeClaims: ClaimWithEmbedding[],
  thresholds: NoveltyThresholds,
): ClaimGateDecision {
  const candidates = activeClaims.filter((c) => c.embedding.length > 0);
  if (candidates.length === 0) {
    return { kind: "add", similarity: 0 };
  }

  const scored: ClaimMatch[] = candidates.map((c) => ({
    id: c.id,
    similarity: cosineSimilarity(incomingEmbedding, c.embedding),
    text: c.text,
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored[0];

  if (top.similarity > thresholds.redundantThreshold) {
    return { kind: "skip_redundant", targetId: top.id, similarity: top.similarity };
  }
  if (top.similarity <= thresholds.refineThreshold) {
    return { kind: "add", similarity: top.similarity };
  }
  return { kind: "ambiguous", topMatches: scored.slice(0, TOP_K_FOR_LLM) };
}

export type { ClaimMatch };

// ── LLM judge ──

import { ollamaGenerate, stripJsonFence } from "@/pipeline/shared";
import type { ClaimNoveltyDecision, Relation, RelationType } from "./schema";

export interface ActiveClaimSnapshot {
  id: string;
  text: string;
  validFrom: string;
}

export interface ClaimNoveltyInput {
  incomingClaim: string;
  incomingSource: string;
  conceptSummary: string;
  activeClaims: ActiveClaimSnapshot[];
}

const VALID_RELATION_TYPES: RelationType[] = ["supports", "refines", "contradicts", "supersedes"];

function isRelationType(s: string): s is RelationType {
  return (VALID_RELATION_TYPES as string[]).includes(s);
}

function parseRelations(raw: unknown, validIds: Set<string>): Relation[] {
  if (!Array.isArray(raw)) return [];
  const out: Relation[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const ro = r as Record<string, unknown>;
    if (
      typeof ro.type === "string" &&
      isRelationType(ro.type) &&
      ro.type !== "supersedes" && // supersedes is implicit in invalidate
      typeof ro.target_id === "string" &&
      validIds.has(ro.target_id)
    ) {
      out.push({ type: ro.type, targetId: ro.target_id });
    }
  }
  return out;
}

function buildPrompt(input: ClaimNoveltyInput): string {
  const activeBlock = input.activeClaims
    .map((c) => `{ "id": "${c.id}", "text": "${c.text}", "valid_from": "${c.validFrom}" }`)
    .join("\n");

  return `You are deciding what to do with a new claim arriving into an existing concept node of a knowledge graph.

Concept summary: "${input.conceptSummary}"

Incoming claim:
  "${input.incomingClaim}"
  Source: ${input.incomingSource}

Active claims in this concept:
${activeBlock || "(no existing claims)"}

Possible decisions:
- ADD — the claim adds new information not already represented. Add as a new entry.
- MERGE — the claim says essentially the same thing as an existing claim, just phrased differently. Reinforce by recording this digest as a source; don't add a new entry.
- INVALIDATE — the claim refines or contradicts an existing claim such that the older claim is no longer correct. Add the new claim AND mark the older one superseded.
- SKIP — too similar to add value AND doesn't refine or contradict. Existing claims remain accurate.

Rules:
- For INVALIDATE, the older claim must actually be wrong now, not just less detailed.
- For MERGE, pick the existing claim that the incoming claim most closely paraphrases.
- For ADD, optionally include relations (supports / refines / contradicts) to existing claims.
- Default to ADD when uncertain. Over-merging loses information; over-adding creates noise but doesn't lose it.

Respond with ONLY valid JSON (no markdown, no commentary). One of these shapes:

{"action":"add","claim_text":"<incoming claim text>","relations":[{"type":"supports|refines|contradicts","target_id":"cN"}],"rationale":"<short>"}
{"action":"merge","target_id":"<cN>","rationale":"<short>"}
{"action":"invalidate","target_id":"<cN>","new_claim_text":"<new phrasing>","rationale":"<short>"}
{"action":"skip","target_id":"<cN>","rationale":"<short>"}

Relations are optional; omit the field entirely if none apply.`;
}

function tryParseNoveltyOutput(
  raw: string,
  input: ClaimNoveltyInput,
): ClaimNoveltyDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const validIds = new Set(input.activeClaims.map((c) => c.id));

  if (obj.action === "add" && typeof obj.claim_text === "string" && typeof obj.rationale === "string") {
    const relations = parseRelations(obj.relations, validIds);
    return { action: "add", claimText: obj.claim_text, relations, rationale: obj.rationale };
  }
  if (obj.action === "merge" && typeof obj.target_id === "string" && typeof obj.rationale === "string") {
    if (!validIds.has(obj.target_id)) return null;
    return { action: "merge", targetId: obj.target_id, rationale: obj.rationale };
  }
  if (
    obj.action === "invalidate" &&
    typeof obj.target_id === "string" &&
    typeof obj.new_claim_text === "string" &&
    typeof obj.rationale === "string"
  ) {
    if (!validIds.has(obj.target_id)) return null;
    const relations = parseRelations(obj.relations, validIds);
    return {
      action: "invalidate",
      targetId: obj.target_id,
      newClaimText: obj.new_claim_text,
      relations,
      rationale: obj.rationale,
    };
  }
  if (obj.action === "skip" && typeof obj.target_id === "string" && typeof obj.rationale === "string") {
    if (!validIds.has(obj.target_id)) return null;
    return { action: "skip", targetId: obj.target_id, rationale: obj.rationale };
  }
  return null;
}

/**
 * Stage B LLM judge. Fires only when embedding gate returns "ambiguous".
 * Returns one of 4 actions. Fallback on malformed output is ADD with the
 * incoming claim text — over-adding is recoverable noise.
 */
export async function runClaimNoveltyJudge(
  input: ClaimNoveltyInput,
  opts: { model?: string } = {},
): Promise<ClaimNoveltyDecision> {
  const raw = await ollamaGenerate(buildPrompt(input), {
    model: opts.model,
    numPredict: 200,
    numCtx: 2048,
    temperature: 0,
  });
  const parsed = tryParseNoveltyOutput(raw, input);
  if (parsed) return parsed;
  return {
    action: "add",
    claimText: input.incomingClaim,
    relations: [],
    rationale: "fallback: LLM output unparseable",
  };
}
