import type { Vault } from "obsidian";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";
import { TRAINING_SET_VERSION } from "@/config";

export interface TrainingSet {
  version: number;
  positives: Record<string, { category: string; ts: number }>;
  rejections: Record<string, string[]>;
}

export function emptyTrainingSet(): TrainingSet {
  return { version: TRAINING_SET_VERSION, positives: {}, rejections: {} };
}

/** Record a human positive (correction or explicit pick). Latest wins; clears that class
 *  from the item's rejections (an explicit affirm overrides a prior reject). */
export function addPositive(ts: TrainingSet, id: string, category: string, at: number): TrainingSet {
  ts.positives[id] = { category, ts: at };
  const rej = ts.rejections[id];
  if (rej) {
    const next = rej.filter((c) => c !== category);
    if (next.length) ts.rejections[id] = next;
    else delete ts.rejections[id];
  }
  return ts;
}

/** Record a human rejection (id ✗ category). Never adds a positive. */
export function addRejection(ts: TrainingSet, id: string, category: string): TrainingSet {
  const cur = ts.rejections[id] ?? [];
  if (!cur.includes(category)) ts.rejections[id] = [...cur, category];
  return ts;
}

export function rejectedClasses(ts: TrainingSet, id: string): Set<string> {
  return new Set(ts.rejections[id] ?? []);
}

export function suppressionMap(ts: TrainingSet): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [id, cats] of Object.entries(ts.rejections)) {
    if (cats.length) m.set(id, new Set(cats));
  }
  return m;
}

export function categoryCounts(ts: TrainingSet): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { category } of Object.values(ts.positives)) {
    out[category] = (out[category] ?? 0) + 1;
  }
  return out;
}

export function eligibleCategories(ts: TrainingSet, min: number): string[] {
  const counts = categoryCounts(ts);
  return Object.keys(counts).filter((c) => counts[c] >= min).sort();
}

const FILE = "training-set.json";

export function loadTrainingSet(vault: Vault): TrainingSet {
  const raw = loadPipelineCache<unknown>(vault, FILE) as unknown as Partial<TrainingSet>;
  if (!raw || typeof raw !== "object" || !("positives" in raw)) return emptyTrainingSet();
  return {
    version: raw.version ?? TRAINING_SET_VERSION,
    positives: raw.positives ?? {},
    rejections: raw.rejections ?? {},
  };
}

export function saveTrainingSet(vault: Vault, ts: TrainingSet): void {
  // savePipelineCache stores a Record; the TrainingSet object is a valid JSON record.
  savePipelineCache(vault, FILE, ts as unknown as Record<string, unknown>);
}
