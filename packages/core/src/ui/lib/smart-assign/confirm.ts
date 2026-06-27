/**
 * Smart Assign confirm — bulk-write categorized assignments to vault notes.
 */
import { Notice } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";
import type { SmartAssignInput } from "@/types/roost";
import { buildFileIndex } from "@/lib/vault-utils";
import { bulkWriteAssignments } from "@/ui/lib/bulk-write-assignments";
import type { IRoostPlugin } from "@/types/plugin";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { TagAssignment } from "@/pipeline/evaluate";
import { appendCategoryTags, tagToObsidianTag } from "@/lib/category-tags";
import {
  type TrainingSet, addPositive, addRejection, loadTrainingSet, saveTrainingSet,
} from "@/pipeline/training-set";
import type { EvalRecord, EvalTier } from "@/pipeline/eval-log";
import { appendEvalRecords } from "@/pipeline/eval-log";
import { shouldRetrain, runRetrain } from "@/pipeline/retrain";
/**
 * Pure gate helper — calls `run` only when both `enabled` and `triggered` are true.
 * Returns the outcome when run, or null otherwise.
 */
export function maybeRetrain(
  enabled: boolean,
  triggered: boolean,
  run: () => { ran: boolean; swapped: boolean; reason: string },
): { ran: boolean; swapped: boolean; reason: string } | null {
  if (!enabled || !triggered) return null;
  return run();
}

export interface SmartAssignConfirmStore {
  getClusterGroups: () => Array<{ uncertainItemIds?: string[] }>;
  getReassignments: () => Map<string, string>;
  getRejects: () => Set<string>;
}

export function buildItemCategory(args: {
  proposedFolders: { name: string; itemIds: string[] }[];
  unsortedIds: Set<string>;
  uncertainIds: Set<string>;
  reassigned: Map<string, string>;
  rejects: Set<string>;
  isSubcat: boolean;
  assignedSubcategories: Map<string, string | null>;
}): Map<string, string> {
  const { proposedFolders, unsortedIds, uncertainIds, reassigned, rejects, isSubcat, assignedSubcategories } = args;
  const itemCategory = new Map<string, string>();
  for (const folder of proposedFolders) {
    for (const id of folder.itemIds) {
      if (!unsortedIds.has(id)) continue;
      if (uncertainIds.has(id) && !reassigned.has(id)) continue;
      if (rejects.has(id)) continue; // rejected: wrong, no replacement → leave unsorted
      if (isSubcat) {
        itemCategory.set(id, folder.name);
      } else {
        const subcat = assignedSubcategories.get(id) ?? null;
        itemCategory.set(id, subcat === null ? `${folder.name}\x00` : `${folder.name}\x00${subcat}`);
      }
    }
  }
  return itemCategory;
}

export interface SmartAssignConfirmHost {
  plugin: IRoostPlugin;
  syncFolder: string;
  log: (msg: string) => void;
  setSyncProgress: (p: SyncProgress | null | ((prev: SyncProgress | null) => SyncProgress | null)) => void;
  getInput: () => SmartAssignInput | null;
  unsortedIds: Set<string>;
  assignedSubcategories: Map<string, string | null>;
  store: SmartAssignConfirmStore;
  fileManager: import("obsidian").FileManager;
  metadataCache: import("obsidian").MetadataCache;
  runUnderGuard?: () => Promise<void> | void;
  /**
   * Multi-label tag assignments from the tag-detector forward pass (Wave 2 D1).
   * Present only when `settings.smartAssignTags` is true and the detector weights
   * were loaded successfully.  When provided, `confirmSmartAssign` appends
   * `category/*` native tags for every fired detector tag and sets
   * `roost_category` to the primary (only if absent or a dropped tag).
   */
  tagAssignments?: Map<string, TagAssignment>;
  /**
   * Returns the phase-1 match-detail map (id → {collection?, reason?}).
   * Optional — present in the live UI hook; absent in tests that don't need it.
   */
  getMatchDetails?: () => Map<string, { collection?: string; reason?: string }>;
}

export interface SmartAssignConfirmResult {
  tagged: number;
}

/**
 * Pure helper — computes training-set mutations and prequential eval records
 * from a single confirm operation. Unit-testable with no vault I/O.
 *
 * Invariants:
 *   - Only HUMAN-provenance items (present in `reassigned`) become positives.
 *   - Rejected items are recorded as negatives (id ✗ guessed class) — never positives.
 *   - Eval records are emitted for every item that had a pre-confirm guess.
 */
