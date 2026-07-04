import type { Vault } from "obsidian";
import { loadTrainingSet, eligibleCategories } from "@/pipeline/training-set";
import { loadEmbeddingCache } from "@/pipeline/shared";
import { TRAIN_ELIGIBILITY_MIN, CONFIRM_CAP_RATIO, RESERVED_NON_CATEGORIES } from "@/config";

export interface TrainingRow {
  id: string; vecText: number[]; vecVision: number[]; category: string; ts: number;
}

/** Apply the per-class confirm cap. Corrections/picks (source !== "confirm") are uncapped;
 *  confirms for class C are admitted in ascending-ts order up to ratio × (#corrections for C).
 *  Only categories in `eligible` are returned. Pure. */
export function selectTrainingPositives(
  positives: Record<string, { category: string; ts: number; source?: "correction" | "confirm" }>,
  eligible: Set<string>,
  ratio: number,
): Array<{ id: string; category: string; ts: number }> {
  const correctionCount: Record<string, number> = {};
  for (const { category, source } of Object.values(positives)) {
    if (source !== "confirm") correctionCount[category] = (correctionCount[category] ?? 0) + 1;
  }
  const confirmsByClass: Record<string, Array<{ id: string; category: string; ts: number }>> = {};
  const out: Array<{ id: string; category: string; ts: number }> = [];
  for (const [id, { category, ts, source }] of Object.entries(positives)) {
    if (!eligible.has(category)) continue;
    if (source === "confirm") {
      (confirmsByClass[category] ??= []).push({ id, category, ts });
    } else {
      out.push({ id, category, ts });
    }
  }
  for (const [category, confirms] of Object.entries(confirmsByClass)) {
    const cap = Math.floor(ratio * (correctionCount[category] ?? 0));
    confirms.sort((a, b) => a.ts - b.ts);
    for (const c of confirms.slice(0, cap)) out.push(c);
  }
  return out;
}

export function buildTrainingRows(vault: Vault): TrainingRow[] {
  const ts = loadTrainingSet(vault);
  const eligible = new Set(
    eligibleCategories(ts, TRAIN_ELIGIBILITY_MIN).filter(c => !RESERVED_NON_CATEGORIES.has(c.toLowerCase())),
  );
  const cache = loadEmbeddingCache(vault);
  const rows: TrainingRow[] = [];
  for (const { id, category, ts: at } of selectTrainingPositives(ts.positives, eligible, CONFIRM_CAP_RATIO)) {
    const e = cache[id];
    if (!e) continue;
    const vecVision = e.vec; const vecText = e.vecText ?? e.vec;
    if (!vecVision || !vecText) continue;
    rows.push({ id, vecText, vecVision, category, ts: at });
  }
  return rows;
}

