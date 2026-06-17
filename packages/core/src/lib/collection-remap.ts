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