export function captureLoopUpdates(args: {
  ts: TrainingSet;
  itemCategory: Map<string, string>;            // id → "Cat\x00Subcat" (final written labels)
  reassigned: Map<string, string>;              // human-provenance ids
  rejects: Set<string>;
  guesses: Map<string, { guess: string | null; tier: EvalTier }>; // pre-correction head guess
  now: number;
}): { trainingSet: TrainingSet; evalRecords: EvalRecord[] } {
  const { ts, itemCategory, reassigned, rejects, guesses, now } = args;
  const evalRecords: EvalRecord[] = [];

  // Positives: human-provenance written items only (never auto-accepted).
  for (const [id, encoded] of itemCategory) {
    if (!reassigned.has(id)) continue; // auto → not trained
    const category = encoded.indexOf("\x00") >= 0 ? encoded.slice(0, encoded.indexOf("\x00")) : encoded;
    addPositive(ts, id, category, now);
  }

  // Negatives: rejected items (id ✗ the class the head guessed).
  for (const id of rejects) {
    const g = guesses.get(id)?.guess;
    if (g) addRejection(ts, id, g);
  }

  // Prequential eval: for every reviewed item with a guess, compare guess vs final label.
  for (const [id, g] of guesses) {
    if (!itemCategory.has(id) && !rejects.has(id)) continue; // user didn't resolve this item → not part of the organic holdout
    let finalLabel: string | null = null;
    if (rejects.has(id)) finalLabel = null; // rejected, no replacement
    else {
      const enc = itemCategory.get(id);
      if (enc !== undefined) finalLabel = enc.indexOf("\x00") >= 0 ? enc.slice(0, enc.indexOf("\x00")) : enc;
    }
    evalRecords.push({
      ts: now, roostId: id, guess: g.guess, tier: g.tier,
      finalLabel, correct: g.guess !== null && finalLabel !== null && g.guess === finalLabel,
    });
  }
  return { trainingSet: ts, evalRecords };
}

/**
 * Provenance stamp for a confirmed item. A user reassignment (an explicit move in the
 * Smart Assign review UI) is a HUMAN decision — it should up-weight the centroid
 * (HUMAN_WEIGHT) and count as an honest label; an untouched proposal is the machine's.
 */
export function confirmAssignedBy(reassigned: Map<string, string>, id: string): "human" | "auto" {
  return reassigned.has(id) ? "human" : "auto";
}

