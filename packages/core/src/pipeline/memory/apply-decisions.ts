/**
 * Apply a ClaimNoveltyDecision to a parsed ConceptNode, returning a new
 * (immutable) ConceptNode. Updates frontmatter counts + lastUpdated +
 * sourceDigests in lockstep with the claim list mutation.
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §8.4.
 */
import type {
  ConceptNode,
  ClaimEntry,
  ClaimNoveltyDecision,
  Confidence,
  Relation,
} from "./schema";

export interface ApplyContext {
  weekId: string;     // YYYY-MM-DD (digest week start)
  source: string;     // vault-relative path of the originating bookmark
  sourceLabel?: string; // optional display text for [[path|label]] wikilink
  confidence: Confidence;
}

export function nextClaimId(c: ConceptNode): string {
  let maxN = 0;
  for (const claim of c.claims) {
    const m = claim.id.match(/^c([1-9][0-9]*)$/);
    if (m) {
      const n = Number(m[1]);
      if (n > maxN) maxN = n;
    }
  }
  return `c${maxN + 1}`;
}

function bumpFrontmatter(c: ConceptNode, weekId: string): ConceptNode {
  const sourceDigests = c.sourceDigests.includes(weekId)
    ? c.sourceDigests
    : [...c.sourceDigests, weekId];
  const activeClaimCount = c.claims.filter((x) => x.range.validTo === null).length;
  return {
    ...c,
    lastUpdated: weekId,
    claimCount: c.claims.length,
    activeClaimCount,
    sourceDigests,
  };
}

function appendSeenIn(claim: ClaimEntry, ctx: ApplyContext): ClaimEntry {
  const seenIn = claim.seenIn.includes(ctx.weekId)
    ? claim.seenIn
    : [...claim.seenIn, ctx.weekId];
  const sources = claim.sources.some((s) => s.path === ctx.source)
    ? claim.sources
    : [...claim.sources, { path: ctx.source, ...(ctx.sourceLabel ? { label: ctx.sourceLabel } : {}) }];
  return { ...claim, seenIn, sources };
}

function buildNewClaim(
  id: string,
  text: string,
  ctx: ApplyContext,
  relations: Relation[],
): ClaimEntry {
  return {
    id,
    range: { validFrom: ctx.weekId, validTo: null },
    relations,
    text,
    sources: [{ path: ctx.source, ...(ctx.sourceLabel ? { label: ctx.sourceLabel } : {}) }],
    logged: ctx.weekId,
    confidence: ctx.confidence,
    seenIn: [ctx.weekId],
  };
}

export function applyDecision(
  c: ConceptNode,
  decision: ClaimNoveltyDecision,
  ctx: ApplyContext,
): ConceptNode {
  if (decision.action === "add") {
    const newId = nextClaimId(c);
    const newClaim = buildNewClaim(newId, decision.claimText, ctx, decision.relations ?? []);
    const concept: ConceptNode = { ...c, claims: [...c.claims, newClaim] };
    return bumpFrontmatter(concept, ctx.weekId);
  }

  if (decision.action === "merge" || decision.action === "skip") {
    const updated = c.claims.map((cl) =>
      cl.id === decision.targetId ? appendSeenIn(cl, ctx) : cl,
    );
    return bumpFrontmatter({ ...c, claims: updated }, ctx.weekId);
  }

  // invalidate: mark target superseded + add new claim with supersedes relation.
  const newId = nextClaimId(c);
  const newRelations: Relation[] = [
    { type: "supersedes", targetId: decision.targetId },
    ...(decision.relations ?? []),
  ];
  const newClaim = buildNewClaim(newId, decision.newClaimText, ctx, newRelations);
  const forwardRel: Relation = { type: "supersedes", targetId: newId };
  const updated = c.claims.map((cl) => {
    if (cl.id !== decision.targetId) return cl;
    return {
      ...cl,
      range: { ...cl.range, validTo: ctx.weekId },
      relations: cl.relations.some((r) => r.type === "supersedes" && r.targetId === newId)
        ? cl.relations
        : [...cl.relations, forwardRel],
    };
  });
  return bumpFrontmatter({ ...c, claims: [...updated, newClaim] }, ctx.weekId);
}
