import type { Vault } from "obsidian";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";
import { type TrainingSet, addPositive, addRejection } from "@/pipeline/training-set";

export type CategorySnapshot = Record<string, string | null>;
const FILE = "category-snapshot.json";

export function loadSnapshot(vault: Vault): CategorySnapshot {
  return (loadPipelineCache<string | null>(vault, FILE) as CategorySnapshot) ?? {};
}
export function saveSnapshot(vault: Vault, s: CategorySnapshot): void {
  savePipelineCache(vault, FILE, s as Record<string, unknown>);
}

export type Transition = { kind: "correction" | "rejection" | "new" | "none"; from: string | null; to: string | null };

/** Pure: classify a category change. Trust any hand edit (caller is responsible for the
 *  own-write guard). `prev` is the snapshot value; `next` is the new frontmatter value. */
export function classifyTransition(prev: string | null | undefined, next: string | null): Transition {
  const from = prev ?? null;
  if (from === next) return { kind: "none", from, to: next };
  if (from && next) return { kind: "correction", from, to: next };
  if (from && !next) return { kind: "rejection", from, to: null };
  if (!from && next) return { kind: "new", from: null, to: next };
  return { kind: "none", from, to: next };
}

/** Mutate the training set per a transition. Never infers a positive from a rejection. */
export function applyTransition(ts: TrainingSet, id: string, t: Transition, now: number): void {
  if (t.kind === "correction" || t.kind === "new") addPositive(ts, id, t.to!, now);
  else if (t.kind === "rejection") addRejection(ts, id, t.from!);
}
