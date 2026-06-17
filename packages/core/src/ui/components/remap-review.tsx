import { useState } from "react";
import * as React from "react";
import type { MappingSuggestion, ResolvedMapping } from "@/lib/collection-remap";

export interface RemapReviewProps {
  suggestions: MappingSuggestion[];
  /** Existing category names, for the "change target" suggestions. */
  categoryNames: string[];
  onConfirm: (resolved: ResolvedMapping[]) => void;
  onCancel: () => void;
}

type Row = { platform: string; collection: string; target: string; include: boolean; sim: number | null };

export function RemapReview({ suggestions, categoryNames, onConfirm, onCancel }: RemapReviewProps) {
  const [rows, setRows] = useState<Row[]>(
    suggestions.map((s) => ({
      platform: s.platform,
      collection: s.collection,
      target: s.target,
      include: s.action !== "skip", // already-aliased rows default to excluded
      sim: s.sim,
    })),
  );

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const targets = Array.from(new Set([...categoryNames, ...rows.map((r) => r.target)])).sort();

  return (
    <div className="roost-remap-review">
      <h3>Reconcile collection mappings</h3>
      <table>
        <thead>
          <tr><th>Use</th><th>Collection</th><th>&rarr; Category</th><th>Match</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.platform}:${r.collection}`}>
              <td><input type="checkbox" checked={r.include} onChange={(e) => setRow(i, { include: e.target.checked })} /></td>
              <td>{r.platform}: {r.collection}</td>
              <td>
                <input list="roost-remap-targets" value={r.target} onChange={(e) => setRow(i, { target: e.target.value })} />
              </td>
              <td>{r.sim == null ? "—" : r.sim.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="roost-remap-targets">
        {targets.map((t) => <option key={t} value={t} />)}
      </datalist>
      <div className="roost-remap-actions">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="mod-cta"
          onClick={() =>
            onConfirm(
              rows.filter((r) => r.include && r.target.trim())
                .map((r) => ({ platform: r.platform, collection: r.collection, target: r.target.trim() })),
            )
          }
        >Save mappings</button>
      </div>
    </div>
  );
}
