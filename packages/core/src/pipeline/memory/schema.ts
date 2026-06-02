/**
 * Schema types and validators for the Roost agent-memory knowledge graph.
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §§5, 7, 9.
 */

export type RelationType = "supports" | "refines" | "contradicts" | "supersedes";

export interface Relation {
  type: RelationType;
  targetId: string; // "cN"
}

export interface BitemporalRange {
  /** YYYY-MM-DD. */
  validFrom: string;
  /** YYYY-MM-DD, or null for currently-active claims. */
  validTo: string | null;
}

export type Confidence = "auto" | "medium" | "high";

/** A source citation on a claim. Serialized as [[path]] or [[path|label]].
 *  Label is the human-readable display text Obsidian shows; the path is
 *  what the wikilink resolves to. */
export interface ClaimSource {
  path: string;
  label?: string;
}

export interface ClaimEntry {
  id: string;             // "cN"
  range: BitemporalRange;
  relations: Relation[];  // empty array when none
  text: string;
  sources: ClaimSource[]; // rendered as [[path]] or [[path|label]]
  logged: string;         // YYYY-MM-DD
  confidence: Confidence; // default "auto"
  seenIn: string[];       // YYYY-MM-DD digest week-start strings
}

export interface ConceptNode {
  slug: string;
  name: string;
  summary: string;
  embedding: number[];
  created: string;
  lastUpdated: string;
  claimCount: number;
  activeClaimCount: number;
  related: string[];
  sourceDigests: string[];
  claims: ClaimEntry[];
}

// ── Validators ──

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLAIM_ID_RE = /^c[1-9][0-9]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2}|present)$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function isValidClaimId(s: string): boolean {
  return CLAIM_ID_RE.test(s);
}

export function isValidDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y
    && dt.getUTCMonth() === m - 1
    && dt.getUTCDate() === d;
}

export function parseBitemporalRange(s: string): BitemporalRange | null {
  const m = s.match(RANGE_RE);
  if (!m) return null;
  const validFrom = m[1];
  const validToRaw = m[2];
  if (!isValidDateString(validFrom)) return null;
  if (validToRaw === "present") {
    return { validFrom, validTo: null };
  }
  if (!isValidDateString(validToRaw)) return null;
  if (validToRaw < validFrom) return null;
  return { validFrom, validTo: validToRaw };
}

export function formatBitemporalRange(r: BitemporalRange): string {
  return `${r.validFrom} → ${r.validTo ?? "present"}`;
}

// ── Decision result types (consumed by concept-router and claim-novelty) ──

export type ConceptRouterDecision =
  | { action: "attach"; slug: string; rationale: string }
  | { action: "create_new"; suggestedSlug: string; aliases: string[]; rationale: string };

export type ClaimNoveltyDecision =
  | { action: "add"; claimText: string; relations?: Relation[]; rationale: string }
  | { action: "merge"; targetId: string; rationale: string }
  | { action: "invalidate"; targetId: string; newClaimText: string; relations?: Relation[]; rationale: string }
  | { action: "skip"; targetId: string; rationale: string };
