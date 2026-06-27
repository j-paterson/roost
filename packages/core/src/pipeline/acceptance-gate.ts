import { classifyStacked, type StackedHeads } from "@/pipeline/classifier-head";
import { RETRAIN_CAT_MARGIN } from "@/config";

export interface GateSample { vecText: number[]; vecVision: number[]; truth: string }
export interface GateResult {
  pass: boolean;
  overallCurrent: number;
  overallCandidate: number;
  perClass: Record<string, { current: number; candidate: number; delta: number }>;
  failures: string[];
}

function accuracyByClass(heads: StackedHeads, samples: GateSample[]) {
  const total: Record<string, number> = {}; const right: Record<string, number> = {};
  let overall = 0;
  for (const s of samples) {
    total[s.truth] = (total[s.truth] ?? 0) + 1;
    const pred = classifyStacked(s.vecText, s.vecVision, heads).category;
    if (pred === s.truth) { right[s.truth] = (right[s.truth] ?? 0) + 1; overall++; }
  }
  const perClass: Record<string, number> = {};
  for (const c of Object.keys(total)) perClass[c] = (right[c] ?? 0) / total[c];
  return { overall: samples.length ? overall / samples.length : 0, perClass };
}

/** Fail-closed no-regression gate (ports acceptance-gate-stacking.py):
 *  candidate must (1) not drop overall accuracy, and (2) not drop any class by > catMargin. */
export function evaluateGate(
  current: StackedHeads, candidate: StackedHeads, samples: GateSample[],
  catMargin = RETRAIN_CAT_MARGIN,
): GateResult {
  const cur = accuracyByClass(current, samples);
  const cand = accuracyByClass(candidate, samples);
  const perClass: GateResult["perClass"] = {};
  const failures: string[] = [];
  for (const c of Object.keys(cur.perClass)) {
    const a = cur.perClass[c]; const b = cand.perClass[c] ?? 0;
    const delta = b - a;
    perClass[c] = { current: a, candidate: b, delta };
    if (delta < -catMargin) failures.push(`class ${c} regressed ${(delta * 100).toFixed(1)}pp`);
  }
  if (cand.overall < cur.overall) failures.push(`overall regressed ${((cand.overall - cur.overall) * 100).toFixed(1)}pp`);
  return { pass: failures.length === 0, overallCurrent: cur.overall, overallCandidate: cand.overall, perClass, failures };
}