export async function confirmSmartAssign(
  host: SmartAssignConfirmHost,
  proposedFolders: { name: string; itemIds: string[] }[] | null,
): Promise<SmartAssignConfirmResult | null> {
  if (!proposedFolders) return null;

  host.log("Confirming Smart Assign...");

  const uncertainIds = new Set<string>();
  for (const group of host.store.getClusterGroups()) {
    if (group.uncertainItemIds) {
      for (const id of group.uncertainItemIds) uncertainIds.add(id);
    }
  }
  const reassigned = host.store.getReassignments();

  const confirmInput = host.getInput();
  const isSubcat = confirmInput?.write.into === "subcategoryOf";
  const parentName = isSubcat ? (confirmInput!.write as { into: "subcategoryOf"; parent: string }).parent : null;

  const rejects = host.store.getRejects();
  const itemCategory = buildItemCategory({
    proposedFolders,
    unsortedIds: host.unsortedIds,
    uncertainIds,
    reassigned,
    rejects,
    isSubcat,
    assignedSubcategories: host.assignedSubcategories,
  });

  const totalProposed = proposedFolders.reduce((n, f) => n + f.itemIds.length, 0);
  const skippedUncertain = [...uncertainIds].filter(id => !reassigned.has(id)).length;
  host.log(`[confirm] ${itemCategory.size} items to categorize (${totalProposed} total, ${skippedUncertain} uncertain skipped, ${rejects.size} rejected, ${totalProposed - itemCategory.size - skippedUncertain - rejects.size} already categorized)`);

  const fileByRoostId = buildFileIndex(host.plugin.app, host.syncFolder);

  const result = await bulkWriteAssignments({
    itemAssignments: itemCategory,
    fileByKey: fileByRoostId,
    fileManager: host.fileManager,
    plugin: host.plugin,
    events: host.metadataCache,
    patchFor: (id, value) => {
      const assignedBy = confirmAssignedBy(reassigned, id);
      if (isSubcat) {
        return { [CATEGORY_FIELD]: parentName!, [SUBCATEGORY_FIELD]: value, [ASSIGNED_BY_FIELD]: assignedBy };
      }
      const sep = value.indexOf("\x00");
      if (sep < 0) {
        return { [CATEGORY_FIELD]: value, [SUBCATEGORY_FIELD]: null, [ASSIGNED_BY_FIELD]: assignedBy };
      }
      const category = value.slice(0, sep);
      const subcategory = value.slice(sep + 1);
      return {
        [CATEGORY_FIELD]: category,
        [SUBCATEGORY_FIELD]: subcategory || null,
        [ASSIGNED_BY_FIELD]: assignedBy,
      };
    },
    log: host.log,
    setProgress: (done, total) =>
      host.setSyncProgress({ phase: "writing", count: total, written: done, skipped: 0, resynced: 0 }),
    runUnderGuard: host.runUnderGuard,
  });

  host.log(`[confirm] tagged=${result.tagged} alreadySet=${result.alreadySet} notFound=${result.notFound} errors=${result.errors}`);
  if (result.notFound > 0) host.log(`[confirm] ${result.notFound} items could not be matched to vault files`);

  // ── Self-Improving Loop: capture positives + rejections + prequential eval ──
  // Runs after bulkWriteAssignments; failure must never break confirm.
  try {
    const vault = host.plugin.app.vault;
    const tsStore = loadTrainingSet(vault);
    const guesses = new Map<string, { guess: string | null; tier: EvalTier }>();
    for (const [id, detail] of host.getMatchDetails?.() ?? new Map()) {
      const reason = detail.reason ?? "";
      const tier: EvalTier = reason.startsWith("centroid") ? "centroid"
        : reason.startsWith("stacked") ? "stacked"
        : reason.startsWith("head") ? "head" : "llm";
      guesses.set(id, { guess: detail.collection ?? null, tier });
    }
    const { trainingSet, evalRecords } = captureLoopUpdates({
      ts: tsStore, itemCategory, reassigned, rejects,
      guesses, now: Date.now(),
    });
    saveTrainingSet(vault, trainingSet);
    appendEvalRecords(vault, evalRecords);
  } catch (e: unknown) {
    host.log(`[loop] capture failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Self-Improving Loop: retrain classifier head (opt-in, fail-closed) ──────
  // Runs after the capture block; failure must NEVER break confirm/write.
  try {
    if (host.plugin.settings.smartAssignAutoRetrain) {
      const vault = host.plugin.app.vault;
      const triggered = shouldRetrain({
        newLabelsSinceLastTrain: reassigned.size + host.store.getRejects().size,
        newlyEligibleCount: 0, // refined later; reassigned-count floor is the v1 trigger
      });
      maybeRetrain(true, triggered, () => runRetrain(vault, host.log));
    }
  } catch (e: unknown) {
    host.log(`[retrain] failed (kept current head): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Wave 2 D1: Append category/* tags when tagAssignments are present ────────
  // Mirrors the faithfulness contract of migrate-to-tags.mjs migrateNote:
  //   - Append category/<slug> for every fired tag — never remove existing tags.
  //   - Set roost_category to the primary ONLY when absent or a dropped tag
  //     (i.e. not in the detector canon — preserve existing valid primaries).
  if (host.tagAssignments && host.tagAssignments.size > 0) {
    const tagAssignments = host.tagAssignments;
    let tagWriteCount = 0;

    for (const [id, ta] of tagAssignments) {
      const file = fileByRoostId.get(id);
      if (!file) continue;
      try {
        await host.fileManager.processFrontMatter(file, (fm) => {
          // Existing tags array (may be string[] or undefined in frontmatter)
          const existingTags: string[] = Array.isArray(fm["tags"])
            ? (fm["tags"] as unknown[]).map(String)
            : [];

          // Append category/* tags for all fired tags (appendCategoryTags deduplicates)
          const allTagNames = ta.tags.length > 0 ? ta.tags : [ta.primary];
          const newTags = appendCategoryTags(existingTags, allTagNames);

          // Also ensure the primary has its category/* tag even if it didn't fire
          const primaryObsTag = tagToObsidianTag(ta.primary);
          const finalTags = newTags.includes(primaryObsTag)
            ? newTags
            : appendCategoryTags(newTags, [ta.primary]);

          if (finalTags.length !== existingTags.length ||
              !finalTags.every((t, i) => t === existingTags[i])) {
            fm["tags"] = finalTags;
          }

          // Set roost_category = primary ONLY if absent or a dropped tag.
          // Faithful to migrate-to-tags.mjs migrateNote:
          //   keepPrimary = !!(oldPrimary && canon.has(oldPrimary))
          //   effectivePrimary = keepPrimary ? oldPrimary : primary
          // ta.canonTags is the full detector tag list, matching what migrateNote
          // calls `detectors.tags` — so "dropped tag" = any category no longer in
          // the trained detector weights (e.g. "Content Creation" removed from canon).
          const existingPrimary = typeof fm[CATEGORY_FIELD] === "string"
            ? (fm[CATEGORY_FIELD] as string)
            : null;
          const canon = new Set(ta.canonTags);
          const keepPrimary = !!(existingPrimary && canon.has(existingPrimary));
          if (!keepPrimary) {
            fm[CATEGORY_FIELD] = ta.primary;
          }
        });
        tagWriteCount++;
      } catch (e: unknown) {
        host.log(`[confirm/tags] error writing tags for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    host.log(`[confirm/tags] wrote category/* tags for ${tagWriteCount} items`);
  }

  new Notice(`Smart Assign complete — ${result.tagged} notes categorized`);

  return { tagged: result.tagged };
}
