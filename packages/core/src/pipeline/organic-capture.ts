/**
 * Organic-capture listener — turns any hand edit to roost_category into training signal.
 *
 * Pure core: captureEdit() — own-write guard + capture (fully unit-tested).
 * Disk-reload helper: processSnapshotChange() — fresh snapshot read per debounce fire (unit-tested).
 * Obsidian-bound: bootstrapSnapshot() + registerOrganicCapture() — verified by tsc only.
 */
import type { Plugin, Vault } from "obsidian";
import {
  type CategorySnapshot,
  classifyTransition,
  applyTransition,
  type Transition,
  loadSnapshot,
  saveSnapshot,
} from "@/pipeline/category-snapshot";
import { type TrainingSet, loadTrainingSet, saveTrainingSet } from "@/pipeline/training-set";
import { CATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";

// ── Pure core ─────────────────────────────────────────────────────────────────

/**
 * Pure: the own-write guard + capture.
 *
 * If newCategory equals the snapshot value this was the plugin's own write (or a sync echo)
 * → no-op, changed: false. Otherwise it's an external hand edit → classify + apply + update
 * snapshot, changed: true (caller should persist ts + snapshot).
 *
 * MUTATES snapshot and ts in place (same references returned for convenience).
 */
export function captureEdit(args: {
  snapshot: CategorySnapshot;
  ts: TrainingSet;
  id: string;
  newCategory: string | null;
  now: number;
}): { changed: boolean; snapshot: CategorySnapshot; ts: TrainingSet; transition: Transition } {
  const { snapshot, ts, id, newCategory, now } = args;
  // Own-write guard: if the snapshot already has this value, it was our write or a sync echo.
  const prev = id in snapshot ? snapshot[id] : undefined;
  if (prev === newCategory) {
    return { changed: false, snapshot, ts, transition: { kind: "none", from: prev ?? null, to: newCategory } };
  }
  const transition = classifyTransition(prev, newCategory);
  if (transition.kind === "none") {
    // e.g. id absent from snapshot + newCategory null — not a capturable event.
    snapshot[id] = newCategory;
    return { changed: false, snapshot, ts, transition };
  }
  applyTransition(ts, id, transition, now);
  snapshot[id] = newCategory;
  return { changed: true, snapshot, ts, transition };
}

// ── Per-fire disk-reload helper ────────────────────────────────────────────────

/**
 * Reload the snapshot from disk, run the own-write guard + capture, and persist.
 *
 * Exported for unit testing. Called once per debounce fire so a concurrent
 * bulk-write's snapshot update (written by confirm.ts) is always reflected —
 * no stale closure value, no dependency on bulkWriteInProgress timing.
 *
 * Does NOT do the processFrontMatter write-back (roost_assigned_by: human);
 * that stays in the Obsidian-bound handler in registerOrganicCapture.
 *
 * Returns true if a capture happened (caller should do the write-back).
 */
export function processSnapshotChange(
  vault: Vault,
  id: string,
  newCategory: string | null,
): boolean {
  const snap = loadSnapshot(vault);           // fresh read per fire — timing-independent
  const ts = loadTrainingSet(vault);
  const result = captureEdit({ snapshot: snap, ts, id, newCategory, now: Date.now() });
  if (result.changed) {
    saveTrainingSet(vault, result.ts);
    // Snapshot already mutated to newCategory by captureEdit — save it before the
    // write-back so the subsequent "changed" event will be an own-write no-op.
    saveSnapshot(vault, result.snapshot);
    return true;
  }
  saveSnapshot(vault, result.snapshot);
  return false;
}

// ── Obsidian-bound helpers ────────────────────────────────────────────────────

/**
 * Scan all vault markdown files for roost_id + roost_category and build the initial
 * CategorySnapshot. Captures nothing — this is a first-run seed only.
 */
export function bootstrapSnapshot(plugin: Plugin): CategorySnapshot {
  const { vault, metadataCache } = plugin.app;
  const snap: CategorySnapshot = {};
  for (const file of vault.getMarkdownFiles()) {
    const fm = metadataCache.getFileCache(file)?.frontmatter;
    const rawId = fm?.roost_id;
    if (typeof rawId !== "string") continue;
    const rawCat = fm?.[CATEGORY_FIELD];
    snap[rawId] = typeof rawCat === "string" ? rawCat : null;
  }
  return snap;
}

/** Plugin structural type: what registerOrganicCapture needs beyond the base Plugin. */
interface OrgCapPlugin extends Plugin {
  readonly bulkWriteInProgress?: boolean;
}

/**
 * Register the debounced metadataCache "changed" listener that converts hand edits
 * to roost_category into training signal.
 *
 * - Uses plugin.registerEvent so the listener is auto-cleaned on plugin unload.
 * - No-ops while plugin.bulkWriteInProgress (Smart Assign bulk writes).
 * - Calls captureEdit for the own-write guard; on a real hand edit persists ts + snapshot
 *   and writes roost_assigned_by: human (snapshot updated first so this write doesn't
 *   re-trigger capture).
 * - On first run (snapshot cache absent / empty) bootstraps from current vault frontmatter.
 */
export function registerOrganicCapture(plugin: OrgCapPlugin): void {
  const { vault, metadataCache, fileManager } = plugin.app;

  // Seed the on-disk snapshot on first run (cache file absent) from vault frontmatter.
  // bootstrapSnapshot saves to disk so processSnapshotChange's per-fire loadSnapshot
  // will see the seeded values — no stale closure copy kept.
  const initial = loadSnapshot(vault);
  if (Object.keys(initial).length === 0) {
    saveSnapshot(vault, bootstrapSnapshot(plugin));
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  // Clean up a pending debounce timer when the plugin unloads.
  plugin.register(() => {
    if (timer) clearTimeout(timer);
  });

  plugin.registerEvent(
    metadataCache.on("changed", (file) => {
      // Fast-path: skip while Smart Assign's bulk write is in progress (belt-and-suspenders).
      // The per-fire snapshot reload in processSnapshotChange is the timing-independent guard:
      // confirm.ts writes the snapshot before emitting "changed", so even if this event
      // fires after bulkWriteInProgress clears, the fresh disk read will see the written
      // category and captureEdit returns changed:false.
      if (plugin.bulkWriteInProgress) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const fm = metadataCache.getFileCache(file)?.frontmatter;
          const rawId = fm?.roost_id;
          const id = typeof rawId === "string" ? rawId : null;
          if (!id) return; // not a roost bookmark

          const rawCat = fm?.[CATEGORY_FIELD];
          const newCategory = typeof rawCat === "string" ? rawCat : null;

          // Reload snapshot from disk on each fire — timing-independent own-write guard.
          const changed = processSnapshotChange(vault, id, newCategory);
          if (changed) {
            // Mark as human-assigned. This triggers another "changed" event; the own-write
            // guard ensures it is treated as a no-op.
            void fileManager.processFrontMatter(file, (frontmatter) => {
              frontmatter[ASSIGNED_BY_FIELD] = "human";
            });
          }
        } catch (e: unknown) {
          console.warn("[roost] organic capture error:", e instanceof Error ? e.message : String(e));
        }
      }, 300);
    }),
  );
}
