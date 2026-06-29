import { type TrainingSet, addPositive } from "@/pipeline/training-set";

export interface SeedLabel {
  id: string;
  category: string;
}

/** Seed each label as a correction-source positive at `seedTs`. Mutates `ts`; returns
 *  counts. Skips empty categories. Idempotent by id (addPositive overwrites). */
export function seedPositives(
  labels: SeedLabel[],
  ts: TrainingSet,
  seedTs: number,
): { ts: TrainingSet; seeded: number; byClass: Record<string, number> } {
  const byClass: Record<string, number> = {};
  let seeded = 0;
  for (const { id, category } of labels) {
    const cat = category.trim();
    if (!cat) continue;
    addPositive(ts, id, cat, seedTs); // no source arg = correction (the default; uncapped)
    byClass[cat] = (byClass[cat] ?? 0) + 1;
    seeded++;
  }
  return { ts, seeded, byClass };
}
