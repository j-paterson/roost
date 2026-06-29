import type { App } from "obsidian";
import { type TrainingSet, addPositive, loadTrainingSet, saveTrainingSet } from "@/pipeline/training-set";
import { SEED_TS } from "@/config";

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

/** Pure: extract seedable labels from a list of frontmatter records. */
export function humanLabelsFromFrontmatter(
  records: Array<Record<string, unknown> | undefined>,
): SeedLabel[] {
  const out: SeedLabel[] = [];
  for (const fm of records) {
    if (!fm) continue;
    if (fm.roost_assigned_by !== "human") continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    const raw = typeof fm.roost_category === "string" ? fm.roost_category.trim() : "";
    if (!raw || raw === "undefined" || raw === "null") continue;
    out.push({ id, category: raw });
  }
  return out;
}

/** Seed the TrainingSet store from every sync-folder human label. Idempotent. */
export function seedTrainingSetFromVault(
  app: App,
  syncFolder: string,
): { seeded: number; byClass: Record<string, number> } {
  const labels = collectHumanLabels(app, syncFolder);
  const ts = loadTrainingSet(app.vault);
  const { seeded, byClass } = seedPositives(labels, ts, SEED_TS);
  saveTrainingSet(app.vault, ts);
  return { seeded, byClass };
}

/** Read sync-folder markdown frontmatter and collect human-labeled seed labels. */
export function collectHumanLabels(app: App, syncFolder: string): SeedLabel[] {
  const records = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(syncFolder + "/"))
    .map((f) => app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined);
  return humanLabelsFromFrontmatter(records);
}
