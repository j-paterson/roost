/**
 * Item modal — Obsidian Modal wrapper for the move-to picker. Opened from
 * the gallery card's "Move to…" action. Renders a compact picker-only view
 * (header + CollectionPicker + post-move suggestion banner). The previous
 * version mounted a full mini expanded card via ItemOverlay, but the inline
 * gallery card now serves the "view item" need so the modal narrowed down
 * to its single remaining job: pick a destination.
 */
import { Modal, App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { CollectionPicker } from "./collection-picker";

export interface OverlayItem {
  roostId: string;
  title: string;
  filePath: string;
}

interface SuggestionData {
  count: number;
  targetName: string;
  itemIds: string[];
}

interface ItemModalOpts {
  app: App;
  item: OverlayItem;
  currentGroupId: string | null;
  proposedFolders: { id: string; name: string }[];
  onMove: (itemId: string, fromGroupId: string, toGroupId: string) => void;
  suggestions: SuggestionData | null;
  onAcceptSuggestions: (itemIds: string[]) => void;
  onDismissSuggestions: () => void;
  onReviewSuggestions: (itemIds: string[]) => void;
  itemVec: number[] | null;
  collectionCentroids: Record<string, number[]>;
  recentTargets: string[];
}

interface CompactProps {
  item: OverlayItem;
  currentGroupId: string | null;
  proposedFolders: { id: string; name: string }[];
  onClose: () => void;
  onMove: (itemId: string, fromGroupId: string, toGroupId: string) => void;
  suggestions: SuggestionData | null;
  onAcceptSuggestions: (itemIds: string[]) => void;
  onDismissSuggestions: () => void;
  onReviewSuggestions: (itemIds: string[]) => void;
  itemVec: number[] | null;
  collectionCentroids: Record<string, number[]>;
  recentTargets: string[];
}

function CompactMoveView({
  item, currentGroupId, proposedFolders,
  onClose, onMove,
  suggestions, onAcceptSuggestions, onDismissSuggestions, onReviewSuggestions,
  itemVec, collectionCentroids, recentTargets,
}: CompactProps) {
  return (
    <div className="roost-move-modal">
      <div className="roost-move-title" title={item.title || item.filePath}>
        Move <strong>{item.title || item.filePath}</strong>
      </div>
      <CollectionPicker
        folders={proposedFolders}
        currentGroupId={currentGroupId}
        recentTargets={recentTargets}
        itemVec={itemVec}
        collectionCentroids={collectionCentroids}
        onSelect={(toGroupId) => {
          if (toGroupId !== currentGroupId) {
            onMove(item.roostId, currentGroupId ?? "", toGroupId);
          }
        }}
      />
      {suggestions && (
        <div className="roost-suggestions">
          <div className="roost-suggestion-text">
            {suggestions.count} similar item{suggestions.count !== 1 ? "s" : ""} may also belong in {"“"}{suggestions.targetName}{"”"}
          </div>
          <div className="roost-suggestion-actions">
            <button className="roost-nav-btn" onClick={() => { onClose(); onReviewSuggestions(suggestions.itemIds); }}>Review</button>
            <button className="roost-nav-btn" onClick={() => onAcceptSuggestions(suggestions.itemIds)}>Move all</button>
            <button className="roost-nav-btn" onClick={onDismissSuggestions}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

export class ItemModal extends Modal {
  private root: Root | null = null;
  private opts: ItemModalOpts;

  constructor(opts: ItemModalOpts) {
    super(opts.app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("roost-modal-content");
    const mountEl = contentEl.createDiv();
    this.root = createRoot(mountEl);
    this.render();
  }

  /** Re-render with optionally-different suggestions. Used to clear the
   *  post-move banner after Accept/Dismiss without tearing the modal down. */
  render(suggestions?: SuggestionData | null) {
    if (!this.root) return;
    const opts = this.opts;
    const sugg = suggestions !== undefined ? suggestions : opts.suggestions;

    this.root.render(
      <CompactMoveView
        key={opts.item?.roostId ?? "no-item"}
        item={opts.item}
        currentGroupId={opts.currentGroupId}
        proposedFolders={opts.proposedFolders}
        onClose={() => this.close()}
        onMove={(itemId, from, to) => opts.onMove(itemId, from, to)}
        suggestions={sugg}
        itemVec={opts.itemVec}
        collectionCentroids={opts.collectionCentroids}
        recentTargets={opts.recentTargets}
        onAcceptSuggestions={(ids) => {
          opts.onAcceptSuggestions(ids);
          this.render(null);
        }}
        onDismissSuggestions={() => {
          opts.onDismissSuggestions();
          this.render(null);
        }}
        onReviewSuggestions={(ids) => {
          opts.onReviewSuggestions(ids);
          this.close();
        }}
      />
    );
  }

  onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
