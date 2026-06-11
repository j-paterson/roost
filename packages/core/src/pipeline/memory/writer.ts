/**
 * Top-level entry point: writeClusterToMemory. Orchestrates Stage A (concept
 * routing) + Stage B (claim novelty) + atomic disk writes.
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §8.
 *
 * Per-cluster try/catch is the caller's responsibility (digest pipeline).
 * This function may throw; the caller logs and continues.
 */
import type { App } from "obsidian";
import { parseConcept, serializeConcept } from "./parser";
import type { ConceptNode, ClaimNoveltyDecision } from "./schema";
import {
  embeddingGateDecision,
  runConceptRouterJudge,
  slugFromHeadline,
} from "./concept-router";
import {
  claimEmbeddingGateDecision,
  runClaimNoveltyJudge,
  type ClaimWithEmbedding,
} from "./claim-novelty";
import { applyDecision } from "./apply-decisions";
import {
  parseAliases,
  serializeAliases,
  lookupAlias,
  addAliases,
  type AliasMap,
} from "./aliases";
import {
  parseCache,
  serializeCache,
  emptyCache,
  computeClaimHash,
  computeConceptHash,
  computeClusterRoutingHash,
  type MemoryCache,
} from "./cache";
import {
  partitionTiers,
  renderIndex,
  renderArchive,
  type IndexConcept,
} from "./index-writer";

const MEMORY_ROOT = "Memory";
const TOPICS_DIR = `${MEMORY_ROOT}/topics`;
const INDEX_PATH = `${MEMORY_ROOT}/MEMORY.md`;
const ARCHIVE_PATH = `${MEMORY_ROOT}/MEMORY-archive.md`;
const ALIASES_PATH = `${MEMORY_ROOT}/aliases.json`;
export const CACHE_PATH = `${MEMORY_ROOT}/.roost-memory-cache.json`;

const DEFAULT_THRESHOLDS = {
  conceptMatch: 0.75,
  conceptCreate: 0.55,
  claimRedundant: 0.92,
  claimRefine: 0.75,
};

const DEFAULT_INDEX_OPTS = { maxConcepts: 20, maxAgeDays: 90 };

export interface WriterClaim {
  text: string;
  sourceItemId: string;
  sourcePath: string;
  /** Optional display text for the source wikilink, e.g. "@uzairansar — title".
   *  When set, the memory file emits `[[path|label]]` instead of `[[path]]`. */
  sourceLabel?: string;
  embedding: number[];
}

export interface WriterCluster {
  bucket: string;
  headline: string;
  whyItMatters: string;
  centroid: number[];
  claims: WriterClaim[];
}

export interface WriterOptions {
  thresholds?: typeof DEFAULT_THRESHOLDS;
  indexOpts?: typeof DEFAULT_INDEX_OPTS;
  judgeModel?: string;
}

export type WriterResult =
  | { action: "created"; slug: string }
  | { action: "updated"; slug: string }
  | { action: "no-change"; slug: string };

// ── Filesystem helpers ──

async function readFileOrNull(app: App, path: string): Promise<string | null> {
  try {
    if (!(await app.vault.adapter.exists(path))) return null;
    return await app.vault.adapter.read(path);
  } catch {
    return null;
  }
}

async function writeFileAtomic(app: App, path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent && !(await app.vault.adapter.exists(parent))) {
    await app.vault.adapter.mkdir(parent);
  }
  await app.vault.adapter.write(tmp, content);
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.remove(path);
  }
  await app.vault.adapter.rename(tmp, path);
}

