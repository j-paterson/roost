import type { Vault } from "obsidian";
import { buildTrainingRows, trainStackedHeadsFromRows, type TrainingRow } from "@/pipeline/train-head";
import { evaluateGate, type GateResult, type GateSample } from "@/pipeline/acceptance-gate";
import { writeStackedHeads, restorePreviousHeads } from "@/pipeline/head-store";
import { loadStackedHeads, type StackedHeads } from "@/pipeline/classifier-head";
import { RETRAIN_SIGNAL_FLOOR } from "@/config";

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
  gate?: GateResult;
}

/**
 * Pure swap decision: null gate means no current head exists (first train) → always
 * swap.  Non-null gate → swap iff gate.pass (fail-closed).
 */
export function decideSwap(gate: GateResult | null): { swapped: boolean } {
  return { swapped: gate === null ? true : gate.pass };
}

/**
 * Hold out ~20% per class (deterministic: every 5th row per class) for the
 * acceptance gate.  The remaining rows form the training set.
 */
function splitHoldout(rows: TrainingRow[]): { train: TrainingRow[]; holdout: GateSample[] } {
  const train: TrainingRow[] = [];
  const holdout: GateSample[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const n = seen.get(r.category) ?? 0;
    seen.set(r.category, n + 1);
    if (n % 5 === 4) {
      holdout.push({ vecText: r.vecText, vecVision: r.vecVision, truth: r.category });
    } else {
      train.push(r);
    }
  }
  return { train, holdout };
}

/**
 * Full retrain orchestration:
 *   1. Build training rows from vault
 *   2. Split ~20% holdout (deterministic, every 5th per class)
 *   3. Train candidate on remaining rows
 *   4. If a current head exists and holdout is non-empty, gate candidate vs current
 *   5. decideSwap (fail-closed: no current head → swap; gate.pass → swap; else keep)
 *   6. On swap: writeStackedHeads — partial-write recovery: if write throws,
 *      restorePreviousHeads + return reason "write failed, restored previous"
 *   7. On keep: log and return
 */
export function runRetrain(vault: Vault, log: (m: string) => void): RetrainOutcome {
  const rows = buildTrainingRows(vault);
  if (rows.length === 0) {
    return { ran: false, swapped: false, reason: "no eligible training data" };
  }

  const { train, holdout } = splitHoldout(rows);
  const candidateData = trainStackedHeadsFromRows(train);
  if (!candidateData) {
    return { ran: false, swapped: false, reason: "trainer returned null" };
  }

  // Build StackedHeads (inference shape) from candidateData (on-disk shape).
  const candidate: StackedHeads = {
    text: {
      classes: candidateData.text.classes,
      W: candidateData.text.W,
      b: candidateData.text.b,
      dim: candidateData.text.dim,
    },
    vision: {
      classes: candidateData.vision.classes,
      W: candidateData.vision.W,
      b: candidateData.vision.b,
      dim: candidateData.vision.dim,
    },
    meta: {
      classes: candidateData.meta.classes,
      W: candidateData.meta.W,
      b: candidateData.meta.b,
      inDim: candidateData.meta.inDim,
    },
  };

  const current = loadStackedHeads(vault);
  let gate: GateResult | null = null;
  if (current && holdout.length > 0) {
    gate = evaluateGate(current, candidate, holdout);
  }

  const { swapped } = decideSwap(gate);

  if (swapped) {
    // Partial-write recovery: if writeStackedHeads throws mid-loop (writes 3 files),
    // it may leave a MIXED state.  Catch and restore to prevent a corrupt head.
    try {
      writeStackedHeads(vault, candidateData);
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      log(`[retrain] write failed (${msg}), restoring previous head`);
      try {
        restorePreviousHeads(vault);
      } catch {
        // Restore is best-effort; log but do not re-throw.
        log("[retrain] restore also failed — vault may need manual inspection");
      }
      return { ran: true, swapped: false, reason: "write failed, restored previous" };
    }
    const classCount = candidate.meta.classes.length;
    const gateMsg = gate
      ? ` overall ${(gate.overallCurrent * 100).toFixed(1)}→${(gate.overallCandidate * 100).toFixed(1)}%`
      : " (first head)";
    log(`[retrain] swapped in candidate (${classCount} classes)${gateMsg}`);
    return {
      ran: true,
      swapped: true,
      reason: gate ? "gate passed" : current === null ? "first head" : "holdout empty, gate skipped",
      gate: gate ?? undefined,
    };
  }

  const failures = gate?.failures.join("; ") ?? "unknown";
  log(`[retrain] candidate rejected (fail-closed), keeping current head: ${failures}`);
  return {
    ran: true,
    swapped: false,
    reason: "gate failed",
    gate: gate ?? undefined,
  };
}
