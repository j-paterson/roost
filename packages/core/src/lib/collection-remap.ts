import { cosineSimilarity, computeCentroid } from "@/pipeline/shared";
import { makeAliasKey, type CollectionAliasMap } from "@/lib/collection-aliases";

/** A source grouping (TikTok collection / X folder) plus its members' embeddings. */
export interface CollectionInput {
  platform: string;
  name: string;
  memberVecs: number[][];
}

/** An existing Roost category and its centroid. */
export interface CategoryCentroid {
  name: string;
  centroid: number[];
}

export type RemapAction = "map" | "create" | "skip";

export interface MappingSuggestion {
  platform: string;
  collection: string;
  action: RemapAction;
  /** Category name: an existing category for "map"/"skip", the collection's own name for "create". */
  target: string;
  /** Top cosine similarity, or null when not computed (skip / no vectors / no categories). */
  sim: number | null;
}

/**
 * For each incoming collection, suggest mapping it onto an existing category (top
 * member-centroid similarity >= threshold), creating a new category named after the
 * collection, or skipping it (already aliased). Pure — no vault access.
 */
export function suggestCollectionMappings(
  collections: CollectionInput[],
  categories: CategoryCentroid[],
  existing: CollectionAliasMap,
  threshold: number,
): MappingSuggestion[] {
  return collections.map((c) => {
    const base = { platform: c.platform, collection: c.name };
    const key = makeAliasKey(c.platform, c.name);
    if (existing[key]) {
      return { ...base, action: "skip" as const, target: existing[key], sim: null };
    }
    if (c.memberVecs.length === 0 || categories.length === 0) {
      return { ...base, action: "create" as const, target: c.name, sim: null };
    }
    const centroid = computeCentroid(c.memberVecs);
    let best = { name: c.name, sim: -Infinity };
    for (const cat of categories) {
      const sim = cosineSimilarity(centroid, cat.centroid);
      if (sim > best.sim) best = { name: cat.name, sim };
    }
    return best.sim >= threshold
      ? { ...base, action: "map" as const, target: best.name, sim: best.sim }
      : { ...base, action: "create" as const, target: c.name, sim: best.sim };
  });
}

/** A user-confirmed mapping to persist (skips are simply not included). */
export interface ResolvedMapping {
  platform: string;
  collection: string;
  target: string;
}

/** Return a new alias map with the resolved mappings merged in (input untouched). */
export function applyResolvedMappings(
  map: CollectionAliasMap,
  resolved: ResolvedMapping[],
): CollectionAliasMap {
  const next: CollectionAliasMap = { ...map };
  for (const r of resolved) next[makeAliasKey(r.platform, r.collection)] = r.target;
  return next;
}

/**
 * Plain-mean centroid per category from members present in the embedding cache.
 * Categories with no cached members are dropped. `cache` is any record whose values
 * carry a `vec: number[]` (the EmbeddingCacheEntry shape).
 */
export function buildCategoryCentroids(
  categories: Record<string, string[]>,
  cache: Record<string, { vec: number[] | null }>,
): CategoryCentroid[] {
  const out: CategoryCentroid[] = [];
  for (const [name, ids] of Object.entries(categories)) {
    const vecs = ids.map((id) => cache[id]?.vec).filter((v): v is number[] => Array.isArray(v));
    if (vecs.length) out.push({ name, centroid: computeCentroid(vecs) });
  }
  return out;
}
