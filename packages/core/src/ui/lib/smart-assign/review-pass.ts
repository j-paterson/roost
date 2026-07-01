// packages/core/src/ui/lib/smart-assign/review-pass.ts
/** Pure helpers for the Smart Assign review pass. No Obsidian deps. */

/** All proposal item ids, ordered most-uncertain first (lowest score), stable otherwise.
 *  `score` returns a match confidence (higher = more confident); undefined sorts last. */
export function seedReviewIds(
  folders: { name: string; itemIds: string[] }[],
  score: (id: string) => number | undefined,
): string[] {
  const ids = folders.flatMap((f) => f.itemIds);
  return ids
    .map((id, i) => ({ id, i, s: score(id) }))
    .sort((a, b) => {
      const av = a.s ?? Infinity, bv = b.s ?? Infinity;
      return av !== bv ? av - bv : a.i - b.i; // lowest score first; stable
    })
    .map((x) => x.id);
}

/** Reorder a folder's ids so human-assigned (green) ids come after the rest,
 *  preserving input order within each group. */
export function greenLast(ids: string[], human: Set<string>): string[] {
  const blue = ids.filter((id) => !human.has(id));
  const green = ids.filter((id) => human.has(id));
  return [...blue, ...green];
}
