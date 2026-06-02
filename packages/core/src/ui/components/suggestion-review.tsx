/**
 * Suggestion review — React checklist for selecting which neighbor items to bulk move.
 * Rendered inside the SuggestionModal.
 */
import { useState, useMemo } from "react";
import * as React from "react";

export interface SuggestionItem {
  itemId: string;
  title: string;
  coverUrl?: string;
  author?: string;
  similarity: number;
}

interface SuggestionReviewProps {
  targetName: string;
  items: SuggestionItem[];
  onMoveSelected: (itemIds: string[]) => void;
  onDismiss: () => void;
}

export function SuggestionReview({ targetName, items, onMoveSelected, onDismiss }: SuggestionReviewProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map(i => i.itemId)));

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = selected.size === items.length;
  const noneSelected = selected.size === 0;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map(i => i.itemId)));
    }
  };

  const selectedCount = selected.size;

  return (
    <div className="roost-sugg-review">
      <h3 className="roost-sugg-review-title">
        {items.length} similar item{items.length !== 1 ? "s" : ""} found
      </h3>
      <p className="roost-sugg-review-desc">
        These items may also belong in &ldquo;{targetName}&rdquo;. Select which ones to move.
      </p>

      {/* Select all / deselect all */}
      <div className="roost-sugg-review-toolbar">
        <label className="roost-sugg-review-select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            ref={(el) => { if (el) el.indeterminate = !allSelected && !noneSelected; }}
          />
          <span>{allSelected ? "Deselect all" : "Select all"}</span>
        </label>
        <span className="roost-sugg-review-count">{selectedCount} selected</span>
      </div>

      {/* Item list */}
      <div className="roost-sugg-review-list">
        {items.map(item => (
          <label key={item.itemId} className={`roost-sugg-review-row ${selected.has(item.itemId) ? "is-selected" : ""}`}>
            <input
              type="checkbox"
              checked={selected.has(item.itemId)}
              onChange={() => toggle(item.itemId)}
            />
            {item.coverUrl && (
              <img src={item.coverUrl} className="roost-sugg-review-thumb" alt="" />
            )}
            <div className="roost-sugg-review-info">
              <div className="roost-sugg-review-item-title">{item.title || item.itemId}</div>
              {item.author && <div className="roost-sugg-review-author">{item.author}</div>}
            </div>
            <span className="roost-sugg-review-sim">{Math.round(item.similarity * 100)}%</span>
          </label>
        ))}
      </div>

      {/* Actions */}
      <div className="roost-sugg-review-actions">
        <button
          className="mod-cta"
          disabled={noneSelected}
          onClick={() => onMoveSelected([...selected])}
        >
          Move {selectedCount} item{selectedCount !== 1 ? "s" : ""}
        </button>
        <button onClick={onDismiss}>No thanks</button>
      </div>
    </div>
  );
}
