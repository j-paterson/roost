/**
 * Prediction wrappers for the three scoring methods compared by the eval suite.
 *
 * Each method consumes (itemVec, categoryDefs, floor) and returns a Prediction.
 * Cosine-only is implemented inline with pure dot products; T1-only and full
 * ensemble dispatch through scoreAgainstCategories with appropriate flags.
 */
import type { CategoryDef } from "@/pipeline/evaluate";
import { scoreAgainstCategories } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";

export interface Prediction {
  predictedSubcat: string | null;
  sim: number;
  latencyMs: number;
  llmCalls: number;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function magnitude(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: number[], b: number[]): number {
  const m = magnitude(a) * magnitude(b);
  return m === 0 ? 0 : dot(a, b) / m;
}

export function predictCosine(
  itemVec: number[],
  categories: CategoryDef[],
  floor: number,
): Prediction {
  const startMs = Date.now();
  if (categories.length === 0) {
    return { predictedSubcat: null, sim: 0, latencyMs: Date.now() - startMs, llmCalls: 0 };
  }
  let bestName: string | null = null;
  let bestSim = -Infinity;
  for (const c of categories) {
    const s = cosine(itemVec, c.centroid);
    if (s > bestSim) { bestSim = s; bestName = c.name; }
  }
  const finalSim = bestSim === -Infinity ? 0 : bestSim;
  return {
    predictedSubcat: finalSim >= floor ? bestName : null,
    sim: finalSim,
    latencyMs: Date.now() - startMs,
    llmCalls: 0,
  };
}

async function dispatchScoring(
  itemId: string,
  cache: Record<string, EmbeddingCacheEntry>,
  categories: CategoryDef[],
  floor: number,
  disableT2: boolean,
): Promise<Prediction> {
  const startMs = Date.now();
  const result = await scoreAgainstCategories({
    itemIds: [itemId],
    cache,
    categories,
    threshold: floor,
    disableT2Rerank: disableT2,
    onLog: () => {},
  });
  const latencyMs = Date.now() - startMs;
  // LLM call counts here are theoretical-max (1 for T1-only, 2 for ensemble);
  // scoreAgainstCategories may short-circuit via its on-disk score cache so the
  // report's LLM/1k column reflects "would have been called" not "actually called".
  // For the eval we run on a cold cache, so the two are equal.
  const llmCalls = disableT2 ? 1 : 2;
  const assigned = result.assignments.get(itemId);
  if (assigned) {
    const detail = result.matchDetails.get(itemId);
    const sim = detail?.sim ?? 0;
    return { predictedSubcat: assigned, sim, latencyMs, llmCalls };
  }
  // Unmatched — either parse failure or below the simThreshold floor.
  // Recover the chosen-candidate sim from the topCentroids of the (missing)
  // matchDetail by recomputing cosine against the highest-cosine centroid.
  const itemVec = cache[itemId]?.vec ?? [];
  let bestSim = 0;
  for (const c of categories) {
    const s = cosine(itemVec, c.centroid);
    if (s > bestSim) bestSim = s;
  }
  return { predictedSubcat: null, sim: bestSim, latencyMs, llmCalls };
}

export async function predictT1(
  itemId: string,
  cache: Record<string, EmbeddingCacheEntry>,
  categories: CategoryDef[],
  floor: number,
): Promise<Prediction> {
  return dispatchScoring(itemId, cache, categories, floor, true);
}

export async function predictEnsemble(
  itemId: string,
  cache: Record<string, EmbeddingCacheEntry>,
  categories: CategoryDef[],
  floor: number,
): Promise<Prediction> {
  return dispatchScoring(itemId, cache, categories, floor, false);
}

/**
 * T1 + margin rejection. After T1 picks a subcategory, compute the cosine sim
 * of the runner-up subcategory. If pickedSim - runnerUpSim < marginThreshold,
 * return null (parent fallback). Otherwise return T1's pick.
 *
 * Zero new LLM calls — the runner-up sim is computed from the same centroids
 * predictT1 already had access to.
 */
export async function predictT1Margin(
  itemId: string,
  cache: Record<string, EmbeddingCacheEntry>,
  categories: CategoryDef[],
  floor: number,
  marginThreshold: number,
): Promise<Prediction> {
  const t1 = await predictT1(itemId, cache, categories, floor);
  // T1 already returned null due to floor → no margin check needed.
  if (t1.predictedSubcat === null) return t1;
  // Compute all candidate sims and find the runner-up.
  const itemVec = cache[itemId]?.vec ?? [];
  const sims = categories.map(c => ({ name: c.name, sim: cosine(itemVec, c.centroid) }));
  sims.sort((a, b) => b.sim - a.sim);
  const pickedSim = sims.find(s => s.name === t1.predictedSubcat)?.sim ?? 0;
  const runnerUp = sims.find(s => s.name !== t1.predictedSubcat);
  const margin = runnerUp ? pickedSim - runnerUp.sim : pickedSim;
  if (margin < marginThreshold) {
    return { ...t1, predictedSubcat: null };
  }
  return t1;
}

/**
 * T1 + top-level confidence gate. Compute the item's cosine against the parent's
 * centroid; if below gateThreshold, return null without invoking T1. Otherwise
 * dispatch to predictT1.
 *
 * Saves an LLM call on items that aren't a strong fit for the parent category.
 */
export async function predictT1Gate(
  itemId: string,
  cache: Record<string, EmbeddingCacheEntry>,
  categories: CategoryDef[],
  floor: number,
  parentCentroid: number[] | null,
  gateThreshold: number,
): Promise<Prediction> {
  const startMs = Date.now();
  const itemVec = cache[itemId]?.vec ?? [];
  if (!parentCentroid) {
    return { predictedSubcat: null, sim: 0, latencyMs: Date.now() - startMs, llmCalls: 0 };
  }
  const parentSim = cosine(itemVec, parentCentroid);
  if (parentSim < gateThreshold) {
    return { predictedSubcat: null, sim: parentSim, latencyMs: Date.now() - startMs, llmCalls: 0 };
  }
  return predictT1(itemId, cache, categories, floor);
}

import { buildCategoryDefs } from "@/pipeline/evaluate";
import type { ScenarioFile, ScenarioParent } from "@/eval/subcat-scenarios";

export type Method = "cosine" | "t1" | "ensemble" | "t1-margin" | "t1-gate" | "t1-none";

export interface PerItemResult {
  itemId: string;
  parent: string;
  trueLabel: string | null;       // null = negative (should route to parent)
  predicted: string | null;
  sim: number;
}

export interface CellMetrics {
  positiveAccuracy: number;
  floorCompliance: number;
  combinedAccuracy: number;
  wallTimeMs: number;
  llmCalls: number;
}

export interface CellResult {
  method: Method;
  floor: number;
  /** Secondary threshold for methods that take one (margin or gate). null otherwise. */
  secondaryThreshold: number | null;
  metrics: CellMetrics;
  perItem: PerItemResult[];
}

export interface RunCellOpts {
  method: Method;
  floor: number;
  /** Required for "t1-margin" — minimum gap between picked sim and runner-up sim. */
  marginThreshold?: number;
  /** Required for "t1-gate" — minimum sim against parentCentroid to bother calling T1. */
  gateThreshold?: number;
  scenarios: ScenarioFile;
  cache: Record<string, EmbeddingCacheEntry>;
  /** Optional: limit positives/negatives per parent. Used for smoke runs. */
  limitPerParent?: number;
  /** Called once per item completion for progress UI. */
  onProgress: (done: number, total: number) => void;
  /** Defaults to a no-op map. Used for blended centroids on empty subcats. */
  nameEmbeddings?: Map<string, number[]>;
}

function buildAnchorsLOO(
  parent: ScenarioParent,
  excludeItemId: string,
): Record<string, string[]> {
  const anchors: Record<string, string[]> = {};
  for (const sub of parent.subcategories) anchors[sub] = [];
  for (const pos of parent.positives) {
    if (pos.itemId === excludeItemId) continue;
    if (!anchors[pos.trueSubcat]) continue;
    anchors[pos.trueSubcat].push(pos.itemId);
  }
  return anchors;
}

async function predict(
  method: Method,
  itemId: string,
  itemVec: number[],
  cats: CategoryDef[],
  floor: number,
  cache: Record<string, EmbeddingCacheEntry>,
  opts: { marginThreshold?: number; gateThreshold?: number; parentCentroid: number[] | null },
): Promise<Prediction> {
  if (method === "cosine") return predictCosine(itemVec, cats, floor);
  if (method === "t1") return predictT1(itemId, cache, cats, floor);
  if (method === "ensemble") return predictEnsemble(itemId, cache, cats, floor);
  if (method === "t1-margin") {
    return predictT1Margin(itemId, cache, cats, floor, opts.marginThreshold ?? 0);
  }
  if (method === "t1-gate") {
    return predictT1Gate(itemId, cache, cats, floor, opts.parentCentroid, opts.gateThreshold ?? 0);
  }
  return predictT1None(itemId, cache, cats, floor);
}

export async function runCell(opts: RunCellOpts): Promise<CellResult> {
  const { method, floor, scenarios, cache, limitPerParent, onProgress, nameEmbeddings, marginThreshold, gateThreshold } = opts;
  const startMs = Date.now();
  const perItem: PerItemResult[] = [];
  let llmCalls = 0;

  const allItems: { parent: ScenarioParent; itemId: string; trueLabel: string | null }[] = [];
  for (const p of scenarios.parents) {
    const positives = limitPerParent ? p.positives.slice(0, limitPerParent) : p.positives;
    const negatives = limitPerParent ? p.negatives.slice(0, limitPerParent) : p.negatives;
    for (const pos of positives) allItems.push({ parent: p, itemId: pos.itemId, trueLabel: pos.trueSubcat });
    for (const neg of negatives) allItems.push({ parent: p, itemId: neg.itemId, trueLabel: null });
  }
  const total = allItems.length;
  let done = 0;

  for (const { parent, itemId, trueLabel } of allItems) {
    const itemEntry = cache[itemId];
    if (!itemEntry?.vec) {
      // Missing embedding — exclude from this cell's metrics entirely.
      // The eval assumes 100% embedding coverage on the live vault; if items
      // were missing it'd indicate a corrupted cache, not a quality signal.
      done++; onProgress(done, total);
      continue;
    }
    const anchors = buildAnchorsLOO(parent, itemId);
    const cats = buildCategoryDefs(anchors, new Map(), cache, undefined, undefined, nameEmbeddings ?? new Map());
    if (cats.length === 0) {
      // No category centroids could be built (e.g. all siblings also missing
      // embeddings) — exclude from metrics for the same reason as above.
      done++; onProgress(done, total);
      continue;
    }
    const p = await predict(method, itemId, itemEntry.vec, cats, floor, cache, {
      marginThreshold,
      gateThreshold,
      parentCentroid: parent.parentCentroid,
    });
    llmCalls += p.llmCalls;
    perItem.push({
      itemId,
      parent: parent.parent,
      trueLabel,
      predicted: p.predictedSubcat,
      sim: p.sim,
    });
    done++; onProgress(done, total);
  }

  const positives = perItem.filter(r => r.trueLabel !== null);
  const negatives = perItem.filter(r => r.trueLabel === null);
  const positiveCorrect = positives.filter(r => r.predicted === r.trueLabel).length;
  const negativeCorrect = negatives.filter(r => r.predicted === null).length;
  const positiveAccuracy = positives.length === 0 ? 0 : positiveCorrect / positives.length;
  const floorCompliance = negatives.length === 0 ? 0 : negativeCorrect / negatives.length;
  const combinedAccuracy = perItem.length === 0
    ? 0
    : (positiveCorrect + negativeCorrect) / perItem.length;

  const secondaryThreshold = method === "t1-margin"
    ? marginThreshold ?? null
    : method === "t1-gate"
      ? gateThreshold ?? null
      : null;
  return {
    method,
    floor,
    secondaryThreshold,
    metrics: {
      positiveAccuracy,
      floorCompliance,
      combinedAccuracy,
      wallTimeMs: Date.now() - startMs,
      llmCalls,
    },
    perItem,
  };
}

/**
 * T1-NONE: a modified T1 prompt that lets the LLM refuse with "N: none of these
 * fit". Wrapper around scoreAgainstCategories({ noneRefusal: true }) for eval
 * compatibility — preserves the original Prediction-shaped return type.
 */
export async function predictT1None(
  itemId: string,
  cache: Record<string, EmbeddingCacheEntry>,
  categories: CategoryDef[],
  floor: number,
): Promise<Prediction> {
  const startMs = Date.now();
  const result = await scoreAgainstCategories({
    itemIds: [itemId],
    cache,
    categories,
    threshold: floor,
    noneRefusal: true,
    onLog: () => {},
  });
  const latencyMs = Date.now() - startMs;
  const llmCalls = 1;
  const assigned = result.assignments.get(itemId);
  if (assigned) {
    const detail = result.matchDetails.get(itemId);
    return { predictedSubcat: assigned, sim: detail?.sim ?? 0, latencyMs, llmCalls };
  }
  // Unmatched (LLM picked N, or below floor, or parse failure). Recover sim
  // from cosine for diagnostic purposes.
  const itemVec = cache[itemId]?.vec ?? [];
  let bestSim = 0;
  for (const c of categories) {
    const s = cosine(itemVec, c.centroid);
    if (s > bestSim) bestSim = s;
  }
  return { predictedSubcat: null, sim: bestSim, latencyMs, llmCalls };
}
