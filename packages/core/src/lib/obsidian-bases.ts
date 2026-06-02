import type { WorkspaceLeaf } from "obsidian";
import { BASES_VIEW_ID } from "@/views/bookmarks-bases-view";
import { EXPLORER_VIEW_ID } from "@/views/explorer-bases-view";
import type { RoostMode } from "@/types/roost";

/** Obsidian Base leaf view — internal shape used for mode detection */
interface BaseLeafView {
  file?: { extension?: string; path?: string };
  currentView?: { type?: string };
}

export function roostModeFromLeaf(leaf: WorkspaceLeaf | null): RoostMode {
  if (!leaf) return null;
  const view = leaf.view as BaseLeafView;
  if (view?.file?.extension !== "base") return null;
  const viewType = view.currentView?.type;
  if (viewType === EXPLORER_VIEW_ID) return "explorer";
  if (viewType === BASES_VIEW_ID) return "bookmarks";
  return null;
}
