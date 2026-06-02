import type { EmbeddingCacheEntry } from "@/types/roost";

export interface SuggestedTopic {
  name: string;
  count: number;
}

export interface AggregateOpts {
  minCount: number;
  topN: number;
  existingTopics: string[];
}

/**
 * Aggregate item LLM categories into ranked topic suggestions.
 * Pure function: no side effects, no I/O.
 *
 * Pipeline:
 *   1. Read cache[id]?.category for each id; skip null/empty.
 *   2. Normalize: trim whitespace, strip trailing punctuation (.).
 *   3. Aggregate counts case-insensitively. Display name = the most-common
 *      original casing (ties broken by first-encountered).
 *   4. Filter out names that match (case-insensitive) any in existingTopics.
 *   5. Drop entries with count < minCount.
 *   6. Sort by count desc, name asc.
 *   7. Take top topN.
 */
export function aggregateSuggestedTopics(
  itemIds: string[],
  cache: Record<string, EmbeddingCacheEntry>,
  opts: AggregateOpts,
): SuggestedTopic[] {
  const buckets = new Map<string, { count: number; casings: Map<string, number> }>();
  const existingLower = new Set(opts.existingTopics.map((t) => t.toLowerCase()));

  for (const id of itemIds) {
    const raw = cache[id]?.category;
    if (!raw) continue;
    const normalized = raw.trim().replace(/\.+$/, "").trim();
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (existingLower.has(lower)) continue;
    let bucket = buckets.get(lower);
    if (!bucket) {
      bucket = { count: 0, casings: new Map() };
      buckets.set(lower, bucket);
    }
    bucket.count++;
    bucket.casings.set(normalized, (bucket.casings.get(normalized) ?? 0) + 1);
  }

  const out: SuggestedTopic[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < opts.minCount) continue;
    let bestName = "";
    let bestCount = -1;
    for (const [name, count] of bucket.casings) {
      if (count > bestCount) {
        bestCount = count;
        bestName = name;
      }
    }
    out.push({ name: bestName, count: bucket.count });
  }

  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out.slice(0, opts.topN);
}
