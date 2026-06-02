import { useMemo, useState } from "react";
import { TreeExplorer } from "@/ui/components/tree-explorer";
import type { GroupStore, FolderData } from "@/ui/lib/group-store";
import type { RoostFilter, MatchDetail } from "@/types/roost";
import { subcategoriesForFolder } from "@/ui/lib/group-by-subcategory";

interface StagingPanelProps {
  store: GroupStore;
  forceToggle: Set<string>;
  sliderSplitIds: Set<string>;
  absorbedIds: Set<string>;
  nodeCollectionMap: Map<string, string>;
  collections: Record<string, string[]>;
  proposedCollections: Record<string, string[]>;
  matchedToCollections?: Record<string, string[]>;
  matchDetailMap?: Map<string, MatchDetail>;
  topicNames: string[];
  proposedFolders: (FolderData & { pending: boolean })[] | null;
  noiseFolder: (FolderData & { pending: boolean }) | null;
  assignedSubcategories?: Map<string, string | null>;
  itemTitles?: Map<string, string>;
  editableFolderIds?: Set<string>;
  onEditDescription?: (folderId: string, folderName: string) => void;
  onToggle: (id: string) => void;
  onFilter: (filter: RoostFilter) => void;
}

export function StagingPanel({
  store, forceToggle, sliderSplitIds, absorbedIds, nodeCollectionMap,
  collections, proposedCollections, matchedToCollections, matchDetailMap, topicNames, proposedFolders, noiseFolder,
  assignedSubcategories,
  itemTitles,
  editableFolderIds,
  onEditDescription,
  onToggle, onFilter,
}: StagingPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const subcategoriesFor = useMemo(() => {
    if (!assignedSubcategories || !proposedFolders) return undefined;
    return (folderId: string) => {
      const folder = proposedFolders.find(f => f.id === folderId);
      if (!folder) return null;
      const subcats = subcategoriesForFolder(folder.itemIds, assignedSubcategories, []);
      return subcats.length > 0 ? subcats : null;
    };
  }, [assignedSubcategories, proposedFolders]);

  const clusterCount = proposedFolders?.filter(f => f.pending).length ?? 0;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 px-3 py-2 border-b border-border">
        <div className="text-xs text-muted-foreground text-center">
          {clusterCount} clusters
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <TreeExplorer
          store={store}
          forceToggle={forceToggle}
          sliderSplitIds={sliderSplitIds}
          absorbedIds={absorbedIds}
          nodeCollectionMap={nodeCollectionMap}
          topics={proposedCollections}
          matchedToCollections={matchedToCollections}
          topicNames={topicNames}
          noiseFolder={noiseFolder}
          expandedCardId={selectedId}
          onToggle={onToggle}
          onExpandCard={(groupId) => {
            const group = store.getGroup(groupId);
            let itemIds: string[] | null = group?.itemIds || null;
            let certainItemIds: string[] | undefined = group?.certainItemIds || undefined;
            let uncertainItemIds: string[] | undefined = group?.uncertainItemIds || undefined;

            if (!itemIds) {
              for (const [name, ids] of Object.entries(proposedCollections)) {
                if (groupId === `collection-${name}`) { itemIds = ids; break; }
              }
            }

            // Check noise folder
            if (!itemIds && noiseFolder && groupId === noiseFolder.id) {
              itemIds = noiseFolder.itemIds;
            }

            // Check proposedFolders for confidence data
            if (!certainItemIds && proposedFolders) {
              const folder = proposedFolders.find(f => f.id === groupId);
              if (folder) {
                certainItemIds = folder.certainItemIds;
                uncertainItemIds = folder.uncertainItemIds;
              }
            }

            if (!itemIds) return;

            // For collections, identify which items were matched by scoring
            const collName = groupId.startsWith("collection-") ? groupId.slice("collection-".length) : null;
            const matchedItemIds = collName && matchedToCollections?.[collName];

            // Toggle: click same item -> back to folder view, click different -> switch
            if (selectedId === groupId) {
              setSelectedId(null);
              if (proposedFolders) {
                onFilter({ folders: proposedFolders.map(f => ({
                  id: f.id, name: f.name, count: f.itemIds.length, itemIds: f.itemIds, cohesion: f.cohesion,
                })) });
              } else {
                onFilter(null);
              }
            } else {
              setSelectedId(groupId);
              onFilter({
                itemIds,
                certainItemIds,
                uncertainItemIds,
                groupId,
                matchedItemIds: matchedItemIds || undefined,
                matchDetailMap: matchedItemIds ? matchDetailMap : undefined,
              });
            }
          }}
          subcategoriesFor={subcategoriesFor}
          itemTitles={itemTitles}
          editableFolderIds={editableFolderIds}
          onEditDescription={onEditDescription}
        />
      </div>
    </div>
  );
}
