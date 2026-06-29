import { classifyStacked, type StackedHeads } from "@/pipeline/classifier-head";
import { GATE_EPS, GATE_CATASTROPHIC_DROP, GATE_MIN_SUPPORT } from "@/config";

export interface GateSample { vecText: number[]; vecVision: number[]; truth: string }
export interface GateResult {
  pass: boolean;
  overallCurrent: number; overallCandidate: number;
  macroCurrent: number; macroCandidate: number;
  catastrophic: string[];  // classes (with >=GATE_MIN_SUPPORT support) that cratered
  failures: string[];
}

/** Per-class recall + overall accuracy + support counts on `samples`. */
function score(heads: StackedHeads, samples: GateSample[]) {
  const total: Record<string, number> = {}; const right: Record<string, number> = {};
  let overall = 0;
  for (const s of samples) {
    total[s.truth] = (total[s.truth] ?? 0) + 1;
    if (classifyStacked(s.vecText, s.vecVision, heads).category === s.truth) {
      right[s.truth] = (right[s.truth] ?? 0) + 1; overall++;
    }
  }
  const recall: Record<string, number> = {};
  for (const c of Object.keys(total)) recall[c] = (right[c] ?? 0) / total[c];
  const classes = Object.keys(total);
  const macro = classes.length ? classes.reduce((a, c) => a + recall[c], 0) / classes.length : 0;
  return { overall: samples.length ? overall / samples.length : 0, recall, total, macro };
}

/** Aggregate no-regression gate: overall AND macro-recall both not regressing, plus a
 *  catastrophic-collapse guard. Replaces the per-class 5pp veto (which rejected net-beneficial
 *  retrains because they redistribute errors). */
export function evaluateGate(current: StackedHeads, candidate: StackedHeads, samples: GateSample[]): GateResult {
  const cur = score(current, samples); const cand = score(candidate, samples);
  const failures: string[] = []; const catastrophic: string[] = [];
  if (cand.overall < cur.overall - GATE_EPS)
    failures.push(`overall regressed ${((cand.overall - cur.overall) * 100).toFixed(1)}pp`);
  if (cand.macro < cur.macro - GATE_EPS)
    failures.push(`macro-recall regressed ${((cand.macro - cur.macro) * 100).toFixed(1)}pp`);
  for (const c of Object.keys(cur.recall)) {
    if ((cur.total[c] ?? 0) < GATE_MIN_SUPPORT) continue;
    const delta = (cand.recall[c] ?? 0) - cur.recall[c];
    if (delta < -GATE_CATASTROPHIC_DROP) { catastrophic.push(c); failures.push(`class ${c} collapsed ${(delta * 100).toFixed(1)}pp`); }
  }
  return {
    pass: failures.length === 0,
    overallCurrent: cur.overall, overallCandidate: cand.overall,
    macroCurrent: cur.macro, macroCandidate: cand.macro,
    catastrophic, failures,
  };
}
