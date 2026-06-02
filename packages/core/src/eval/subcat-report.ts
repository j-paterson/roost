/**
 * Pure formatting + reduction functions for the subcat-methods eval results.
 * Reads the results JSON shape produced by scripts/eval-subcat-methods.mjs and
 * computes the tables the CLI prints to stdout.
 */
import type { Method } from "@/eval/subcat-methods";

export interface CellSummary {
  method: Method;
  floor: number;
  /** Margin or gate threshold for v2 methods. null for v1 methods. */
  secondaryThreshold: number | null;
  positiveAccuracy: number;
  floorCompliance: number;
  combinedAccuracy: number;
  msPer1k: number;
  llmPer1k: number;
}

export function bestPerMethod(cells: CellSummary[]): CellSummary[] {
  const byMethod = new Map<Method, CellSummary>();
  for (const cell of cells) {
    const cur = byMethod.get(cell.method);
    if (!cur) { byMethod.set(cell.method, cell); continue; }
    if (cell.combinedAccuracy > cur.combinedAccuracy) {
      byMethod.set(cell.method, cell);
    } else if (
      cell.combinedAccuracy === cur.combinedAccuracy &&
      cell.msPer1k < cur.msPer1k
    ) {
      byMethod.set(cell.method, cell);
    }
  }
  return [...byMethod.values()];
}

/** A cell is dominated when another cell has both ≥ accuracy and ≤ cost (strict in at least one). */
export function paretoFilter(cells: CellSummary[]): CellSummary[] {
  return cells.filter(a =>
    !cells.some(b =>
      b !== a &&
      b.combinedAccuracy >= a.combinedAccuracy &&
      b.msPer1k <= a.msPer1k &&
      (b.combinedAccuracy > a.combinedAccuracy || b.msPer1k < a.msPer1k)
    )
  );
}

export interface PerItemRow {
  itemId: string;
  parent: string;
  predicted: string | null;
  trueLabel: string | null;
  sim: number;
}

export interface CalibrationBucket {
  bucket: string;
  n: number;
  accuracy: number;
}

const BUCKETS: { label: string; lo: number; hi: number; inclusiveHi: boolean }[] = [
  { label: "[0.5-0.6)", lo: 0.5, hi: 0.6, inclusiveHi: false },
  { label: "[0.6-0.7)", lo: 0.6, hi: 0.7, inclusiveHi: false },
  { label: "[0.7-0.8)", lo: 0.7, hi: 0.8, inclusiveHi: false },
  { label: "[0.8-0.9)", lo: 0.8, hi: 0.9, inclusiveHi: false },
  { label: "[0.9-1.0]", lo: 0.9, hi: 1.0, inclusiveHi: true },
];

export function calibrationBuckets(rows: PerItemRow[]): CalibrationBucket[] {
  const out: CalibrationBucket[] = BUCKETS.map(b => ({ bucket: b.label, n: 0, accuracy: 0 }));
  const correctCounts = new Array(BUCKETS.length).fill(0);
  for (const row of rows) {
    for (let i = 0; i < BUCKETS.length; i++) {
      const b = BUCKETS[i];
      const fitsHi = b.inclusiveHi ? row.sim <= b.hi : row.sim < b.hi;
      if (row.sim >= b.lo && fitsHi) {
        out[i].n++;
        const correct = row.predicted === row.trueLabel;
        if (correct) correctCounts[i]++;
        break;
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i].accuracy = out[i].n === 0 ? 0 : correctCounts[i] / out[i].n;
  }
  return out;
}
