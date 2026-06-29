import * as fs from "fs";
import type { Vault } from "obsidian";
import { cachePath, cacheDir } from "@/lib/roost-paths";
import { vaultBasePath } from "@/lib/vault-utils";

export type EvalTier = "stacked" | "head" | "centroid" | "llm" | "none";

export interface EvalRecord {
  ts: number;
  roostId: string;
  guess: string | null;
  tier: EvalTier;
  finalLabel: string | null;
  correct: boolean;
  /** Present only for training-mode (confirm/reject feed) actions. Excluded from the
   *  headline organic-holdout accuracy so deliberate confirms cannot inflate it. */
  mode?: "review";
}

/** Records that count toward the clean headline accuracy (the Smart-Assign-confirm-time
 *  organic holdout). Training-mode (mode:"review") records are excluded. */
export function excludeReview(records: EvalRecord[]): EvalRecord[] {
  return records.filter((r) => r.mode !== "review");
}

const FILE = "eval-log.jsonl";

export function appendEvalRecords(vault: Vault, records: EvalRecord[]): void {
  if (!records.length) return;
  const root = vaultBasePath(vault);
  if (!root) return;
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(cachePath(root, FILE), body);
  } catch (e: unknown) {
    console.warn("[roost] eval-log append failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Parse a raw JSONL string into EvalRecords. Each line is parsed independently;
 *  unparseable lines are silently skipped so one corrupt line cannot discard the whole log. */
export function parseEvalLines(raw: string): EvalRecord[] {
  const out: EvalRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as EvalRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function readEvalLog(vault: Vault): EvalRecord[] {
  const root = vaultBasePath(vault);
  if (!root) return [];
  try {
    const raw = fs.readFileSync(cachePath(root, FILE), "utf8");
    return parseEvalLines(raw);
  } catch {
    return [];
  }
}

/** Fading-window accuracy. Each distinct `ts` is one batch; batches are ordered oldest→newest
 *  and weighted `0.5^(ageInBatches / halfLife)` (newest age 0). Returns weighted accuracy
 *  overall, per tier, and per final-label class. */
export function fadingWindowAccuracy(
  records: EvalRecord[],
  halfLifeBatches: number,
): { overall: number; byTier: Record<string, number>; byClass: Record<string, number> } {
  if (!records.length) return { overall: 0, byTier: {}, byClass: {} };
  const batches = [...new Set(records.map((r) => r.ts))].sort((a, b) => a - b);
  const idx = new Map(batches.map((b, i) => [b, i]));
  const lastIdx = batches.length - 1;
  const weightOf = (ts: number) => {
    const age = lastIdx - (idx.get(ts) ?? 0); // newest → 0
    return Math.pow(0.5, age / Math.max(1e-9, halfLifeBatches));
  };
  const acc = (sel: (r: EvalRecord) => boolean) => {
    let num = 0, den = 0;
    for (const r of records) {
      if (!sel(r)) continue;
      const w = weightOf(r.ts);
      den += w;
      if (r.correct) num += w;
    }
    return den ? num / den : 0;
  };
  const tiers = [...new Set(records.map((r) => r.tier))];
  const classes = [...new Set(records.map((r) => r.finalLabel).filter((c): c is string => !!c))];
  const byTier: Record<string, number> = {};
  for (const t of tiers) byTier[t] = acc((r) => r.tier === t);
  const byClass: Record<string, number> = {};
  for (const c of classes) byClass[c] = acc((r) => r.finalLabel === c);
  return { overall: acc(() => true), byTier, byClass };
}
