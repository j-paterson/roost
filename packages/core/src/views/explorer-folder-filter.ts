/**
 * Explorer folder filter — indices + plugin subscription.
 */
import type { BasesEntry } from "obsidian";
import type { RoostFilter } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";
import { computeExplorerFolderIndices } from "@/views/bases-filter-indices";

export interface ExplorerFolderFilterHost {
  getRoostPlugin(): IRoostPlugin | null;
  getEntries(): BasesEntry[] | undefined;
  getFolderFilter(): string | null;
  setFolderFilter(folder: string | null): void;
  setFilteredIndices(indices: number[] | null): void;
  clearRenderedKey(): void;
  onDataUpdated(): void;
}

export function applyExplorerFolderFilter(host: ExplorerFolderFilterHost): void {
  const entries = host.getEntries();
  if (!entries) return;
  const folder = host.getFolderFilter();
  host.setFilteredIndices(
    folder ? computeExplorerFolderIndices(entries, folder) : null,
  );
  host.clearRenderedKey();
  host.onDataUpdated();
}

export function attachExplorerFilterSubscription(
  host: ExplorerFolderFilterHost,
): (() => void) | null {
  const plugin = host.getRoostPlugin();
  if (!plugin?.onFilterChange) return null;
  return plugin.onFilterChange((filter: RoostFilter) => {
    const folder = filter?.folder ?? null;
    if (folder !== host.getFolderFilter()) {
      host.setFolderFilter(folder);
      applyExplorerFolderFilter(host);
    }
  });
}
