import type { Vault } from "obsidian";
import { fitLogReg } from "@/pipeline/logreg-fit";
import { softmaxProba, type ClassifierHeadData, type MetaHeadData } from "@/pipeline/classifier-head";
import { loadTrainingSet, eligibleCategories } from "@/pipeline/training-set";
import { loadEmbeddingCache } from "@/pipeline/shared";
import { TRAIN_ELIGIBILITY_MIN, OOF_FOLDS, CONFIRM_CAP_RATIO } from "@/config";

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
  const eligible = new Set(eligibleCategories(ts, TRAIN_ELIGIBILITY_MIN));
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

/** Stratified k-fold: returns a fold index (0..k-1) per sample. Deterministic
 *  given `order` (a permutation of sample indices; pass identity for determinism). */
export function stratifiedKFold(labels: string[], k: number, order: number[]): number[] {
  const byClass = new Map<string, number[]>();
  for (const i of order) {
    const arr = byClass.get(labels[i]) ?? [];
    arr.push(i); byClass.set(labels[i], arr);
  }
  const fold = new Array(labels.length).fill(0);
  for (const arr of byClass.values()) arr.forEach((idx, j) => { fold[idx] = j % k; });
  return fold;
}

function headData(W: number[][], b: number[], classes: string[], dim: number, n: number): ClassifierHeadData {
  return { classes, W, b, dim, norm: "l2", trainedOn: n, version: 1 };
}

/** Core trainer over in-memory rows (vault-free, for tests + the vault wrapper).
 *  `oofFolds` sets the meta-head's out-of-fold split count; the acceptance-gate's
 *  throwaway models pass the cheaper GATE_OOF (fewer inner fits) since they're
 *  never deployed. Defaults to OOF_FOLDS for the deployed head. */
export function trainStackedHeadsFromRows(
  rows: TrainingRow[],
  opts: { oofFolds?: number } = {},
): { text: ClassifierHeadData; vision: ClassifierHeadData; meta: MetaHeadData } | null {
  if (rows.length === 0) return null;
  const classes = [...new Set(rows.map((r) => r.category))].sort();
  const K = classes.length;
  const dim = rows[0].vecText.length;
  const Xt = rows.map((r) => r.vecText);
  const Xv = rows.map((r) => r.vecVision);
  const y = rows.map((r) => r.category);

  const text = fitLogReg(Xt, y, classes, { balanced: true });
  const vision = fitLogReg(Xv, y, classes, { balanced: true });

  // OOF meta features: for each fold, train on the rest, predict_proba on the fold.
  const folds = stratifiedKFold(y, Math.min(opts.oofFolds ?? OOF_FOLDS, minClassCount(y)), y.map((_, i) => i));
  const Pt = oofProba(Xt, y, classes, folds);
  const Pv = oofProba(Xv, y, classes, folds);
  const feat = rows.map((_, i) => [...Pt[i], ...Pv[i]]); // text first, length 2C
  const metaFit = fitLogReg(feat, y, classes, { balanced: true });

  return {
    text: headData(text.W, text.b, classes, dim, rows.length),
    vision: headData(vision.W, vision.b, classes, dim, rows.length),
    meta: { classes, W: metaFit.W, b: metaFit.b, inDim: 2 * K, norm: "none", version: 1 },
  };
}

function minClassCount(y: string[]): number {
  const c = new Map<string, number>();
  for (const l of y) c.set(l, (c.get(l) ?? 0) + 1);
  return Math.max(2, Math.min(...c.values()));
}

/** Out-of-fold softmax probabilities aligned to the global `classes` order. */
function oofProba(X: number[][], y: string[], classes: string[], folds: number[]): number[][] {
  const K = classes.length;
  const P = X.map(() => new Array(K).fill(0));
  // Build a class→global-index map once (O(1) lookup in inner loop vs O(K) indexOf).
  const classIndex = new Map<string, number>(classes.map((c, i) => [c, i]));
  const nFolds = Math.max(...folds) + 1;
  for (let f = 0; f < nFolds; f++) {
    const trIdx: number[] = []; const valIdx: number[] = [];
    for (let i = 0; i < X.length; i++) (folds[i] === f ? valIdx : trIdx).push(i);
    if (trIdx.length === 0 || valIdx.length === 0) continue;
    const foldClasses = [...new Set(trIdx.map((i) => y[i]))].sort();
    const fit = fitLogReg(trIdx.map((i) => X[i]), trIdx.map((i) => y[i]), foldClasses, { balanced: true });
    const head = { classes: foldClasses, W: fit.W, b: fit.b, dim: X[0].length };
    for (const i of valIdx) {
      const proba = softmaxProba(X[i], head); // aligned to foldClasses
      foldClasses.forEach((c, fc) => { P[i][classIndex.get(c)!] = proba[fc]; });
    }
  }
  return P;
}

export function trainStackedHeads(vault: Vault): { text: ClassifierHeadData; vision: ClassifierHeadData; meta: MetaHeadData } | null {
  return trainStackedHeadsFromRows(buildTrainingRows(vault));
}
