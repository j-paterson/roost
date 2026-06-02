/**
 * Explorer tree — folder structure derived from Base query results.
 * Shown in the sidebar when an explorer Base view is active.
 */
import * as React from "react";
import { useState } from "react";
import type { RoostFilter } from "@/types/roost";

interface FolderNode {
  name: string;
  path: string;
  count: number;
  children: FolderNode[];
}

interface ExplorerTreeProps {
  folders: FolderNode[];
  activeFolder: string | null;
  onFilter: (filter: RoostFilter) => void;
}

export function ExplorerTree({ folders, activeFolder, onFilter }: ExplorerTreeProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="nav-folder-children">
        <div
          className={`tree-item-self nav-folder-title${!activeFolder ? " is-active" : ""}`}
          style={{ cursor: "pointer", paddingLeft: 8 }}
          onClick={() => onFilter(null)}
        >
          <span className="tree-item-inner nav-folder-title-content">All Files</span>
        </div>
        {folders.map(f => (
          <FolderItem key={f.path} folder={f} depth={0} activeFolder={activeFolder} onFilter={onFilter} />
        ))}
      </div>
    </div>
  );
}

function FolderItem({ folder, depth, activeFolder, onFilter }: {
  folder: FolderNode; depth: number; activeFolder: string | null;
  onFilter: (filter: RoostFilter) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = folder.children.length > 0;
  const isActive = activeFolder === folder.path;

  return (
    <div className="tree-item">
      <div
        className={`tree-item-self nav-folder-title${isActive ? " is-active" : ""}`}
        style={{ cursor: "pointer", paddingLeft: 8 + depth * 16 }}
        onClick={() => onFilter(isActive ? null : { folder: folder.path })}
      >
        {hasChildren && (
          <div
            className={`tree-item-icon collapse-icon${expanded ? "" : " is-collapsed"}`}
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="svg-icon right-triangle"><path d="M3 8L12 17L21 8" /></svg>
          </div>
        )}
        <span className="tree-item-inner nav-folder-title-content">{folder.name}</span>
        <span className="roost-tree-count" style={{ marginLeft: "auto", marginRight: 8, opacity: 0.5, fontSize: 11 }}>{folder.count}</span>
      </div>
      {hasChildren && expanded && (
        <div className="tree-item-children nav-folder-children">
          {folder.children.map(child => (
            <FolderItem key={child.path} folder={child} depth={depth + 1} activeFolder={activeFolder} onFilter={onFilter} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Build folder list from file paths (one row per parent folder) */
export function buildFolderTreeSimple(paths: string[]): FolderNode[] {
  const folders = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length > 1) {
      // Group by parent folder
      const folder = parts.slice(0, -1).join("/");
      folders.set(folder, (folders.get(folder) || 0) + 1);
    }
  }
  return [...folders.entries()]
    .map(([path, count]) => ({
      name: path.split("/").pop() || path,
      path,
      count,
      children: [],
    }))
    .sort((a, b) => b.count - a.count);
}