async function loadAllConcepts(app: App): Promise<ConceptNode[]> {
  if (!(await app.vault.adapter.exists(TOPICS_DIR))) return [];
  let listing: { files: string[]; folders: string[] };
  try {
    listing = await app.vault.adapter.list(TOPICS_DIR);
  } catch {
    return [];
  }
  const out: ConceptNode[] = [];
  for (const p of listing.files) {
    if (!p.endsWith(".md")) continue;
    const md = await readFileOrNull(app, p);
    if (!md) continue;
    const parsed = parseConcept(md);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── Stage A: route cluster to concept ──

async function routeCluster(
  cluster: WriterCluster,
  existing: ConceptNode[],
  aliases: AliasMap,
  cache: MemoryCache,
  judgeModel: string | undefined,
  thresholds: typeof DEFAULT_THRESHOLDS,
): Promise<{ targetSlug: string; isNew: boolean; aliasesToAdd: string[]; similarity: number }> {
  const routingHash = computeClusterRoutingHash(cluster.headline, cluster.centroid);
  const cached = cache.conceptRoutings[routingHash];
  if (cached) {
    return {
      targetSlug: cached.targetSlug,
      isNew: cached.isNewConcept,
      aliasesToAdd: [],
      similarity: cached.similarity,
    };
  }

  const aliased = lookupAlias(cluster.headline, aliases);
  if (aliased && existing.some((c) => c.slug === aliased)) {
    cache.conceptRoutings[routingHash] = {
      targetSlug: aliased,
      isNewConcept: false,
      timestamp: new Date().toISOString(),
      similarity: 1.0,
    };
    return { targetSlug: aliased, isNew: false, aliasesToAdd: [], similarity: 1.0 };
  }

  const gate = embeddingGateDecision(cluster.centroid, existing, {
    matchThreshold: thresholds.conceptMatch,
    createThreshold: thresholds.conceptCreate,
  });

  if (gate.kind === "attach") {
    cache.conceptRoutings[routingHash] = {
      targetSlug: gate.slug,
      isNewConcept: false,
      timestamp: new Date().toISOString(),
      similarity: gate.similarity,
    };
    return { targetSlug: gate.slug, isNew: false, aliasesToAdd: [], similarity: gate.similarity };
  }
  if (gate.kind === "create_new") {
    const slug = slugFromHeadline(cluster.headline);
    cache.conceptRoutings[routingHash] = {
      targetSlug: slug,
      isNewConcept: true,
      timestamp: new Date().toISOString(),
      similarity: gate.similarity,
    };
    return { targetSlug: slug, isNew: true, aliasesToAdd: [], similarity: gate.similarity };
  }

  // Ambiguous → LLM judge.
  const decision = await runConceptRouterJudge(
    {
      headline: cluster.headline,
      summary: cluster.whyItMatters,
      sampleClaims: cluster.claims.slice(0, 5).map((c) => c.text),
      candidates: gate.topCandidates.map((tc) => ({
        slug: tc.concept.slug,
        name: tc.concept.name,
        summary: tc.concept.summary,
        activeClaimCount: tc.concept.activeClaimCount,
      })),
    },
    { model: judgeModel },
  );

  const topSim = gate.topCandidates[0]?.similarity ?? 0;
  if (decision.action === "attach") {
    cache.conceptRoutings[routingHash] = {
      targetSlug: decision.slug,
      isNewConcept: false,
      timestamp: new Date().toISOString(),
      similarity: topSim,
    };
    return { targetSlug: decision.slug, isNew: false, aliasesToAdd: [], similarity: topSim };
  }
  cache.conceptRoutings[routingHash] = {
    targetSlug: decision.suggestedSlug,
    isNewConcept: true,
    timestamp: new Date().toISOString(),
    similarity: topSim,
  };
  return {
    targetSlug: decision.suggestedSlug,
    isNew: true,
    aliasesToAdd: decision.aliases,
    similarity: topSim,
  };
}

// ── Stage B: claim novelty ──

function activeClaimsWithEmbedding(c: ConceptNode): ClaimWithEmbedding[] {
  // v1: per-claim embeddings aren't persisted (only the concept-level one).
  // Empty embeddings force the gate down its no-comparable-claims branch
  // (returns `add`), so the `skip_redundant` / `ambiguous` branches in
  // decideClaim are reachable only once per-claim embeddings ship — for
  // now they're dead-but-correct. The idempotency guard above + the cache
  // replay below keep this from producing duplicate work.
  return c.claims
    .filter((cl) => cl.range.validTo === null)
    .map((cl) => ({ ...cl, embedding: [] }));
}

async function decideClaim(
  incoming: WriterClaim,
  concept: ConceptNode,
  cache: MemoryCache,
  conceptFileHash: string,
  judgeModel: string | undefined,
  thresholds: typeof DEFAULT_THRESHOLDS,
): Promise<ClaimNoveltyDecision> {
  // Idempotency guard: if this source is already recorded on any active
  // claim, skip — fires on re-runs even when the cache hash has changed.
  const alreadyRecorded = concept.claims.find(
    (cl) => cl.range.validTo === null && cl.sources.some((s) => s.path === incoming.sourcePath),
  );
  if (alreadyRecorded) {
    return { action: "skip", targetId: alreadyRecorded.id, rationale: "source already recorded (idempotency)" };
  }

  const hash = computeClaimHash(incoming.text, incoming.sourceItemId);
  const cached = cache.claimDecisions[hash];
  if (cached && cached.conceptFileHash === conceptFileHash) {
    return cached.decision;
  }

  const gate = claimEmbeddingGateDecision(incoming.embedding, activeClaimsWithEmbedding(concept), {
    redundantThreshold: thresholds.claimRedundant,
    refineThreshold: thresholds.claimRefine,
  });

  let decision: ClaimNoveltyDecision;
  let similarity = 0;
  if (gate.kind === "skip_redundant") {
    decision = { action: "skip", targetId: gate.targetId, rationale: "embedding-gate redundant" };
    similarity = gate.similarity;
  } else if (gate.kind === "add") {
    decision = {
      action: "add",
      claimText: incoming.text,
      relations: [],
      rationale: "embedding-gate net-new",
    };
    similarity = gate.similarity;
  } else {
    decision = await runClaimNoveltyJudge(
      {
        incomingClaim: incoming.text,
        incomingSource: incoming.sourcePath,
        conceptSummary: concept.summary,
        activeClaims: gate.topMatches.map((m) => {
          const active = concept.claims.find((c) => c.id === m.id);
          return { id: m.id, text: m.text, validFrom: active?.range.validFrom ?? "" };
        }),
      },
      { model: judgeModel },
    );
    similarity = gate.topMatches[0]?.similarity ?? 0;
  }

  cache.claimDecisions[hash] = {
    targetSlug: concept.slug,
    decision,
    conceptFileHash,
    timestamp: new Date().toISOString(),
    similarity,
  };
  return decision;
}

// ── Public entry ──

export async function writeClusterToMemory(
  app: App,
  cluster: WriterCluster,
  weekId: string,
  log: (msg: string) => void,
  opts: WriterOptions = {},
): Promise<WriterResult> {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const indexOpts = opts.indexOpts ?? DEFAULT_INDEX_OPTS;

  const allConcepts = await loadAllConcepts(app);
  const aliasesRaw = (await readFileOrNull(app, ALIASES_PATH)) ?? "{}";
  const aliases = parseAliases(aliasesRaw);
  const cacheRaw = (await readFileOrNull(app, CACHE_PATH)) ?? "";
  const cache = cacheRaw ? parseCache(cacheRaw) : emptyCache();

  const routing = await routeCluster(cluster, allConcepts, aliases, cache, opts.judgeModel, thresholds);
  const existingConcept = allConcepts.find((c) => c.slug === routing.targetSlug) ?? null;
  // Authoritative "is this a new concept": did we find it on disk? Don't trust
  // routing.isNew — a stale cache entry from a prior run can report "new" for
  // a concept that already exists.
  const isCreatingNew = existingConcept === null;
  let concept: ConceptNode = existingConcept ?? {
    slug: routing.targetSlug,
    name: cluster.headline,
    summary: cluster.whyItMatters,
    embedding: cluster.centroid,
    created: weekId,
    lastUpdated: weekId,
    claimCount: 0,
    activeClaimCount: 0,
    related: [],
    sourceDigests: [weekId],
    claims: [],
  };

  let newAliases = aliases;
  if (routing.aliasesToAdd.length > 0) {
    newAliases = addAliases(aliases, concept.slug, routing.aliasesToAdd);
  }

  const beforeSerialized = serializeConcept(concept);
  const conceptFileHash = computeConceptHash(beforeSerialized);
  let updated: ConceptNode = concept;
  for (const incoming of cluster.claims) {
    const decision = await decideClaim(incoming, updated, cache, conceptFileHash, opts.judgeModel, thresholds);
    updated = applyDecision(updated, decision, {
      weekId,
      source: incoming.sourcePath,
      sourceLabel: incoming.sourceLabel,
      confidence: "auto",
    });
  }

  const afterSerialized = serializeConcept(updated);
  // Content equality is the authoritative idempotency signal — if nothing
  // changed, skip all writes.
  const isNoop = afterSerialized === beforeSerialized && newAliases === aliases;
  if (isNoop) {
    if (cacheRaw !== serializeCache(cache)) {
      await writeFileAtomic(app, CACHE_PATH, serializeCache(cache));
    }
    return { action: "no-change", slug: routing.targetSlug };
  }

  // Stage C: write topic file first (so MEMORY.md never references a missing slug).
  const topicPath = `${TOPICS_DIR}/${routing.targetSlug}.md`;
  await writeFileAtomic(app, topicPath, afterSerialized);

  if (newAliases !== aliases) {
    await writeFileAtomic(app, ALIASES_PATH, serializeAliases(newAliases));
  }

  // Patch the in-memory concept list with the updated concept so we don't
  // re-walk Memory/topics/ from disk just to rebuild the index.
  const patched = allConcepts.filter((c) => c.slug !== updated.slug).concat([updated]);
  await writeIndexFiles(app, patched, weekId, indexOpts);

  await writeFileAtomic(app, CACHE_PATH, serializeCache(cache));

  const action = isCreatingNew ? "created" : "updated";
  log(`memory: ${action} ${routing.targetSlug} (similarity=${routing.similarity.toFixed(3)})`);
  return { action, slug: routing.targetSlug };
}

/** Render and write MEMORY.md + MEMORY-archive.md from the given concept set. */
async function writeIndexFiles(
  app: App,
  concepts: ConceptNode[],
  today: string,
  indexOpts: typeof DEFAULT_INDEX_OPTS,
): Promise<void> {
  const indexConcepts: IndexConcept[] = concepts.map((c) => ({
    slug: c.slug,
    name: c.name,
    summary: c.summary,
    lastUpdated: c.lastUpdated,
    activeClaimCount: c.activeClaimCount,
  }));
  const { tier2 } = partitionTiers(indexConcepts, today, indexOpts);
  const nowIso = new Date().toISOString();
  // MEMORY.md holds all concepts (full catalog for search / Obsidian graph).
  // MEMORY-archive.md holds the tier-2 subset that Hermes demotes from active routing.
  await writeFileAtomic(app, INDEX_PATH, renderIndex(indexConcepts, nowIso));
  await writeFileAtomic(app, ARCHIVE_PATH, renderArchive(tier2, nowIso));
}

/**
 * Rebuild only the MEMORY.md + MEMORY-archive.md from current concept files.
 * Used by Cmd+P "rebuild memory index". No LLM calls. Cheap.
 */
export async function rebuildIndexOnly(app: App, opts: WriterOptions = {}): Promise<void> {
  const indexOpts = opts.indexOpts ?? DEFAULT_INDEX_OPTS;
  const concepts = await loadAllConcepts(app);
  const today = new Date().toISOString().slice(0, 10);
  await writeIndexFiles(app, concepts, today, indexOpts);
}
