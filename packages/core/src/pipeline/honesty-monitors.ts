import type { EvalRecord } from "@/pipeline/eval-log";

export interface CorrectionRateFlag {
  category: string;
  batchesSinceWrongCorrected: number;
  flagged: boolean;
}

export interface DriftFlag {
  category: string;
  recentShare: number;
  priorShare: number;
  delta: number;
  flagged: boolean;
}

function batchOrder(records: EvalRecord[]): number[] {
  return [...new Set(records.map((r) => r.ts))].sort((a, b) => a - b);
}

/** For each predicted class, how many of the most-recent batches have passed since the user
 *  last CORRECTED a wrong prediction of it (i.e. a record where guess===category && !correct).
 *  A class still being predicted but never corrected for > windowBatches is flagged (silent-rot). */
export function correctionRateFlags(records: EvalRecord[], windowBatches: number): CorrectionRateFlag[] {
  const batches = batchOrder(records);
  const lastIdx = batches.length - 1;
  const idx = new Map(batches.map((b, i) => [b, i]));
  const predicted = [...new Set(records.map((r) => r.guess).filter((c): c is string => !!c))];
  const out: CorrectionRateFlag[] = [];
  for (const cat of predicted) {
    let lastCorrectionIdx = -1;
    for (const r of records) {
      if (r.guess === cat && !r.correct) {
        lastCorrectionIdx = Math.max(lastCorrectionIdx, idx.get(r.ts) ?? -1);
      }
    }
    const since = lastCorrectionIdx < 0 ? batches.length : lastIdx - lastCorrectionIdx;
    out.push({ category: cat, batchesSinceWrongCorrected: since, flagged: since >= windowBatches });
  }
  return out.sort((a, b) => b.batchesSinceWrongCorrected - a.batchesSinceWrongCorrected);
}

/** Compare each final-label class's share in the older half of batches vs the recent half.
 *  Flag classes whose share moved by more than deltaThreshold (the user's own labeling drifting). */
export function labelDistributionDrift(records: EvalRecord[], deltaThreshold: number): DriftFlag[] {
  const batches = batchOrder(records);
  if (batches.length < 2) return [];
  const mid = Math.floor(batches.length / 2);
  const olderTs = new Set(batches.slice(0, mid));
  const recentTs = new Set(batches.slice(mid));
  const share = (tsSet: Set<number>) => {
    const labels = records.filter((r) => tsSet.has(r.ts) && r.finalLabel).map((r) => r.finalLabel!);
    const total = labels.length || 1;
    const counts: Record<string, number> = {};
    for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
    const s: Record<string, number> = {};
    for (const k of Object.keys(counts)) s[k] = counts[k] / total;
    return s;
  };
  const prior = share(olderTs);
  const recent = share(recentTs);
  const cats = new Set([...Object.keys(prior), ...Object.keys(recent)]);
  const out: DriftFlag[] = [];
  for (const cat of cats) {
    const p = prior[cat] ?? 0;
    const rct = recent[cat] ?? 0;
    const delta = rct - p;
    out.push({ category: cat, recentShare: rct, priorShare: p, delta, flagged: Math.abs(delta) > deltaThreshold });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
