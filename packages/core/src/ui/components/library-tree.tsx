import { useState } from "react";
import * as React from "react";
import { Menu, Notice } from "obsidian";
import { Button } from "@/ui/components/ui/button";
import type { Platform } from "@/types/sync";
import type { RoostFilter } from "@/types/roost";
import type { PipelineRunResult } from "@/lib/enrichments";
import { DEV_COMMANDS_ENABLED } from "@/config";

export type PipelineRowState = {
  status: "idle" | "running" | "done" | "error";
  controller?: AbortController;
  result?: PipelineRunResult;
  error?: string;
  finishedAt?: number;
};

function formatRelative(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

/** Inline text input for renaming tree items. */
function InlineRenameInput({ defaultValue, onConfirm, onCancel }: {
  defaultValue: string;
  onConfirm: (newValue: string) => void;
  onCancel: () => void;
}) {
  const committed = React.useRef(false);
  const tryCommit = (el: HTMLInputElement) => {
    if (committed.current) return;
    committed.current = true;
    const val = el.value.trim();
    if (val && val !== defaultValue) onConfirm(val);
    else onCancel();
  };
  return (
    <input
      className="roost-inline-rename"
      defaultValue={defaultValue}
      ref={(el) => { if (el) { el.focus(); el.select(); } }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") tryCommit(e.currentTarget);
        if (e.key === "Escape") { committed.current = true; onCancel(); }
      }}
      onBlur={(e) => tryCommit(e.currentTarget)}
    />
  );
}

interface SubcategoryEntry {
  name: string;
  count: number;
}

interface LibraryTreeProps {
  total: number;
  unsorted: number;
  categories: { name: string; count: number; subcategories?: SubcategoryEntry[] }[];
  pipelineCategories?: Set<string>;
  platforms: { name: string; display: string; total: number }[];
  activeFilter: RoostFilter;
  activePlatform: Platform | null;
  syncingPlatform: Platform | null;
  syncing: boolean;
  importing: boolean;
  onFilter: (filter: RoostFilter) => void;
  onShowPlatform: (platform: Platform) => void;
  onHidePlatform: () => void;
  onSync: (platform: Platform) => void;
  onImportEagle: () => void;
  /** Triggered from the tree-row context menu. The MouseEvent is from the
   *  click on the menu item itself (Obsidian threads it through the Menu
   *  callback) — the handler uses it to position the confirmation menu so
   *  the user doesn't have to traverse the screen to confirm. */
  onDeleteCategory?: (category: string, event: MouseEvent) => void;
  onCreateSubcategory?: (category: string) => void;
  onDeleteSubcategory?: (category: string, subcategory: string, event: MouseEvent) => void;
  onRenameCategory?: (oldName: string, newName: string) => Promise<void>;
  onRenameSubcategory?: (category: string, oldName: string, newName: string) => Promise<void>;
  onResort?: (category: string) => void;
  onSortIntoSubcategories?: (category: string) => void;
  /** When true, Resort/Sort menu items are disabled (pipeline running). */
  smartAssignBusy?: boolean;
  /** Per-category pipeline run state, keyed by category name. */
  pipelineState?: Record<string, PipelineRowState>;
  /** Run a pipeline scoped to a category, or to a specific subcategory
   *  within that category. Subcategory-scoped runs let users iterate on a
   *  bucket (e.g. only re-extract Media/Books) without churning siblings. */
  onRunPipeline?: (category: string, subcategory?: string) => void;
  onCancelPipeline?: (category: string, subcategory?: string) => void;
  /** When set, Run is disabled for categories whose pipeline is off or lacks an LLM. */
  isPipelineRunnable?: (category: string) => boolean;
  /** Drag-to-renest: drop a folder onto another folder, or drag a subcategory
   *  out to the promote zone to lift it to top-level. The handler validates
   *  the operation and confirms with the user before rewriting frontmatter. */
  onRenest?: (
    source: { category: string; subcategory?: string },
    target: { category: string } | "root",
  ) => void;
  /** Drag-to-reorder: drop near the bottom edge of a row to insert the
   *  dragged folder immediately after that row in the sidebar. Only valid
   *  for same-tier moves (top-level → top-level position, or subcategory →
   *  position within the same parent). The handler persists the new order
   *  to settings and triggers a re-render.
   *
   *  Note: there's no "insert before" semantic — every gap is reachable as
   *  "after" the row above it, so we removed the "before" duplicate. The
   *  one position that's unreachable is "absolute first": to put X at the
   *  top, drag whatever's currently first to be after X. */
  onReorder?: (
    source: { category: string; subcategory?: string },
    target: { category: string; subcategory?: string },
  ) => void;
}

