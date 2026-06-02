/**
 * Neighbor suggestion — after a user moves items between categories,
 * find similar items in the source group that might also belong in the target.
 */
import type { EmbeddingCacheEntry } from "@/types/roost";
import { cosineSimilarity, computeCentroid, fusedSimilarity } from "@/pipeline/shared";

export interface NeighborSuggestion {
  itemId: string;
  sourceGroupId: string;
  similarity: number; // similarity to target centroid
  delta: number;      // simToTarget - simToSource (positive = target is better fit)
}

export interface SuggestNeighborsOpts {
  movedItemIds: string[];
  sourceGroupItemIds: Record<string, string[]>; // groupId → remaining item IDs
  targetGroupItemIds: string[];                  // target group's items (after move)
  cache: Record<string, EmbeddingCacheEntry>;
  maxSuggestions?: number;
  minDelta?: number;
  clipFusionAlpha?: number;
}

/**
 * Find items in source groups that are closer to the target centroid
 * than their current source centroid. These are candidates for the same move.
 */
export function suggestNeighbors(opts: SuggestNeighborsOpts): NeighborSuggestion[] {
  const { movedItemIds, sourceGroupItemIds, targetGroupItemIds, cache } = opts;
  const max = opts.maxSuggestions ?? 20;
  const minDelta = opts.minDelta ?? 0.02;
  const alpha = opts.clipFusionAlpha ?? 0.5;

  const movedSet = new Set(movedItemIds);

  // Compute target centroid (including the moved items)
  const targetVecs = targetGroupItemIds.filter(id => cache[id]?.vec).map(id => cache[id].vec!);
  if (targetVecs.length === 0) return [];
  const targetCentroid = computeCentroid(targetVecs);

  // Compute target CLIP centroid
  const targetClipVecs = targetGroupItemIds.filter(id => cache[id]?.clipVec).map(id => cache[id].clipVec!);
  const targetClipCentroid = targetClipVecs.length > 0 ? computeCentroid(targetClipVecs) : null;

  const suggestions: NeighborSuggestion[] = [];

  for (const [groupId, itemIds] of Object.entries(sourceGroupItemIds)) {
    // Compute source centroid from remaining items
    const sourceVecs = itemIds.filter(id => cache[id]?.vec && !movedSet.has(id)).map(id => cache[id].vec!);
    if (sourceVecs.length === 0) continue;
    const sourceCentroid = computeCentroid(sourceVecs);

    // Compute source CLIP centroid from remaining items
    const sourceClipVecs = itemIds.filter(id => cache[id]?.clipVec && !movedSet.has(id)).map(id => cache[id].clipVec!);
    const sourceClipCentroid = sourceClipVecs.length > 0 ? computeCentroid(sourceClipVecs) : null;

    for (const itemId of itemIds) {
      if (movedSet.has(itemId)) continue;
      const vec = cache[itemId]?.vec;
      if (!vec) continue;
      const clipVec = cache[itemId]?.clipVec ?? null;

      const simToTarget = fusedSimilarity(vec, targetCentroid, clipVec, targetClipCentroid, alpha);
      const simToSource = fusedSimilarity(vec, sourceCentroid, clipVec, sourceClipCentroid, alpha);
      const delta = simToTarget - simToSource;

      if (delta > minDelta) {
        suggestions.push({ itemId, sourceGroupId: groupId, similarity: simToTarget, delta });
      }
    }
  }

  suggestions.sort((a, b) => b.delta - a.delta);
  return suggestions.slice(0, max);
}
