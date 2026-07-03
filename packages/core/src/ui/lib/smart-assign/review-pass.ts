// packages/core/src/ui/lib/smart-assign/review-pass.ts
/** Pure helpers for the Smart Assign review pass. No Obsidian deps. */

/** Order the proposal ids to match the gallery's display order (the single source of truth).
 *  Proposals present in `gridOrder` come first in that order; any not currently in the grid are
 *  appended, preserving their input order. Falls back to the proposal order when `gridOrder` is
 *  empty (grid not yet built). */
export function orderReviewIdsByGrid(gridOrder: string[], proposalIds: string[]): string[] {
  const proposals = new Set(proposalIds);
  const ordered = gridOrder.filter((id) => proposals.has(id));
  const seen = new Set(ordered);
  const missing = proposalIds.filter((id) => !seen.has(id));
  return [...ordered, ...missing];
}

/** Reorder a folder's ids so human-assigned (green) ids come after the rest,
 *  preserving input order within each group. */
export function greenLast(ids: string[], human: Set<string>): string[] {
  const blue = ids.filter((id) => !human.has(id));
  const green = ids.filter((id) => human.has(id));
  return [...blue, ...green];
}
