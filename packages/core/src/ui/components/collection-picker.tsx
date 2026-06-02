/**
 * Collection picker — searchable, similarity-ranked category selector.
 * Replaces the native <select> in the item overlay.
 * Sections: Recent → Suggested (by embedding similarity) → All (alphabetical).
 */
import { useState, useMemo } from "react";
import * as React from "react";
import { cosineSimilarity } from "@/pipeline/shared";

interface CollectionPickerProps {
  folders: { id: string; name: string }[];
  currentGroupId: string | null;
  recentTargets: string[];
  itemVec: number[] | null;
  collectionCentroids: Record<string, number[]>;
  onSelect: (folderId: string) => void;
}

const MAX_SUGGESTED = 10;

export function CollectionPicker({
  folders, currentGroupId, recentTargets, itemVec, collectionCentroids, onSelect,
}: CollectionPickerProps) {
  const [query, setQuery] = useState("");
  const lowerQuery = query.toLowerCase().trim();

  // Available folders (excluding current group)
  const available = useMemo(
    () => folders.filter(f => f.id !== currentGroupId),
    [folders, currentGroupId],
  );

  // Similarity scores for each folder (only when item has an embedding)
  const simScores = useMemo(() => {
    if (!itemVec) return new Map<string, number>();
    const scores = new Map<string, number>();
    for (const f of available) {
      const centroid = collectionCentroids[f.id];
      if (centroid) scores.set(f.id, cosineSimilarity(itemVec, centroid));
    }
    return scores;
  }, [itemVec, available, collectionCentroids]);

  // Recent targets (valid ones only)
  const recentSection = useMemo(() => {
    if (lowerQuery) return []; // hide recents when searching
    const validIds = new Set(available.map(f => f.id));
    return recentTargets.filter(t => validIds.has(t));
  }, [recentTargets, available, lowerQuery]);

  // Suggested: top N by similarity (excluding recents)
  const suggestedSection = useMemo(() => {
    if (!itemVec || simScores.size === 0) return [];
    const recentSet = new Set(recentSection);
    const scored = available
      .filter(f => !recentSet.has(f.id) && simScores.has(f.id))
      .map(f => ({ id: f.id, name: f.name, sim: simScores.get(f.id)! }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, MAX_SUGGESTED);
    if (lowerQuery) return scored.filter(s => s.name.toLowerCase().includes(lowerQuery));
    return scored;
  }, [itemVec, simScores, available, recentSection, lowerQuery]);

  // All: alphabetical, excluding recent + suggested, filtered by search
  const allSection = useMemo(() => {
    const excludeIds = new Set([
      ...recentSection,
      ...suggestedSection.map(s => s.id),
    ]);
    let list = available.filter(f => !excludeIds.has(f.id));
    if (lowerQuery) list = list.filter(f => f.name.toLowerCase().includes(lowerQuery));
    return list;
  }, [available, recentSection, suggestedSection, lowerQuery]);

  const folderNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.name);
    return m;
  }, [folders]);

  return (
    <div className="roost-picker">
      <input
        className="roost-picker-input"
        type="text"
        placeholder="Search categories..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        autoFocus
      />
      <div className="roost-picker-list">
        {/* Recent */}
        {recentSection.length > 0 && (
          <>
            <div className="roost-picker-section-label">Recent</div>
            {recentSection.map(id => (
              <div key={id} className="roost-picker-row" onClick={() => onSelect(id)}>
                <span>{folderNameById.get(id) ?? id}</span>
              </div>
            ))}
          </>
        )}

        {/* Suggested */}
        {suggestedSection.length > 0 && (
          <>
            <div className="roost-picker-section-label">Suggested</div>
            {suggestedSection.map(s => (
              <div key={s.id} className="roost-picker-row" onClick={() => onSelect(s.id)}>
                <span>{s.name}</span>
                <span className="roost-picker-sim">{Math.round(s.sim * 100)}%</span>
              </div>
            ))}
          </>
        )}

        {/* All */}
        {allSection.length > 0 && (
          <>
            {(recentSection.length > 0 || suggestedSection.length > 0) && (
              <div className="roost-picker-section-label">All</div>
            )}
            {allSection.map(f => {
              const sim = simScores.get(f.id);
              return (
                <div key={f.id} className="roost-picker-row" onClick={() => onSelect(f.id)}>
                  <span>{f.name}</span>
                  {sim != null && <span className="roost-picker-sim">{Math.round(sim * 100)}%</span>}
                </div>
              );
            })}
          </>
        )}

        {/* Empty state */}
        {recentSection.length === 0 && suggestedSection.length === 0 && allSection.length === 0 && (
          <div className="roost-picker-row" style={{ color: "var(--text-faint)" }}>
            No matching categories
          </div>
        )}
      </div>
    </div>
  );
}
