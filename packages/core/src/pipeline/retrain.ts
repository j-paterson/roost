import type { Vault } from "obsidian";
import { buildTrainingRows, type TrainingRow } from "@/pipeline/train-head";
import { trainStackedHeadsViaSidecar } from "@/pipeline/train-head-sidecar";
import { evaluateGate, type GateResult, type GateSample } from "@/pipeline/acceptance-gate";
import { writeStackedHeads, restorePreviousHeads, loadRetrainMeta, saveRetrainMeta } from "@/pipeline/head-store";
import { loadStackedHeads, type StackedHeads, type ClassifierHeadData, type MetaHeadData } from "@/pipeline/classifier-head";
import { RETRAIN_SIGNAL_FLOOR, GATE_KFOLDS, GATE_EPS, GATE_OOF, OOF_FOLDS } from "@/config";
import type { TrainingSet } from "@/pipeline/training-set";
import { appendRetrainLog } from "@/pipeline/retrain-log";

/**
 * Median timestamp of a row set. Sorted middle value; for even length, returns the
 * lower-middle element (floor of the middle index). Returns 0 for empty input.
 * Used to derive a pseudo-watermark on first enable when no real watermark exists.
 */
export function medianTs(rows: { ts: number }[]): number {
  if (rows.length === 0) return 0;
  const sorted = [...rows].map((r) => r.ts).sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Pure count: how many positive labels have a timestamp strictly after sinceTs.
 * Used to drive shouldRetrain at the start of a Smart Assign run.
 */
export function newLabelsSince(ts: TrainingSet, sinceTs: number): number {
  let n = 0;
  for (const p of Object.values(ts.positives)) if (p.ts > sinceTs) n++;
  return n;
}

/**
 * Pure trigger: fire when we have enough new human labels OR a category
 * is newly eligible (first time it reaches TRAIN_ELIGIBILITY_MIN).
 */
export function shouldRetrain(a: { newLabelsSinceLastTrain: number; newlyEligibleCount: number }): boolean {
  return a.newLabelsSinceLastTrain >= RETRAIN_SIGNAL_FLOOR || a.newlyEligibleCount > 0;
}

export interface RetrainOutcome {
  ran: boolean;
  swapped: boolean;
  reason: string;
  avgOverallDelta?: number;
  avgMacroDelta?: number;
  catastrophic?: string[];
}

/**
 * Pure swap decision: null gate means no current head exists (first train) → always
 * swap.  Non-null gate → swap iff gate.pass (fail-closed).
 */
export function decideSwap(gate: GateResult | null): { swapped: boolean } {
  return { swapped: gate === null ? true : gate.pass };
}

/**
 * Aggregate k-fold gate results into a single pass/fail decision.
 * Pass when avg overall delta >= -eps AND avg macro delta >= -eps AND no class
 * is catastrophic in a majority of folds.
 */
export function decideFromFolds(
  folds: GateResult[],
  eps: number,
): { pass: boolean; avgOverallDelta: number; avgMacroDelta: number; catastrophicClasses: string[] } {
  const n = folds.length || 1;
  const avgOverallDelta = folds.reduce((a, f) => a + (f.overallCandidate - f.overallCurrent), 0) / n;
  const avgMacroDelta = folds.reduce((a, f) => a + (f.macroCandidate - f.macroCurrent), 0) / n;
  const counts = new Map<string, number>();
  for (const f of folds) for (const c of f.catastrophic) counts.set(c, (counts.get(c) ?? 0) + 1);
  const majority = Math.ceil(folds.length / 2);
  const catastrophicClasses = [...counts.entries()].filter(([, k]) => k >= majority).map(([c]) => c);
  const pass =
    folds.length > 0 &&
    avgOverallDelta >= -eps &&
    avgMacroDelta >= -eps &&
    catastrophicClasses.length === 0;
  return { pass, avgOverallDelta, avgMacroDelta, catastrophicClasses };
}

/** Convert on-disk head data to the in-memory StackedHeads inference shape. */
function toStacked(d: {
  text: ClassifierHeadData;
  vision: ClassifierHeadData;
  meta: MetaHeadData;
}): StackedHeads {
  return {
    text: { classes: d.text.classes, W: d.text.W, b: d.text.b, dim: d.text.dim },
    vision: { classes: d.vision.classes, W: d.vision.W, b: d.vision.b, dim: d.vision.dim },
    meta: { classes: d.meta.classes, W: d.meta.W, b: d.meta.b, inDim: d.meta.inDim },
  };
}

/**
 * Stratified k-fold split: fold k's holdout = every item whose per-class index % K === k.
 * Deterministic given the order rows appear in the array.
 */
function kfoldSplit(
  rows: TrainingRow[],
  K: number,
  k: number,
): { train: TrainingRow[]; holdout: GateSample[] } {
  const train: TrainingRow[] = [];
  const holdout: GateSample[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const n = seen.get(r.category) ?? 0;
    seen.set(r.category, n + 1);
    if (n % K === k) {
      holdout.push({ vecText: r.vecText, vecVision: r.vecVision, truth: r.category });
    } else {
      train.push(r);
    }
  }
  return { train, holdout };
}

/**
 * Full retrain orchestration with fair fresh baseline + k-fold averaged gate decision:
 *   1. Build training rows from vault
 *   2. Load lastRetrainTs watermark and current head; derive effectiveWatermark
 *      (= lastRetrainTs, or medianTs(rows) on first enable when lastRetrainTs===0)
 *   3. If a current head exists: for GATE_KFOLDS stratified folds, train a FRESH
 *      baseline on rows with ts <= effectiveWatermark (excl. holdout), train candidate
 *      on all train rows, call evaluateGate; collect GateResults across folds
 *   4. decideFromFolds → swap/keep (fail-closed)
 *   5. On swap: train on ALL rows, writeStackedHeads, saveRetrainMeta
 *      Partial-write recovery: if write throws, restorePreviousHeads
 *   6. First-train (no current head): swap unconditionally
 */
export async function runRetrain(vault: Vault, log: (m: string) => void): Promise<RetrainOutcome> {
  const rows = buildTrainingRows(vault);
  if (rows.length === 0) {
    const outcome: RetrainOutcome = { ran: false, swapped: false, reason: "no eligible training data" };
    appendRetrainLog(vault, { ts: Date.now(), ...outcome });
    return outcome;
  }

  const lastRetrainTs = loadRetrainMeta(vault).lastRetrainTs;
  // On first enable there is no saved watermark (lastRetrainTs === 0).  Use the
  // median ts of all training rows as a pseudo-watermark so the gate can split
  // the data into an "older half" baseline and a "full" candidate — a fair first
  // gate.  After a successful swap, saveRetrainMeta sets a real watermark.
  const effectiveWatermark = lastRetrainTs > 0 ? lastRetrainTs : medianTs(rows);
  const current = loadStackedHeads(vault);

  let foldDecision: ReturnType<typeof decideFromFolds> | null = null;
  if (current) {
    const folds: GateResult[] = [];
    for (let k = 0; k < GATE_KFOLDS; k++) {
      const { train, holdout } = kfoldSplit(rows, GATE_KFOLDS, k);
      if (holdout.length === 0) continue;
      const baselineRows = train.filter((r) => r.ts <= effectiveWatermark);
      if (baselineRows.length === 0) continue; // nothing "before" → can't form a fair baseline this fold
      // Gate models are throwaway (never deployed) → cheaper GATE_OOF inner folds.
      const baseData = await trainStackedHeadsViaSidecar(baselineRows, GATE_OOF);
      const candData = await trainStackedHeadsViaSidecar(train, GATE_OOF);
      if (!baseData || !candData) {
        const outcome: RetrainOutcome = { ran: false, swapped: false, reason: "sidecar unavailable" };
        appendRetrainLog(vault, { ts: Date.now(), ...outcome });
        return outcome;
      }
      folds.push(evaluateGate(toStacked(baseData), toStacked(candData), holdout));
    }
    if (folds.length === 0) {
      log("[retrain] no usable gate folds (sparse 'before' set) — skipping to protect live head");
      const outcome: RetrainOutcome = { ran: false, swapped: false, reason: "no gate folds" };
      appendRetrainLog(vault, { ts: Date.now(), ...outcome });
      return outcome;
    }
    foldDecision = decideFromFolds(folds, GATE_EPS);
  }

  const swapped = current === null ? true : foldDecision!.pass;
  if (!swapped) {
    log(
      `[retrain] candidate rejected (fail-closed): macroΔ ${(foldDecision!.avgMacroDelta * 100).toFixed(1)}pp overallΔ ${(foldDecision!.avgOverallDelta * 100).toFixed(1)}pp catastrophic=${foldDecision!.catastrophicClasses.join(",") || "none"}`,
    );
    // Advance the watermark even on rejection: the gate DID evaluate these labels
    // and found no improvement, so we must not re-run the (expensive) retrain from
    // scratch every subsequent Smart Assign. It re-fires only once ≥RETRAIN_SIGNAL_FLOOR
    // NEW labels accumulate past this point.
    saveRetrainMeta(vault, { lastRetrainTs: Date.now() });
    const outcome: RetrainOutcome = {
      ran: true,
      swapped: false,
      reason: "gate failed",
      avgOverallDelta: foldDecision!.avgOverallDelta,
      avgMacroDelta: foldDecision!.avgMacroDelta,
      catastrophic: foldDecision!.catastrophicClasses,
    };
    appendRetrainLog(vault, { ts: Date.now(), ...outcome });
    return outcome;
  }

  // Deploy: train on ALL rows (holdout included); fail-closed partial-write recovery.
  const deployData = await trainStackedHeadsViaSidecar(rows, OOF_FOLDS);
  if (!deployData) {
    const outcome: RetrainOutcome = { ran: false, swapped: false, reason: "sidecar unavailable" };
    appendRetrainLog(vault, { ts: Date.now(), ...outcome });
    return outcome;
  }
  try {
    writeStackedHeads(vault, deployData);
  } catch (writeErr) {
    log(
      `[retrain] write failed (${writeErr instanceof Error ? writeErr.message : String(writeErr)}), restoring previous head`,
    );
    try {
      restorePreviousHeads(vault);
    } catch {
      log("[retrain] restore also failed — manual inspection needed");
    }
    const outcome: RetrainOutcome = {
      ran: true,
      swapped: false,
      reason: "write failed, restored previous",
      avgOverallDelta: foldDecision?.avgOverallDelta,
      avgMacroDelta: foldDecision?.avgMacroDelta,
      catastrophic: foldDecision?.catastrophicClasses,
    };
    appendRetrainLog(vault, { ts: Date.now(), ...outcome });
    return outcome;
  }
  saveRetrainMeta(vault, { lastRetrainTs: Date.now() });
  log(
    `[retrain] swapped in candidate (${deployData.meta.classes.length} classes)${foldDecision ? ` macroΔ ${(foldDecision.avgMacroDelta * 100).toFixed(1)}pp` : " (first head)"}`,
  );
  const outcome: RetrainOutcome = {
    ran: true,
    swapped: true,
    reason: current === null ? "first head" : "gate passed",
    avgOverallDelta: foldDecision?.avgOverallDelta,
    avgMacroDelta: foldDecision?.avgMacroDelta,
    catastrophic: foldDecision?.catastrophicClasses,
  };
  appendRetrainLog(vault, { ts: Date.now(), ...outcome });
  return outcome;
}
