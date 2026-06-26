import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { App, Notice } from "obsidian";
import { Button } from "@/ui/components/ui/button";
import type { RoostFilter, RoostMode } from "@/types/roost";
import { buildFileIndex, deleteItem } from "@/lib/vault-utils";
import { TopicEditor } from "@/ui/components/topic-editor";
import { ProgressHeader } from "@/ui/components/progress-header";
import { LogPanel } from "@/ui/components/log-panel";
import { LibraryTree } from "@/ui/components/library-tree";
import { ExplorerTree, buildFolderTreeSimple } from "@/ui/components/explorer-tree";
import { StagingPanel } from "@/ui/components/staging-panel";
import { EditDescriptionModal } from "@/ui/components/edit-description-modal";
import { SetupHealthPanel } from "@/ui/components/setup-health-panel";
import { RoostHubStatusRow } from "@/ui/components/roost-hub-status-row";
import { useSmartAssign } from "@/ui/hooks/use-smart-assign";
import { useRoostPipelineRows } from "@/ui/hooks/use-roost-pipeline-rows";
import { useRoostPlatformSync } from "@/ui/hooks/use-roost-platform-sync";
import { useRoostCategoryTree } from "@/ui/hooks/use-roost-category-tree";
import { useLibraryTree } from "@/ui/hooks/use-library-tree";
import { useRoostSidebarLog } from "@/ui/hooks/use-roost-sidebar-log";
import { buildFilterInput } from "@/ui/lib/smart-assign-inputs";
import { getPipelineCategoryNames } from "@/lib/enrichments";
import { isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";
import { embeddingBackendAvailable } from "@/ui/lib/smart-assign/embedding-available";
import { showLibraryNav } from "@/ui/lib/show-library-nav";
import { getIntegration } from "@/integrations/registry";
import type { IRoostPlugin } from "@/types/plugin";
import type { ItemClickData } from "@/types/roost";

interface RoostViewProps {
  app: App;
  plugin: IRoostPlugin;
}

export function RoostView({ app, plugin }: RoostViewProps) {
  const { logs, showLogs, setShowLogs, log } = useRoostSidebarLog(plugin);
  const { libraryTree, scanLibrary, applyOptimisticAssignment } = useLibraryTree(app, plugin);

  const [activeFilter, setActiveFilter] = useState<RoostFilter>(null);
  const activeFilterRef = useRef<RoostFilter | null>(null);
  activeFilterRef.current = activeFilter;

  const [pluginMode, setPluginMode] = useState<RoostMode>(plugin.activeMode);
  const [explorerPaths, setExplorerPaths] = useState<string[]>(plugin.explorerPaths);

  useEffect(() => {
    const unsubMode = plugin.onModeChange(setPluginMode);
    const unsubPaths = plugin.onExplorerPathsChange(setExplorerPaths);
    return () => {
      unsubMode();
      unsubPaths();
    };
  }, [plugin]);

  useEffect(() => {
    return plugin.onFilterChange((filter) => {
      setActiveFilter(filter);
    });
  }, [plugin]);

  const applyFilter = useCallback(
    async (filter: RoostFilter) => {
      setActiveFilter(filter);
      if (plugin.activeMode === "explorer" || filter?.folder != null) {
        await plugin.openExplorerBase();
      } else {
        await plugin.openBookmarksBase();
      }
      plugin.setFilter(filter);
    },
    [plugin],
  );

  const platformSync = useRoostPlatformSync({ app, plugin, log, scanLibrary });

  const { pipelineState, handleRunPipeline, handleCancelPipeline } = useRoostPipelineRows({
    plugin,
    log,
  });

  const isPipelineRunnable = useCallback(
    (category: string) => isCategoryPipelineActive(category, plugin),
    [plugin],
  );

  const smartAssign = useSmartAssign({
    app,
    plugin,
    log,
    scanLibrary,
    applyOptimisticAssignment,
    applyFilter,
    stopSignalRef: platformSync.stopSignalRef,
    setSyncProgress: platformSync.setSyncProgress,
  });

  const categoryTree = useRoostCategoryTree({
    app,
    plugin,
    log,
    scanLibrary,
    applyFilter,
    libraryTree,
    setSyncProgress: platformSync.setSyncProgress,
    activeFilterRef,
    smartAssign: { mode: smartAssign.mode, run: smartAssign.run },
  });

  const syncing =
    platformSync.syncing ||
    smartAssign.pipelineStep != null ||
    smartAssign.confirming;

  const embeddingReady = embeddingBackendAvailable(
    plugin.settings.integrations,
    { ollama: plugin.integrationStatus.ollama, sidecar: plugin.integrationStatus.sidecar },
  );

  const smartAssignRef = useRef(smartAssign);
  smartAssignRef.current = smartAssign;

  useEffect(() => {
    return plugin.onItemClick(async (data: ItemClickData) => {
      const sa = smartAssignRef.current;
      if (data?.action === "move") {
        const result = sa.reassignItems([data.itemId], data.from, data.to);
        plugin.lastSuggestionResult = result;
      } else if (data?.action === "acceptSuggestions") {
        sa.acceptSuggestions(data.itemIds);
      } else if (data?.action === "dismissSuggestions") {
        sa.dismissSuggestions();
      } else if (data?.action === "delete" && data.roostId) {
        const ok = await deleteItem(app, app.vault, plugin.settings.syncFolder, data.roostId);
        if (ok) {
          new Notice("Item deleted");
          void scanLibrary();
        }
      }
    });
  }, [app, plugin, scanLibrary]);

  const itemTitles = useMemo(() => {
    const titles = new Map<string, string>();
    if (!smartAssign.proposedFolders) return titles;
    const fileIndex = buildFileIndex(app, plugin.settings.syncFolder);
    const allIds = new Set<string>();
    for (const f of smartAssign.proposedFolders) {
      for (const id of f.itemIds) allIds.add(id);
    }
    for (const id of allIds) {
      const file = fileIndex.get(id);
      if (!file) continue;
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      const title = typeof fm?.title === "string" ? fm.title.trim() : "";
      if (title) titles.set(id, title);
    }
    return titles;
  }, [smartAssign.proposedFolders, app.metadataCache, app.vault, plugin.settings.syncFolder]);

  const editableFolderIds = useMemo(() => {
    const ids = new Set<string>();
    if (!smartAssign.proposedFolders) return ids;
    for (const f of smartAssign.proposedFolders) {
      if (f.pending) ids.add(f.id);
    }
    return ids;
  }, [smartAssign.proposedFolders]);

  const handleEditDescription = useCallback(
    (folderId: string, folderName: string) => {
      const initialDesc = smartAssign.newClusterDescriptions?.get(folderName) ?? "";
      const initialNotDesc = smartAssign.newClusterNotDescriptions?.get(folderName) ?? "";
      new EditDescriptionModal(app, {
        categoryName: folderName,
        initialDescription: initialDesc,
        initialNotDescription: initialNotDesc,
        onSave: async (desc, notDesc) => {
          await smartAssign.saveClusterDescription(folderName, desc, notDesc);
        },
      }).open();
    },
    [
      app,
      smartAssign.newClusterDescriptions,
      smartAssign.newClusterNotDescriptions,
      smartAssign.saveClusterDescription,
    ],
  );

  const showNav = showLibraryNav(smartAssign.mode, smartAssign.proposal != null);

  return (
    <div className="h-full flex flex-col bg-background text-foreground text-sm">
      <div className="shrink-0 border-b border-border">
        <ProgressHeader
          syncing={syncing}
          syncProgress={platformSync.syncProgress}
          pipelineStep={smartAssign.pipelineStep}
          categoryCount={smartAssign.proposedFolders?.length || 0}
          mode={smartAssign.mode}
          onCancel={smartAssign.handleCancel}
        />
        {smartAssign.mode === "sync" && <RoostHubStatusRow app={app} plugin={plugin} />}
      </div>

      {smartAssign.mode === "topics" && (
        <TopicEditor
          topics={smartAssign.userTopics}
          onTopicsChange={smartAssign.setUserTopics}
          onRun={smartAssign.runClustering}
          onCancel={() => smartAssign.setMode("sync")}
          suggestedTopics={smartAssign.suggestedTopics}
        />
      )}

      {smartAssign.mode === "staging" && smartAssign.proposal && (() => {
        const proposedCollections: Record<string, string[]> = {};
        if (smartAssign.proposedFolders) {
          for (const f of smartAssign.proposedFolders) {
            if (smartAssign.userTopics.includes(f.name)) {
              proposedCollections[f.name] = f.itemIds;
            }
          }
        }
        return (
          <StagingPanel
            store={smartAssign.store}
            forceToggle={smartAssign.forceToggle}
            sliderSplitIds={smartAssign.sliderSplitIds}
            absorbedIds={smartAssign.absorbedNodeIds}
            nodeCollectionMap={smartAssign.nodeCollectionMap}
            collections={smartAssign.vaultCollections}
            proposedCollections={proposedCollections}
            matchedToCollections={smartAssign.matchedToCollections}
            matchDetailMap={smartAssign.matchDetailMap}
            topicNames={smartAssign.userTopics}
            proposedFolders={smartAssign.proposedFolders}
            noiseFolder={smartAssign.noiseFolder}
            assignedSubcategories={smartAssign.assignedSubcategories}
            itemTitles={itemTitles}
            editableFolderIds={editableFolderIds}
            onEditDescription={handleEditDescription}
            onToggle={(id) => {
              smartAssign.setForceToggle((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onFilter={applyFilter}
          />
        );
      })()}

      {showNav && pluginMode === "explorer" && explorerPaths.length > 0 ? (
        <ExplorerTree
          folders={buildFolderTreeSimple(explorerPaths)}
          activeFolder={activeFilter?.folder ?? null}
          onFilter={applyFilter}
        />
      ) : showNav ? (
        <LibraryTree
          total={libraryTree.total}
          unsorted={libraryTree.unsorted}
          categories={libraryTree.categories}
          pipelineCategories={getPipelineCategoryNames()}
          platforms={libraryTree.platforms}
          activeFilter={activeFilter}
          activePlatform={platformSync.activePlatform}
          syncingPlatform={platformSync.syncingPlatform}
          syncing={syncing}
          importing={platformSync.importing}
          onFilter={applyFilter}
          onShowPlatform={platformSync.showPlatform}
          onHidePlatform={platformSync.hidePlatform}
          onSync={platformSync.handleSync}
          onImportEagle={platformSync.handleImportFromEagle}
          onDeleteCategory={categoryTree.onDeleteCategory}
          onCreateSubcategory={categoryTree.onCreateSubcategory}
          onDeleteSubcategory={categoryTree.onDeleteSubcategory}
          onRenameCategory={categoryTree.onRenameCategory}
          onRenameSubcategory={categoryTree.onRenameSubcategory}
          onResort={categoryTree.onResort}
          onSortIntoSubcategories={categoryTree.onSortIntoSubcategories}
          smartAssignBusy={smartAssign.mode !== "sync"}
          pipelineState={pipelineState}
          onRunPipeline={handleRunPipeline}
          onCancelPipeline={handleCancelPipeline}
          isPipelineRunnable={isPipelineRunnable}
          onRenest={categoryTree.onRenest}
          onReorder={categoryTree.onReorder}
        />
      ) : null}

      {smartAssign.mode === "sync" && (
        <SetupHealthPanel app={app} syncFolder={plugin.settings.syncFolder} />
      )}

      <LogPanel
        logs={logs}
        showLogs={showLogs}
        onToggle={() => setShowLogs((prev) => !prev)}
        syncing={syncing}
      />

      <div className="shrink-0 border-t border-border px-3 py-2 flex items-center gap-2 bg-card flex-wrap">
        {smartAssign.mode === "sync" && (
          <>
            <Button
              size="sm"
              title={embeddingReady ? undefined : "Enable Ollama or the embedding sidecar in Roost settings to use Smart Assign."}
              onClick={() => {
                if (!embeddingReady) {
                  const setup = getIntegration("ollama").setup.instructions;
                  new Notice(`Smart Assign needs an embedding backend. ${setup}`, 8000);
                  return;
                }
                smartAssign.run(buildFilterInput(app, plugin.settings.syncFolder, activeFilter));
              }}
              loading={smartAssign.pipelineStep != null}
              disabled={syncing || !embeddingReady}
            >
              Smart Assign
            </Button>
            {syncing && (
              <>
                <div className="flex-1" />
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => platformSync.stopSignalRef.current?.stop()}
                >
                  ■ Stop
                </Button>
              </>
            )}
          </>
        )}
        {smartAssign.mode === "staging" && smartAssign.pipelineStep === 5 && (
          <>
            <div className="flex-1" />
            <Button
              size="sm"
              onClick={() => smartAssign.handleConfirm(smartAssign.proposedFolders)}
              loading={smartAssign.confirming}
            >
              {smartAssign.confirming ? "Applying" : "Confirm Categories"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
