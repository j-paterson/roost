/**
 * Cache file at Memory/.roost-memory-cache.json.
 *
 * Two-section memoization: (a) claim novelty decisions keyed by
 * sha256(claim.text + " " + source), (b) cluster-routing decisions keyed by
 * sha256(headline + " " + centroid fingerprint).
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §8.5.
 */
import { createHash } from "crypto";
import type { ClaimNoveltyDecision } from "./schema";

const CURRENT_SCHEMA_VERSION = 1;

export interface ClaimDecisionEntry {
  targetSlug: string;
  decision: ClaimNoveltyDecision;
  conceptFileHash: string;
  timestamp: string;
  similarity: number;
}

export interface ConceptRoutingEntry {
  targetSlug: string;
  isNewConcept: boolean;
  timestamp: string;
  similarity: number;
}

export interface MemoryCache {
  schemaVersion: number;
  claimDecisions: Record<string, ClaimDecisionEntry>;
  conceptRoutings: Record<string, ConceptRoutingEntry>;
}

export function emptyCache(): MemoryCache {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    claimDecisions: {},
    conceptRoutings: {},
  };
}

export function parseCache(json: string): MemoryCache {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === CURRENT_SCHEMA_VERSION &&
      typeof parsed.claimDecisions === "object" &&
      parsed.claimDecisions !== null &&
      typeof parsed.conceptRoutings === "object" &&
      parsed.conceptRoutings !== null
    ) {
      return parsed as MemoryCache;
    }
  } catch {
    // fall through
  }
  return emptyCache();
}

export function serializeCache(c: MemoryCache): string {
  return JSON.stringify(c, null, 2);
}

export function computeClaimHash(text: string, source: string): string {
  return createHash("sha256").update(`${text} ${source}`).digest("hex");
}

export function computeConceptHash(fileContent: string): string {
  return createHash("sha256").update(fileContent).digest("hex");
}

/**
 * Hash a cluster routing decision input. Rounds centroid to 6 decimal
 * places to keep the hash stable against tiny floating-point drift from
 * embedding recomputation.
 */
export function computeClusterRoutingHash(headline: string, centroid: number[]): string {
  return createHash("sha256")
    .update(headline)
    .update(" ")
    .update(centroid.map((n) => n.toFixed(6)).join(","))
    .digest("hex");
}
