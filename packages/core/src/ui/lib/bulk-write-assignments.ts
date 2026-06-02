import type { TFile } from "obsidian";
import { traceEvent } from "@/lib/render-trace";
import type { IRoostPlugin } from "@/types/plugin";

/** Plugin-shaped object with the bulk-write flag. */
export type BulkWritePlugin = Pick<IRoostPlugin, "bulkWriteInProgress">;

/** Minimal FileManager-shaped interface — wraps app.fileManager.processFrontMatter
 *  so this helper can be unit-tested without an Obsidian App. */
export interface BulkWriteFileManager {
  processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
}

/** Minimal Obsidian-events interface for firing the coalesced refresh. */
export interface BulkWriteEventBus {
  trigger(name: string, ...args: unknown[]): void;
}

export interface BulkWriteAssignmentsArgs {
  /** Map from a stable key (e.g. roost_id, file path) to a value passed to patchFor. */
  itemAssignments: Map<string, string>;
  /** Same keys as itemAssignments. */
  fileByKey: Map<string, TFile>;
  /** processFrontMatter source — typically `app.fileManager`. */
  fileManager: BulkWriteFileManager;
  plugin: BulkWritePlugin;
  /** Fired exactly once after all writes complete. */
  events: BulkWriteEventBus;
  /** Build the frontmatter patch for an item. Confirm passes a closure that
   *  builds the full smart-assign patch; rename passes one that updates a
   *  single field; delete returns null-valued keys to remove fields.
   *  Return an empty object to skip the item. */
  patchFor: (key: string, value: string) => Record<string, string | null>;
  log: (msg: string) => void;
  /** Called with monotonic step counts: 0 → totalSteps. */
  setProgress: (done: number, total: number) => void;
  /** Max concurrent processFrontMatter calls (default 20). */
  concurrency?: number;
  /** Optional callback executed AFTER writes complete but BEFORE the
   *  bulkWriteInProgress flag flips back to false. Use this to record
   *  derived state (filter-follow, library tree refresh) that must land
   *  while subscribers are still suppressed — otherwise the flag toggle
   *  would flicker as the caller re-arms it. Errors here are propagated
   *  to the caller; the flag still flips off in finally. */
  runUnderGuard?: () => Promise<void> | void;
}

export interface BulkWriteResult {
  tagged: number;
  alreadySet: number;
  notFound: number;
  errors: number;
}

/**
 * Bulk-write frontmatter patches for a set of items. Used by Smart Assign
 * confirm, by category/subcategory rename, and by category/subcategory delete.
 * The patch shape is provided by the caller via `patchFor` so the helper stays
 * generic.
 *
 * Design (post-2026-04-30 refactor):
 *   - Uses `processFrontMatter` for atomicity: each per-file mutation is a
 *     single read-modify-write that holds an exclusive lock vs other writers
 *     (sync, Templater, manual edits). Mirrors the Obsidian-recommended
 *     pattern over raw `read` + `modify` (which is documented to race).
 *   - CONCURRENT across files (up to `concurrency`, default 20). Each
 *     call targets a different TFile so there are no per-file races.
 *     The concurrency pool keeps the UI responsive and avoids
 *     overwhelming Obsidian's metadata cache or synced-storage daemons.
 *   - Counts: tagged (mutated), alreadySet (patch matched existing fm),
 *     notFound (key had no file), errors (processFrontMatter threw). The
 *     same accounting the caller previously consumed.
 *   - Flag + coalesced trigger: plugin.bulkWriteInProgress = true for the
 *     full duration so subscribers can short-circuit per-event UI rebuilds;
 *     events.trigger("resolved") fires once at the end.
 */
export async function bulkWriteAssignments(args: BulkWriteAssignmentsArgs): Promise<BulkWriteResult> {
  const {
    itemAssignments, fileByKey, fileManager, plugin, events,
    patchFor, log, setProgress,
  } = args;
  const maxConcurrency = args.concurrency ?? 20;

  let tagged = 0;
  let alreadySet = 0;
  let notFound = 0;
  let errors = 0;

  const total = itemAssignments.size;
  let done = 0;
  setProgress(0, total);

  traceEvent("bulkWrite:flagOn", { items: total });
  plugin.bulkWriteInProgress = true;
  try {
    const entries = [...itemAssignments];
    let cursor = 0;
    let active = 0;
    let resolve: (() => void) | null = null;

    function tryLaunch() {
      while (active < maxConcurrency && cursor < entries.length) {
        const [key, value] = entries[cursor++];
        active++;
        processOne(key, value).finally(() => {
          active--;
          done++;
          setProgress(done, total);
          if (active === 0 && cursor >= entries.length) resolve?.();
          else tryLaunch();
        });
      }
    }

    async function processOne(key: string, value: string) {
      const file = fileByKey.get(key);
      if (!file) { notFound++; return; }
      const patch = patchFor(key, value);
      if (Object.keys(patch).length === 0) { alreadySet++; return; }
      let changed = false;
      try {
        await fileManager.processFrontMatter(file, (fm) => {
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) {
              if (k in fm) { delete fm[k]; changed = true; }
            } else {
              if (fm[k] !== v) { fm[k] = v; changed = true; }
            }
          }
        });
        if (changed) tagged++;
        else alreadySet++;
      } catch (e: unknown) {
        errors++;
        log(`[bulk-write] error ${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await new Promise<void>((r) => {
      resolve = r;
      if (entries.length === 0) r();
      else tryLaunch();
    });

    if (args.runUnderGuard) {
      traceEvent("bulkWrite:runUnderGuard");
      await args.runUnderGuard();
    }
  } finally {
    plugin.bulkWriteInProgress = false;
    traceEvent("bulkWrite:flagOff");
  }

  traceEvent("bulkWrite:trigger");
  events.trigger("resolved");
  traceEvent("bulkWrite:done");

  return { tagged, alreadySet, notFound, errors };
}
