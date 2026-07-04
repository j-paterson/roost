/**
 * Sync extent axis. Leaf module — no imports from platform sync fns or the
 * registry (invariant #1: avoid runtime import cycles).
 *
 * - "quick": scroll from the top and stop at the first already-known item.
 *   New items are collected + fully enriched; existing items are not re-touched.
 * - "full": scroll to the end and drain the enrichment backlog (today's behavior).
 */
export type SyncMode = "quick" | "full";

/**
 * Resolve the *effective* mode. Quick only trusts the known-item boundary when a
 * prior sync completed, so it falls back to full on first-ever sync or after an
 * interrupted run.
 */
export function resolveSyncMode(
  requested: SyncMode,
  hasPriorState: boolean,
  priorComplete: boolean,
): SyncMode {
  if (requested === "full") return "full";
  if (!hasPriorState) return "full";
  if (!priorComplete) return "full";
  return "quick";
}

/**
 * Given a reverse-chron batch (newest first), return the records to collect and
 * whether the previously-synced boundary was hit.
 * - full: collect all; never a boundary.
 * - quick: collect up to (excluding) the first known id; boundary = a known id was seen.
 */
export function sliceUntilKnown<T extends { id: string }>(
  batch: T[],
  known: Set<string>,
  mode: SyncMode,
): { collect: T[]; boundary: boolean } {
  if (mode === "full") return { collect: batch, boundary: false };
  const idx = batch.findIndex((r) => known.has(r.id));
  if (idx === -1) return { collect: batch, boundary: false };
  return { collect: batch.slice(0, idx), boundary: true };
}
