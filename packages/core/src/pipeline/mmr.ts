/**
 * Maximal Marginal Relevance (MMR) diversity-based reranking.
 *
 * Given a list of items with embeddings, returns up to targetCount items
 * that balance "close to the cluster centroid" (relevance) with "different
 * from already-selected items" (diversity). λ controls the tradeoff:
 *   λ=1.0 → pure relevance (closest to centroid)
 *   λ=0.0 → pure diversity (spreads selection across input space)
 *   λ=0.7 → standard balance (default)
 *
 * Items without an embedding vector cannot participate in MMR; they are
 * appended to the result up to targetCount after MMR completes.
 */
import { cosineSimilarity, computeCentroid } from "@/pipeline/shared";

export interface MmrItem {
  vec: number[] | null;
}

export function mmrTrim<T extends MmrItem>(
  items: T[],
  targetCount: number,
  lambda: number = 0.7,
): T[] {
  if (items.length <= targetCount) return items;

  const withVec = items.filter((i) => i.vec && i.vec.length > 0);
  const noVec = items.filter((i) => !i.vec || i.vec.length === 0);

  if (withVec.length === 0) {
    return items.slice(0, targetCount);
  }

  // Relevance proxy: cosine similarity to the centroid of the full input set.
  const centroid = computeCentroid(withVec.map((i) => i.vec as number[]));

  // Score each item by relevance to the centroid.
  const relevance = new Map<T, number>();
  for (const item of withVec) {
    relevance.set(item, cosineSimilarity(item.vec as number[], centroid));
  }

  // Greedy MMR loop. Seed with the item most relevant to the centroid.
  const selected: T[] = [];
  const remaining = [...withVec].sort(
    (a, b) => (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0),
  );
  selected.push(remaining.shift() as T);

  while (selected.length < targetCount && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const rel = relevance.get(candidate) ?? 0;
      let maxSimToSelected = -Infinity;
      for (const s of selected) {
        const sim = cosineSimilarity(
          candidate.vec as number[],
          s.vec as number[],
        );
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const score = lambda * rel - (1 - lambda) * maxSimToSelected;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0] as T);
  }

  // Fill remaining slots with no-vec items in insertion order.
  if (selected.length < targetCount && noVec.length > 0) {
    const slotsLeft = targetCount - selected.length;
    selected.push(...noVec.slice(0, slotsLeft));
  }

  return selected;
}
