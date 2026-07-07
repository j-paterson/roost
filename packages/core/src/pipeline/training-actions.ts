import type { Vault, FileManager, TFile } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";
import { type TrainingSet, addPositive, addRejection, loadTrainingSet, saveTrainingSet } from "@/pipeline/training-set";
import { loadSnapshot, saveSnapshot } from "@/pipeline/category-snapshot";
import { appendEvalRecords, type EvalRecord } from "@/pipeline/eval-log";

/** Pure: confirm an auto guess. Mutates `ts`; returns the frontmatter patch, the snapshot
 *  value to pre-seed (own-write guard), and the review eval record. */
export function planConfirm(
  ts: TrainingSet, id: string, category: string, now: number,
): { evalRecord: EvalRecord; patch: Record<string, unknown>; snapshotValue: string } {
  addPositive(ts, id, category, now, "confirm");
  return {
    evalRecord: { ts: now, roostId: id, guess: category, tier: "none", finalLabel: category, correct: true, mode: "review" },
    patch: { [ASSIGNED_BY_FIELD]: "human" },
    snapshotValue: category,
  };
}

/** Pure: reject an auto guess (no replacement). Mutates `ts`; clears all roost_* category
 *  fields (fully unsorted); review eval record marks the guess wrong. */
export function planReject(
  ts: TrainingSet, id: string, guessedClass: string, now: number,
): { evalRecord: EvalRecord; patch: Record<string, unknown>; snapshotValue: null } {
  addRejection(ts, id, guessedClass);
  return {
    evalRecord: { ts: now, roostId: id, guess: guessedClass, tier: "none", finalLabel: null, correct: false, mode: "review" },
    patch: { [CATEGORY_FIELD]: null, [SUBCATEGORY_FIELD]: null, [ASSIGNED_BY_FIELD]: null },
    snapshotValue: null,
  };
}

/** Pure: reject a review PROPOSAL (the best-fit class shown in the banner) WITHOUT re-filing
 *  the item. Records a per-category negative for `proposedClass` and returns an empty patch,
 *  so the item keeps its current roost_category (e.g. "Other") and stays eligible for future
 *  review passes. Contrast planReject, which clears the category to fully unsorted. */
export function planRejectProposal(
  ts: TrainingSet, id: string, proposedClass: string, now: number,
): { evalRecord: EvalRecord; patch: Record<string, unknown> } {
  addRejection(ts, id, proposedClass);
  return {
    evalRecord: { ts: now, roostId: id, guess: proposedClass, tier: "none", finalLabel: null, correct: false, mode: "review" },
    patch: {},
  };
}

export interface TrainingActionDeps {
  vault: Vault;
  fileManager: FileManager;
  file: TFile;
  id: string;
  now: number;
}

/** Effectful: pre-seed snapshot → persist training-set + eval → write frontmatter.
 *  Snapshot is seeded BEFORE the frontmatter write so the organic-capture own-write
 *  guard suppresses the resulting metadataCache event. */
export async function confirmAutoItem(deps: TrainingActionDeps, category: string): Promise<void> {
  const { vault, fileManager, file, id, now } = deps;
  const ts = loadTrainingSet(vault);
  const { evalRecord, patch, snapshotValue } = planConfirm(ts, id, category, now);
  const snap = loadSnapshot(vault); snap[id] = snapshotValue; saveSnapshot(vault, snap);
  saveTrainingSet(vault, ts);
  appendEvalRecords(vault, [evalRecord]);
  await fileManager.processFrontMatter(file, (fm) => { Object.assign(fm, patch); });
}

export async function rejectAutoItem(deps: TrainingActionDeps, guessedClass: string): Promise<void> {
  const { vault, fileManager, file, id, now } = deps;
  const ts = loadTrainingSet(vault);
  const { evalRecord, patch, snapshotValue } = planReject(ts, id, guessedClass, now);
  const snap = loadSnapshot(vault); snap[id] = snapshotValue; saveSnapshot(vault, snap);
  saveTrainingSet(vault, ts);
  appendEvalRecords(vault, [evalRecord]);
  await fileManager.processFrontMatter(file, (fm) => {
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete fm[k]; else fm[k] = v; }
  });
}

/** Effectful: record a proposal rejection (per-category negative). Persists the training-set
 *  and eval log only; the empty patch means NO frontmatter is written and NO snapshot is
 *  touched, so the item stays filed as-is (e.g. "Other") and remains eligible for future
 *  review passes. */
export async function rejectProposalItem(deps: TrainingActionDeps, proposedClass: string): Promise<void> {
  const { vault, fileManager, file, id, now } = deps;
  const ts = loadTrainingSet(vault);
  const { evalRecord, patch } = planRejectProposal(ts, id, proposedClass, now);
  saveTrainingSet(vault, ts);
  appendEvalRecords(vault, [evalRecord]);
  if (Object.keys(patch).length > 0) {
    await fileManager.processFrontMatter(file, (fm) => {
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete fm[k]; else fm[k] = v; }
    });
  }
}

/** Pure: confirm a review PROPOSAL (category not yet in frontmatter). Writes the
 *  category AND human provenance, records a confirm-source positive (capped). */
export function planReviewConfirm(
  ts: TrainingSet, id: string, category: string, now: number,
): { evalRecord: EvalRecord; patch: Record<string, unknown>; snapshotValue: string } {
  addPositive(ts, id, category, now, "confirm");
  return {
    evalRecord: { ts: now, roostId: id, guess: category, tier: "none", finalLabel: category, correct: true, mode: "review" },
    patch: { [CATEGORY_FIELD]: category, [ASSIGNED_BY_FIELD]: "human" },
    snapshotValue: category,
  };
}

/** Pure: move a review proposal to a DIFFERENT category (a correction). Writes the new
 *  category + human provenance; positive recorded with the correction source (uncapped).
 *  `originalGuess` is the system's proposed category the user is correcting; if null
 *  (no proposal and no frontmatter) the guess field is recorded as null and correct=false. */
export function planCorrection(
  ts: TrainingSet, id: string, category: string, originalGuess: string | null, now: number,
): { evalRecord: EvalRecord; patch: Record<string, unknown>; snapshotValue: string } {
  addPositive(ts, id, category, now, "correction");
  return {
    evalRecord: { ts: now, roostId: id, guess: originalGuess, tier: "none", finalLabel: category, correct: originalGuess === category, mode: "review" },
    patch: { [CATEGORY_FIELD]: category, [ASSIGNED_BY_FIELD]: "human" },
    snapshotValue: category,
  };
}
