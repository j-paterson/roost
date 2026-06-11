import type { EmbeddingCacheEntry } from "@/types/roost";
import { computeCentroid, cosineSimilarity } from "@/pipeline/shared";

export const CENTROID_DEDUP_THRESHOLD = 0.90;

/**
 * Merge near-duplicate discovered categories by centroid similarity.
 * Larger categories absorb smaller ones whose centroid cosine-similarity is
 * >= threshold. Mutates the surviving entries' `itemIds` in place (callers rely
 * on identity) and returns the surviving subset plus a count + log lines.
 * Pure: depends only on the embedding vectors in `cache`.
 */
export function dedupDiscoveredByCentroid<T extends { name: string; itemIds: string[] }>(
  discovered: T[],
  cache: Record<string, EmbeddingCacheEntry>,
  threshold: number = CENTROID_DEDUP_THRESHOLD,
): { discovered: T[]; mergedCount: number; mergeLog: string[] } {
  if (discovered.length <= 1) return { discovered, mergedCount: 0, mergeLog: [] };

  type Entry = { d: T; centroid: number[] };
  const entries: Entry[] = [];
  for (const d of discovered) {
    const vecs = d.itemIds.map(id => cache[id]?.vec).filter((v): v is number[] => !!v);
    if (vecs.length === 0) { entries.push({ d, centroid: [] }); continue; }
    entries.push({ d, centroid: computeCentroid(vecs) });
  }
  entries.sort((a, b) => b.d.itemIds.length - a.d.itemIds.length);
  const merged = new Set<number>();
  const mergeLog: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (merged.has(i) || entries[i].centroid.length === 0) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (merged.has(j) || entries[j].centroid.length === 0) continue;
      const sim = cosineSimilarity(entries[i].centroid, entries[j].centroid);
      if (sim >= threshold) {
        const keeper = entries[i].d;
        const absorbed = entries[j].d;
        const before = keeper.itemIds.length;
        const seen = new Set(keeper.itemIds);
        for (const id of absorbed.itemIds) if (!seen.has(id)) keeper.itemIds.push(id);
        merged.add(j);
        mergeLog.push(
          `  merged ${absorbed.name} (${absorbed.itemIds.length}) → ${keeper.name} ` +
          `(${before}→${keeper.itemIds.length}, sim ${sim.toFixed(3)})`,
        );
      }
    }
  }
  if (merged.size === 0) return { discovered, mergedCount: 0, mergeLog: [] };
  return {
    discovered: entries.filter((_, i) => !merged.has(i)).map(e => e.d),
    mergedCount: merged.size,
    mergeLog,
  };
}
