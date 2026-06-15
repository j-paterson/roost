import type { MetadataCache } from "obsidian";
import { waitForMetadataQuiet } from "@/lib/metadata-cache-quiet";

/**
 * The minimal surface of RoostPlugin that the job wrapper needs. Kept tiny so
 * the wrapper is unit-testable against a fake without instantiating the full
 * plugin (and its heavy side-effect import graph).
 */
export interface BulkWriteHost {
  bulkWriteInProgress: boolean;
  fireDataRefresh(): void;
  app: { metadataCache: MetadataCache };
}

/**
 * Runs `fn` with `host.bulkWriteInProgress` set for its duration, then settles
 * the gallery exactly once when it finishes. This suppresses per-write gallery
 * rebuilds while a heavy job (sync, backfills, pipeline runs) writes many notes:
 * the Bases view guards onDataUpdated on this flag and shows an "Updating items…"
 * overlay.
 *
 * `wasOn` keeps this nesting-safe: if an outer scope (e.g. Smart Assign) already
 * owns the flag, we don't clobber it — the outer scope settles the view.
 */
export async function runJobWithBulkWriteFlag<T>(
  host: BulkWriteHost,
  fn: () => Promise<T>,
): Promise<T> {
  const wasOn = host.bulkWriteInProgress;
  if (!wasOn) host.bulkWriteInProgress = true;
  try {
    return await fn();
  } finally {
    if (!wasOn) {
      // Let the last batch of frontmatter writes settle, then drop the flag and
      // trigger exactly one rebuild with the final entry set.
      await waitForMetadataQuiet(host.app.metadataCache);
      host.bulkWriteInProgress = false;
      host.fireDataRefresh();
    }
  }
}
