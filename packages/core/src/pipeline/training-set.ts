import type { Vault } from "obsidian";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";
import { TRAINING_SET_VERSION, BELONGS_NOTHING } from "@/config";

export interface TrainingSet {
  version: number;
  positives: Record<string, { category: string; ts: number; source?: "correction" | "confirm" }>;
  rejections: Record<string, string[]>;
}

export function emptyTrainingSet(): TrainingSet {
  return { version: TRAINING_SET_VERSION, positives: {}, rejections: {} };
}

/** Record a human positive (correction or explicit pick by default; pass source:"confirm"
 *  for a training-mode agreement). Latest wins; clears that class from the item's rejections.
 *  MUTATES the input TrainingSet in place and returns the same reference. */
export function addPositive(
  ts: TrainingSet,
  id: string,
  category: string,
  at: number,
  source?: "correction" | "confirm",
): TrainingSet {
  ts.positives[id] = source ? { category, ts: at, source } : { category, ts: at };
  const rej = ts.rejections[id];
  if (rej) {
    const next = rej.filter((c) => c !== category);
    if (next.length) ts.rejections[id] = next;
    else delete ts.rejections[id];
  }
  return ts;
}

/** Record a human rejection (id ✗ category). Never adds a positive.
 *  MUTATES the input TrainingSet in place and returns the same reference. */
export function addRejection(ts: TrainingSet, id: string, category: string): TrainingSet {
  const cur = ts.rejections[id] ?? [];
  if (!cur.includes(category)) ts.rejections[id] = [...cur, category];
  return ts;
}

export function rejectedClasses(ts: TrainingSet, id: string): Set<string> {
  return new Set(ts.rejections[id] ?? []);
}

/** Terminal reject: this id fits no category. Rides in the existing rejections list
 *  as the BELONGS_NOTHING sentinel and subsumes any per-category rejections. */
export function markBelongsNothing(ts: TrainingSet, id: string): TrainingSet {
  ts.rejections[id] = [BELONGS_NOTHING];
  delete ts.positives[id];
  return ts;
}
export function isBelongsNothing(ts: TrainingSet, id: string): boolean {
  return (ts.rejections[id] ?? []).includes(BELONGS_NOTHING);
}

export function suppressionMap(ts: TrainingSet): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [id, cats] of Object.entries(ts.rejections)) {
    const real = cats.filter((c) => c !== BELONGS_NOTHING);
    if (real.length) m.set(id, new Set(real));
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
  if (typeof raw !== "object" || !("positives" in raw)) return emptyTrainingSet();
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
