import { useState, useCallback, useEffect } from "react";
import type { App } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { scanLibraryTree, applyCategoryDelta, type LibraryTreeData } from "@/ui/lib/library-tree";

const EMPTY_TREE: LibraryTreeData = {
  total: 0,
  unsorted: 0,
  categories: [],
  platforms: [],
};

export function useLibraryTree(app: App, plugin: IRoostPlugin) {
  const [libraryTree, setLibraryTree] = useState<LibraryTreeData>(EMPTY_TREE);

  const scanLibrary = useCallback(async () => {
    setLibraryTree(
      scanLibraryTree(app, plugin.settings.syncFolder, plugin.settings),
    );
  }, [app, plugin]);

  /** Optimistically repaint the sidebar counts from a known assignment delta
   *  (category → newly-assigned item count) without re-scanning the vault. A
   *  reconciling scanLibrary() should follow once metadata settles. */
  const applyOptimisticAssignment = useCallback((delta: Map<string, number>) => {
    setLibraryTree(prev => applyCategoryDelta(prev, delta));
  }, []);

  useEffect(() => {
    void scanLibrary();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ref = app.metadataCache.on("resolved", () => {
      if (plugin.bulkWriteInProgress) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void scanLibrary();
      }, 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      app.metadataCache.offref(ref);
    };
  }, [app, plugin, scanLibrary]);

  return { libraryTree, scanLibrary, applyOptimisticAssignment };
}
