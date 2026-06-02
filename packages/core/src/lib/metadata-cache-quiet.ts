import type { MetadataCache } from "obsidian";

export interface WaitForMetadataQuietOpts {
  /** Milliseconds of silence on changed/resolved before resolving. Default 150. */
  quietMs?: number;
  /** Hard cap so we never hang forever. Default 10_000. */
  timeoutMs?: number;
}

/**
 * Resolves once the metadata cache stops emitting changed/resolved events for
 * `quietMs`, or when `timeoutMs` elapses — whichever comes first.
 *
 * Used under bulkWriteInProgress to let per-file frontmatter updates settle
 * before the guard flag drops and subscribers rebuild the gallery.
 */
export function waitForMetadataQuiet(
  metadataCache: MetadataCache,
  opts?: WaitForMetadataQuietOpts,
): Promise<void> {
  const quietMs = opts?.quietMs ?? 150;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutTimer = setTimeout(cleanup, timeoutMs);
    const refs = [
      metadataCache.on("changed", schedule),
      metadataCache.on("resolved", schedule),
    ];

    function cleanup() {
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(timeoutTimer);
      for (const ref of refs) metadataCache.offref(ref);
      resolve();
    }

    function schedule() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(cleanup, quietMs);
    }

    schedule();
  });
}