const DRAG_MIME = "application/x-roost-folder";

function encodeDragPayload(category: string, subcategory?: string): string {
  return subcategory ? `${category}\x00${subcategory}` : category;
}

function decodeDragPayload(s: string): { category: string; subcategory?: string } | null {
  if (!s) return null;
  const idx = s.indexOf("\x00");
  if (idx === -1) return { category: s };
  return { category: s.slice(0, idx), subcategory: s.slice(idx + 1) };
}

type DropZone = "into" | "after";

/** Map cursor Y inside a tree row to a drop zone. Top 60% drops "into" the
 *  row (renest); bottom 40% inserts immediately after the row in the sibling
 *  list. There's no "before" zone — the gap above row N is the same insertion
 *  point as "after row N-1", so we let the row above own each gap. */
function getDropZone(e: React.DragEvent<HTMLElement>): DropZone {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height || 1;
  return y > h * 0.6 ? "after" : "into";
}

function LibraryTreeImpl({
  total, unsorted, categories, pipelineCategories, platforms, activeFilter, activePlatform, syncingPlatform, syncing, importing,
  onFilter, onShowPlatform, onHidePlatform, onSync, onImportEagle, onDeleteCategory,
  onCreateSubcategory, onDeleteSubcategory, onRenameCategory, onRenameSubcategory,
  onResort, onSortIntoSubcategories, smartAssignBusy,
  pipelineState, onRunPipeline, onCancelPipeline, isPipelineRunnable, onRenest, onReorder,
}: LibraryTreeProps) {
  // Tracks the folder currently being dragged. Drives visibility of the
  // "promote to top-level" drop zone (only valid when a subcategory is being
  // dragged) and lets dragOver validate target compatibility before painting.
  const [dragging, setDragging] = useState<{ category: string; subcategory?: string } | null>(null);
  const hasItems = total > 0 || syncing;
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => {
    const expanded = new Set<string>();
    for (const cat of categories) {
      if (cat.subcategories && cat.subcategories.length > 0) expanded.add(cat.name);
    }
    return expanded;
  });

  const toggleExpand = (name: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const [editing, setEditing] = useState<
    | null
    | { type: "category"; name: string }
    | { type: "subcategory"; category: string; name: string }
  >(null);

  return (
    <div className="flex-1 overflow-y-auto">
      {!hasItems && (
        <div style={{ padding: "16px 12px", color: "var(--text-muted)" }}>
          <div style={{ textAlign: "center", marginBottom: 12, fontSize: "var(--font-ui-small)" }}>
            No bookmarks yet
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Button
              size="sm" variant="secondary" style={{ width: "100%" }}
              onClick={() => { onShowPlatform("tiktok"); }}
            >
              Log in to TikTok
            </Button>
            <Button
              size="sm" variant="secondary" style={{ width: "100%" }}
              onClick={() => { onShowPlatform("twitter"); }}
            >
              Log in to X / Twitter
            </Button>
            {DEV_COMMANDS_ENABLED && (
              <Button
                size="sm" variant="secondary" style={{ width: "100%" }}
                onClick={() => { onShowPlatform("instagram"); }}
              >
                Log in to Instagram
              </Button>
            )}
            <Button
              size="sm" variant="secondary" style={{ width: "100%" }}
              onClick={onImportEagle} loading={importing}
            >
              {importing ? "Importing…" : "Import from Eagle"}
            </Button>
          </div>
        </div>
      )}

      {(platforms.length > 0 || hasItems) && (
        <div className="roost-sync-strip">
          {platforms.map(p => (
            <div key={p.name} className="roost-sync-strip-platform">
              <span className="roost-sync-strip-name">{p.display}</span>
              <Button
                variant="ghost" size="icon-xs"
                className="roost-tree-action"
                title={`Log in to ${p.display}`}
                onClick={() => activePlatform === p.name ? onHidePlatform() : onShowPlatform(p.name as Platform)}
              >{activePlatform === p.name ? <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg> : <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 10L10 2M10 2H4M10 2v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</Button>
              <Button
                variant="ghost" size="icon-xs"
                className="roost-tree-action"
                title={`Sync ${p.display}`}
                onClick={() => onSync(p.name as Platform)}
                loading={syncingPlatform === p.name}
                disabled={syncing}
              ><svg width="10" height="10" viewBox="0 0 12 12"><path d="M1.5 6a4.5 4.5 0 0 1 7.65-3.2L10.5 1.5v3h-3l1.15-1.15A3 3 0 0 0 3 6M10.5 6a4.5 4.5 0 0 1-7.65 3.2L1.5 10.5v-3h3L3.35 8.65A3 3 0 0 0 9 6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg></Button>
            </div>
          ))}
          {DEV_COMMANDS_ENABLED && (
            // Discovery-only login entry (no sync — Instagram has no sync fn yet).
            // Dev-gated (ROOST_DEV_COMMANDS=1) until Phase 2 flips enabled:true.
            <div className="roost-sync-strip-platform">
              <span className="roost-sync-strip-name">Instagram</span>
              <Button
                variant="ghost" size="icon-xs"
                className="roost-tree-action"
                title="Log in to Instagram"
                onClick={() => activePlatform === "instagram" ? onHidePlatform() : onShowPlatform("instagram")}
              >{activePlatform === "instagram" ? <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg> : <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 10L10 2M10 2H4M10 2v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</Button>
            </div>
          )}
          <div className="roost-sync-strip-platform">
            <span className="roost-sync-strip-name">Eagle</span>
            <Button
              variant="ghost" size="icon-xs"
              className="roost-tree-action"
              title="Import from Eagle"
              onClick={onImportEagle}
              loading={importing}
              disabled={syncing}
            ><svg width="10" height="10" viewBox="0 0 12 12"><path d="M1.5 6a4.5 4.5 0 0 1 7.65-3.2L10.5 1.5v3h-3l1.15-1.15A3 3 0 0 0 3 6M10.5 6a4.5 4.5 0 0 1-7.65 3.2L1.5 10.5v-3h3L3.35 8.65A3 3 0 0 0 9 6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg></Button>
          </div>
        </div>
      )}

      {hasItems && (
        <div className="nav-folder-children">
          <div className="tree-item">
            <div
              className={`tree-item-self nav-file-title${activeFilter?.category === null && !activeFilter?.platform ? " is-active" : ""}`}
              data-category="__unsorted__"
              onClick={() => onFilter(
                activeFilter?.category === null ? null : { category: null }
              )}
            >
              <span className="tree-item-inner nav-file-title-content">Unsorted</span>
              <span className="roost-tree-count">{unsorted}</span>
            </div>
          </div>

          {/* Promote-to-top-level drop zone — only visible while a subcategory
              is being dragged. Drops here lift the subcategory out of its
              parent (e.g. Food/Restaurants → Restaurants at root). */}
          {dragging?.subcategory && (
            <div
              className="roost-promote-zone"
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add("roost-drop-target");
              }}
              onDragLeave={(e) => {
                e.currentTarget.classList.remove("roost-drop-target");
              }}
              onDrop={(e) => {
                e.currentTarget.classList.remove("roost-drop-target");
                if (!onRenest) return;
                const raw = e.dataTransfer.getData(DRAG_MIME);
                const source = decodeDragPayload(raw);
                if (!source) return;
                e.preventDefault();
                setDragging(null);
                onRenest(source, "root");
              }}
            >
              Promote &ldquo;{dragging.subcategory}&rdquo; to top level
            </div>
          )}

          {categories.map(cat => {
            const hasSubs = cat.subcategories && cat.subcategories.length > 0;
            const isExpanded = expandedCategories.has(cat.name);
            const isParentActive = activeFilter?.category === cat.name && !activeFilter?.subcategory;
            const hasPipeline = pipelineCategories?.has(cat.name.toLowerCase()) ?? false;
            const pipelineRow = pipelineState?.[cat.name];
            const pipelineStatus = pipelineRow?.status ?? "idle";
            const pipelineRunning = pipelineStatus === "running";
            const pipelineRunnable = isPipelineRunnable?.(cat.name) ?? true;

            return (
              <div key={cat.name} className="tree-item">
                <div
                  className={`tree-item-self nav-file-title${isParentActive ? " is-active" : ""}${hasPipeline ? " roost-tree-pipeline" : ""}${pipelineRunning ? " roost-tree-pipeline-running" : ""}`}
                  data-category={cat.name}
                  draggable={!editing && !!(onRenest || onReorder)}
                  onDragStart={(e) => {
                    if (!onRenest && !onReorder) return;
                    setDragging({ category: cat.name });
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(DRAG_MIME, encodeDragPayload(cat.name));
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    const zone = getDropZone(e);
                    if (zone === "into") {
                      if (!onRenest) return;
                      // Block self-drop. Top-level → top-level with subcategories
                      // is allowed — the handler performs a recursive merge
                      // (rewrites roost_category on every source item,
                      // preserving subcategory names so overlapping buckets
                      // unify, e.g. dropping "Media List" onto "Media" merges
                      // Media List/Books items into Media/Books).
                      if (dragging.subcategory) {
                        if (dragging.category === cat.name) return; // already in this parent
                      } else {
                        if (dragging.category === cat.name) return; // self
                      }
                    } else {
                      if (!onReorder) return;
                      // Reorder is top-level only on this row. Subcategories
                      // reorder on their own (subcat) rows below.
                      if (dragging.subcategory) return;
                      if (dragging.category === cat.name) return;
                    }
                    e.preventDefault();
                    e.currentTarget.setAttribute("data-drop-zone", zone);
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.removeAttribute("data-drop-zone");
                  }}
                  onDrop={(e) => {
                    const zone = e.currentTarget.getAttribute("data-drop-zone") as DropZone | null;
                    e.currentTarget.removeAttribute("data-drop-zone");
                    const raw = e.dataTransfer.getData(DRAG_MIME);
                    const source = decodeDragPayload(raw);
                    if (!source || !zone) return;
                    e.preventDefault();
                    setDragging(null);
                    if (zone === "into") {
                      onRenest?.(source, { category: cat.name });
                    } else {
                      onReorder?.(source, { category: cat.name });
                    }
                  }}
                  onClick={() => {
                    if (editing) return;
                    onFilter(isParentActive ? null : { category: cat.name });
                  }}
                  onContextMenu={(e: React.MouseEvent) => {
                    e.preventDefault();
                    // Capture the right-click position before any menu opens.
                    // Obsidian's MenuItem.onClick callback doesn't reliably
                    // surface the menu-item click event, so we pass the
                    // original right-click coords to the delete handler so
                    // its confirm menu can pop at the same spot.
                    const triggerEvent = e.nativeEvent;
                    const menu = new Menu();
                    if (onRenameCategory) {
                      menu.addItem(item => item.setTitle("Rename").setIcon("pencil").onClick(() => {
                        setEditing({ type: "category", name: cat.name });
                      }));
                    }
                    if (onCreateSubcategory) {
                      menu.addItem(item => item.setTitle("Create subcategory").setIcon("folder-plus").onClick(() => onCreateSubcategory(cat.name)));
                    }
                    if (onResort || onSortIntoSubcategories) {
                      menu.addSeparator();
                    }
                    const disabled = !!smartAssignBusy || cat.count === 0;
                    if (onResort) {
                      menu.addItem(item => item
                        .setTitle("Resort with Smart Assign…")
                        .setIcon("shuffle")
                        .setDisabled(disabled)
                        .onClick(() => onResort(cat.name)));
                    }
                    if (onSortIntoSubcategories) {
                      menu.addItem(item => item
                        .setTitle("Sort into subcategories…")
                        .setIcon("list-tree")
                        .setDisabled(disabled)
                        .onClick(() => onSortIntoSubcategories(cat.name)));
                    }
                    if (onDeleteCategory) {
                      menu.addSeparator();
                      menu.addItem(item => item
                        .setTitle(`Delete "${cat.name}"`)
                        .setIcon("trash-2")
                        .onClick(() => onDeleteCategory(cat.name, triggerEvent)));
                    }
                    menu.showAtMouseEvent(triggerEvent);
                  }}
                >
                  {hasSubs && (
                    <span
                      className={`roost-tree-chevron${isExpanded ? "" : " is-collapsed"}`}
                      onClick={(e) => { e.stopPropagation(); toggleExpand(cat.name); }}
                    >
                      <svg width="10" height="10" viewBox="0 0 12 12">
                        <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </span>
                  )}
                  {editing?.type === "category" && editing.name === cat.name ? (
                    <InlineRenameInput
                      defaultValue={cat.name}
                      onConfirm={(newName) => {
                        const dup = categories.some(c => c.name.toLowerCase() === newName.toLowerCase() && c.name !== cat.name);
                        if (dup) { new Notice(`Category "${newName}" already exists`); setEditing(null); return; }
                        setEditing(null);
                        onRenameCategory?.(cat.name, newName);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <span
                      className="tree-item-inner nav-file-title-content"
                      onDoubleClick={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (onRenameCategory) setEditing({ type: "category", name: cat.name });
                      }}
                    >{cat.name}</span>
                  )}
                  {hasPipeline && pipelineRunning && (
                    <span className="roost-pipeline-bar" aria-label="Running pipeline">
                      <span className="roost-pipeline-bar-fill" />
                    </span>
                  )}
                  <span className="roost-tree-count">{cat.count}</span>
                  {hasPipeline && onRunPipeline && pipelineRunnable && (
                    pipelineRunning ? (
                      <Button
                        variant="ghost" size="icon-xs"
                        className="roost-tree-action roost-pipeline-button"
                        title="Cancel pipeline"
                        onClick={(e) => { e.stopPropagation(); onCancelPipeline?.(cat.name); }}
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" fill="currentColor"/></svg>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost" size="icon-xs"
                        className="roost-tree-action roost-pipeline-button"
                        title="Run pipeline"
                        disabled={cat.count === 0}
                        onClick={(e) => { e.stopPropagation(); onRunPipeline(cat.name); }}
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3.5 2.5v7l6-3.5z" fill="currentColor"/></svg>
                      </Button>
                    )
                  )}
                </div>
                {hasPipeline && pipelineRow && pipelineStatus !== "running" && (
                  pipelineStatus === "error" ? (
                    <div className="roost-pipeline-detail roost-pipeline-detail-error" title={pipelineRow.error ?? "error"}>
                      Error — {pipelineRow.error?.slice(0, 80) ?? "see logs"}
                    </div>
                  ) : pipelineRow.result ? (
                    <div className="roost-pipeline-detail">
                      {pipelineRow.result.written} written
                      {pipelineRow.result.skipped > 0 ? ` · ${pipelineRow.result.skipped} skipped` : ""}
                      {pipelineRow.result.errors > 0 ? ` · ${pipelineRow.result.errors} errors` : ""}
                      {pipelineRow.finishedAt ? ` · ${formatRelative(pipelineRow.finishedAt)}` : ""}
                    </div>
                  ) : null
                )}

                {hasSubs && isExpanded && (
                  <div className="tree-item-children">
                    {cat.subcategories!.map(sub => {
                      const isSubActive = activeFilter?.category === cat.name && activeFilter?.subcategory === sub.name;
                      return (
                        <div key={sub.name} className="tree-item roost-tree-subcategory">
                          <div
                            className={`tree-item-self nav-file-title${isSubActive ? " is-active" : ""}`}
                            data-category={cat.name}
                            data-subcategory={sub.name}
                            draggable={!editing && !!(onRenest || onReorder)}
                            onDragStart={(e) => {
                              if (!onRenest && !onReorder) return;
                              setDragging({ category: cat.name, subcategory: sub.name });
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData(DRAG_MIME, encodeDragPayload(cat.name, sub.name));
                            }}
                            onDragEnd={() => setDragging(null)}
                            onDragOver={(e) => {
                              if (!dragging || !onReorder) return;
                              // Reorder within parent only — source must be a
                              // subcategory of the same parent. Cross-parent
                              // moves go through the top-level row's "into" zone.
                              if (!dragging.subcategory) return;
                              if (dragging.category !== cat.name) return;
                              if (dragging.subcategory === sub.name) return;
                              const zone = getDropZone(e);
                              if (zone === "into") return; // no into-drop on subcat rows
                              e.preventDefault();
                              e.currentTarget.setAttribute("data-drop-zone", zone);
                            }}
                            onDragLeave={(e) => {
                              e.currentTarget.removeAttribute("data-drop-zone");
                            }}
                            onDrop={(e) => {
                              const zone = e.currentTarget.getAttribute("data-drop-zone") as DropZone | null;
                              e.currentTarget.removeAttribute("data-drop-zone");
                              const raw = e.dataTransfer.getData(DRAG_MIME);
                              const source = decodeDragPayload(raw);
                              if (!source || !zone || zone === "into") return;
                              e.preventDefault();
                              setDragging(null);
                              onReorder?.(source, { category: cat.name, subcategory: sub.name });
                            }}
                            onClick={() => {
                              if (editing) return;
                              onFilter(isSubActive ? null : { category: cat.name, subcategory: sub.name });
                            }}
                            onContextMenu={(e: React.MouseEvent) => {
                              e.preventDefault();
                              const triggerEvent = e.nativeEvent;
                              const menu = new Menu();
                              if (onRenameSubcategory) {
                                menu.addItem(item => item.setTitle("Rename").setIcon("pencil").onClick(() => {
                                  setEditing({ type: "subcategory", category: cat.name, name: sub.name });
                                }));
                              }
                              if (onDeleteSubcategory) {
                                menu.addSeparator();
                                menu.addItem(item => item
                                  .setTitle(`Delete "${sub.name}"`)
                                  .setIcon("trash-2")
                                  .onClick(() => onDeleteSubcategory(cat.name, sub.name, triggerEvent)));
                              }
                              menu.showAtMouseEvent(triggerEvent);
                            }}
                          >
                            {editing?.type === "subcategory" && editing.category === cat.name && editing.name === sub.name ? (
                              <InlineRenameInput
                                defaultValue={sub.name}
                                onConfirm={(newName) => {
                                  const dup = cat.subcategories?.some(s => s.name.toLowerCase() === newName.toLowerCase() && s.name !== sub.name);
                                  if (dup) { new Notice(`Subcategory "${newName}" already exists`); setEditing(null); return; }
                                  setEditing(null);
                                  onRenameSubcategory?.(cat.name, sub.name, newName);
                                }}
                                onCancel={() => setEditing(null)}
                              />
                            ) : (
                              <span
                                className="tree-item-inner nav-file-title-content"
                                onDoubleClick={(e) => {
                                  e.preventDefault(); e.stopPropagation();
                                  if (onRenameSubcategory) setEditing({ type: "subcategory", category: cat.name, name: sub.name });
                                }}
                              >{sub.name}</span>
                            )}
                            {(() => {
                              // Subcategory pipeline run state. Lookup keyed by
                              // category::subcategory so the parent row's run
                              // doesn't bleed into the child indicator (and vice
                              // versa). Mirrors the parent row's pipeline-running
                              // bar + cancel/play affordance.
                              const subKey = `${cat.name}::${sub.name}`;
                              const subRow = pipelineState?.[subKey];
                              const subRunning = subRow?.status === "running";
                              const subPipelineRunnable = isPipelineRunnable?.(cat.name) ?? true;
                              return (
                                <>
                                  {hasPipeline && subRunning && (
                                    <span className="roost-pipeline-bar" aria-label="Running pipeline">
                                      <span className="roost-pipeline-bar-fill" />
                                    </span>
                                  )}
                                  <span className="roost-tree-count">{sub.count}</span>
                                  {hasPipeline && onRunPipeline && subPipelineRunnable && (
                                    subRunning ? (
                                      <Button
                                        variant="ghost" size="icon-xs"
                                        className="roost-tree-action roost-pipeline-button"
                                        title="Cancel pipeline"
                                        onClick={(e) => { e.stopPropagation(); onCancelPipeline?.(cat.name, sub.name); }}
                                      >
                                        <svg width="10" height="10" viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" fill="currentColor"/></svg>
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="ghost" size="icon-xs"
                                        className="roost-tree-action roost-pipeline-button"
                                        title={`Run pipeline on ${cat.name}/${sub.name}`}
                                        disabled={sub.count === 0}
                                        onClick={(e) => { e.stopPropagation(); onRunPipeline(cat.name, sub.name); }}
                                      >
                                        <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3.5 2.5v7l6-3.5z" fill="currentColor"/></svg>
                                      </Button>
                                    )
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const LibraryTree = React.memo(LibraryTreeImpl);
