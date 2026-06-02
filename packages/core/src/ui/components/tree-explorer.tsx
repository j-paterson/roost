import { useMemo, useState } from "react";
import type { GroupStore, FolderData } from "@/ui/lib/group-store";
import { makeCollectionId } from "@/ui/lib/group-store";
import type { ItemGroup } from "@/types/item-group";

export interface SubcategoryView {
  name: string;
  itemIds: string[];
}

interface TreeExplorerProps {
  store: GroupStore;
  forceToggle: Set<string>;
  sliderSplitIds: Set<string>;
  absorbedIds?: Set<string>;
  nodeCollectionMap?: Map<string, string>;
  markedItems?: Set<string>;
  topics?: Record<string, string[]>;
  matchedToCollections?: Record<string, string[]>;
  topicNames?: string[];
  noiseFolder?: (FolderData & { pending: boolean }) | null;
  onToggle: (groupId: string) => void;
  onHoverNode?: (groupId: string | null) => void;
  expandedCardId?: string | null;
  onExpandCard?: (groupId: string, collectionId?: string) => void;
  onMarkItems?: (itemIds: string[]) => void;
  /** When provided, returns subcategory groups for the given folder ID, or
   *  null if the folder is not subcategorized. Loose items (no subcategory)
   *  are NOT included in the returned list — they render at the parent
   *  folder's root level. */
  subcategoriesFor?: (folderId: string) => SubcategoryView[] | null;
  /** Map from item ID to display title for inline item rows. Falls back to
   *  id alone when a title is missing. */
  itemTitles?: Map<string, string>;
  /** Set of folder IDs that should show a ✎ icon (typically newly-discovered
   *  pending categories). When the user clicks the icon, onEditDescription
   *  fires with the folder's ID + display name. */
  editableFolderIds?: Set<string>;
  /** Click handler for the ✎ icon. Opens an editor for the folder's
   *  description. */
  onEditDescription?: (folderId: string, folderName: string) => void;
}

function isActiveLeaf(group: ItemGroup, sliderSplitIds: Set<string>, forceToggle: Set<string>): boolean {
  if (!group.children) return true;
  const isSplit = sliderSplitIds.has(group.id) !== forceToggle.has(group.id);
  return !isSplit;
}

function TreeNode({
  store, group, depth, forceToggle, sliderSplitIds,
  absorbedIds, nodeCollectionMap, markedItems,
  onToggle, onHoverNode, expandedCardId, onExpandCard, onMarkItems,
  subcategoriesFor, itemTitles,
  editableFolderIds, onEditDescription,
}: {
  store: GroupStore;
  group: ItemGroup;
  depth: number;
  forceToggle: Set<string>;
  sliderSplitIds: Set<string>;
  absorbedIds?: Set<string>;
  nodeCollectionMap?: Map<string, string>;
  markedItems?: Set<string>;
  onToggle: (groupId: string) => void;
  onHoverNode?: (groupId: string | null) => void;
  expandedCardId?: string | null;
  onExpandCard?: (groupId: string, collectionId?: string) => void;
  onMarkItems?: (itemIds: string[]) => void;
  subcategoriesFor?: (folderId: string) => SubcategoryView[] | null;
  itemTitles?: Map<string, string>;
  editableFolderIds?: Set<string>;
  onEditDescription?: (folderId: string, folderName: string) => void;
}) {
  const hasChildren = !!group.children;
  const isAbsorbed = absorbedIds?.has(group.id);
  const absorbedInto = nodeCollectionMap?.get(group.id);
  const isSplit = hasChildren ? (sliderSplitIds.has(group.id) !== forceToggle.has(group.id)) : false;
  const showChildren = hasChildren && isSplit;
  const isActive = hasChildren ? !isSplit : true;
  const isSelected = expandedCardId === group.id;
  const markedCount = markedItems ? group.itemIds.filter(id => markedItems.has(id)).length : 0;

  const childGroups = useMemo(() => {
    if (!group.children) return null;
    const [leftId, rightId] = group.children as [string, string];
    return [store.getGroup(leftId), store.getGroup(rightId)] as [ItemGroup | null, ItemGroup | null];
  }, [store, group.children]);

  return (
    <div className="tree-item">
      <div
        className={`tree-item-self nav-folder-title${isSelected ? " is-selected" : ""}${isAbsorbed ? " roost-tree-absorbed" : ""}`}
        style={{ paddingLeft: `${4 + depth * 16}px`, cursor: "pointer" }}
        onClick={() => {
          if (onExpandCard) {
            if (isAbsorbed && absorbedInto) {
              onExpandCard(group.id, makeCollectionId(absorbedInto));
            } else {
              onExpandCard(group.id);
            }
          }
        }}
        onMouseEnter={() => onHoverNode?.(group.id)}
        onMouseLeave={() => onHoverNode?.(null)}
        onContextMenu={(e) => {
          if (!onMarkItems) return;
          e.preventDefault();
          onMarkItems(group.itemIds);
        }}
      >
        {/* Collapse chevron — click to expand/collapse tree */}
        {hasChildren ? (
          <div
            className={`tree-item-icon collapse-icon${showChildren ? "" : " is-collapsed"}`}
            onClick={(e) => { e.stopPropagation(); onToggle(group.id); }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="svg-icon right-triangle">
              <path d="M3 8L12 17L21 8" />
            </svg>
          </div>
        ) : (
          <span style={{ width: 22, display: "inline-block" }} />
        )}

        {/* Status dot */}
        <span className={`roost-tree-dot${
          markedCount > 0 ? " roost-dot-marked"
          : isAbsorbed ? " roost-dot-absorbed"
          : isActive ? " roost-dot-active"
          : " roost-dot-inactive"
        }`} />

        {/* Name */}
        <span
          className={`tree-item-inner nav-folder-title-content${
            isAbsorbed ? " roost-text-absorbed"
            : isActive ? "" : " roost-text-muted"
          }`}
        >
          {group.name}
        </span>

        {/* Absorbed target */}
        {absorbedInto && (
          <span className="roost-tree-flow">&rarr; {absorbedInto}</span>
        )}

        {/* Marked count */}
        {markedCount > 0 && (
          <span className="roost-tree-badge roost-badge-marked">{markedCount}</span>
        )}

        {/* Edit description trigger — only on newly-discovered pending folders. */}
        {editableFolderIds?.has(group.id) && onEditDescription && (
          <span
            className="roost-tree-edit-desc"
            style={{ cursor: "pointer", padding: "0 4px", fontSize: 12, color: "var(--text-muted)" }}
            onClick={(e) => {
              e.stopPropagation();
              onEditDescription(group.id, group.name);
            }}
            title="Edit description"
          >
            ✎
          </span>
        )}

        {/* Item count — show certain + uncertain if available */}
        {isActive && group.certainItemIds && group.uncertainItemIds && group.uncertainItemIds.length > 0 ? (
          <span className="roost-tree-count">
            {group.certainItemIds.length}
            <span className="roost-text-muted"> + {group.uncertainItemIds.length}</span>
          </span>
        ) : (
          <span className="roost-tree-count">{group.itemIds.length}</span>
        )}
      </div>

      {/* Children */}
      {showChildren && childGroups && (
        <div className="tree-item-children">
          {childGroups[0] && (
            <TreeNode
              store={store} group={childGroups[0]} depth={depth + 1}
              forceToggle={forceToggle} sliderSplitIds={sliderSplitIds}
              absorbedIds={absorbedIds} nodeCollectionMap={nodeCollectionMap} markedItems={markedItems}
              onToggle={onToggle} onHoverNode={onHoverNode}
              expandedCardId={expandedCardId} onExpandCard={onExpandCard}
              onMarkItems={onMarkItems}
              subcategoriesFor={subcategoriesFor}
              itemTitles={itemTitles}
              editableFolderIds={editableFolderIds}
              onEditDescription={onEditDescription}
            />
          )}
          {childGroups[1] && (
            <TreeNode
              store={store} group={childGroups[1]} depth={depth + 1}
              forceToggle={forceToggle} sliderSplitIds={sliderSplitIds}
              absorbedIds={absorbedIds} nodeCollectionMap={nodeCollectionMap} markedItems={markedItems}
              onToggle={onToggle} onHoverNode={onHoverNode}
              expandedCardId={expandedCardId} onExpandCard={onExpandCard}
              onMarkItems={onMarkItems}
              subcategoriesFor={subcategoriesFor}
              itemTitles={itemTitles}
              editableFolderIds={editableFolderIds}
              onEditDescription={onEditDescription}
            />
          )}
        </div>
      )}

      {/* Subcategory render path — only for active leaf folder nodes that
       *  return non-null subcategoriesFor. Subcategory nodes look and behave
       *  like folder nodes (folder shape, expand/collapse not needed since
       *  they have no further children, click-to-filter, drag-drop). */}
      {subcategoriesFor && (() => {
        const subcats = subcategoriesFor(group.id);
        if (!subcats || subcats.length === 0) return null;
        // Items in this folder that don't belong to any subcategory.
        const subcatItemIds = new Set<string>();
        for (const s of subcats) for (const id of s.itemIds) subcatItemIds.add(id);
        const looseIds = group.itemIds.filter(id => !subcatItemIds.has(id));
        return (
          <div className="tree-item-children">
            {subcats.map(subcat => (
              <SubcatNode
                key={subcat.name}
                parentFolderId={group.id}
                subcat={subcat}
                depth={depth + 1}
                itemTitles={itemTitles}
                expandedCardId={expandedCardId}
                onExpandCard={onExpandCard}
              />
            ))}
            {/* Loose items at parent's root */}
            {looseIds.length > 0 && (
              <LooseItemsRow
                parentFolderId={group.id}
                itemIds={looseIds}
                depth={depth + 1}
                itemTitles={itemTitles}
              />
            )}
          </div>
        );
      })()}
    </div>
  );
}

function SubcatNode({
  parentFolderId, subcat, depth, itemTitles,
  expandedCardId, onExpandCard,
}: {
  parentFolderId: string;
  subcat: SubcategoryView;
  depth: number;
  itemTitles?: Map<string, string>;
  expandedCardId?: string | null;
  onExpandCard?: (groupId: string, collectionId?: string) => void;
}) {
  // NOTE: expand state is intentionally local — staging-tree views are short-
  // lived and the subcat array reference changes when the proposal updates,
  // which would unmount/remount this node and reset state in any case.
  const [expanded, setExpanded] = useState(true);
  // encodeURIComponent escapes ":" so the "::subcat::" delimiter cannot
  // collide with characters in subcategory names users may type.
  const subcatNodeId = `${parentFolderId}::subcat::${encodeURIComponent(subcat.name)}`;
  const isSelected = expandedCardId === subcatNodeId;
  return (
    <div className="tree-item">
      <div
        className={`tree-item-self nav-folder-title${isSelected ? " is-selected" : ""}`}
        style={{ paddingLeft: `${4 + depth * 16}px`, cursor: "pointer" }}
        data-subcat="true"
        data-parent-folder={parentFolderId}
        onClick={() => onExpandCard?.(subcatNodeId)}
      >
        <div
          className={`tree-item-icon collapse-icon${expanded ? "" : " is-collapsed"}`}
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="svg-icon right-triangle">
            <path d="M3 8L12 17L21 8" />
          </svg>
        </div>
        <span className="roost-tree-dot roost-dot-active" />
        <span className="tree-item-inner nav-folder-title-content">{subcat.name}</span>
        <span className="roost-tree-count">{subcat.itemIds.length}</span>
      </div>
      {expanded && (
        <div className="tree-item-children">
          {subcat.itemIds.map(id => (
            <ItemRow
              key={id}
              itemId={id}
              depth={depth + 1}
              title={itemTitles?.get(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LooseItemsRow({
  parentFolderId, itemIds, depth, itemTitles,
}: {
  parentFolderId: string;
  itemIds: string[];
  depth: number;
  itemTitles?: Map<string, string>;
}) {
  return (
    <div data-loose-items-for={parentFolderId}>
      {itemIds.map(id => (
        <ItemRow
          key={id}
          itemId={id}
          depth={depth}
          title={itemTitles?.get(id)}
        />
      ))}
    </div>
  );
}

function ItemRow({ itemId, depth, title }: { itemId: string; depth: number; title?: string }) {
  return (
    <div
      className="staging-subcat-item-row"
      style={{
        paddingLeft: `${4 + depth * 16}px`,
        fontSize: "var(--font-smallest)",
        color: "var(--text-faint)",
      }}
    >
      {title ? `${title} (${itemId})` : itemId}
    </div>
  );
}

export function TreeExplorer({
  store, forceToggle, sliderSplitIds, absorbedIds, nodeCollectionMap, markedItems, topics, matchedToCollections, topicNames, noiseFolder,
  onToggle, onHoverNode, expandedCardId, onExpandCard, onMarkItems,
  subcategoriesFor, itemTitles,
  editableFolderIds, onEditDescription,
}: TreeExplorerProps) {
  const root = store.getTreeRoot();
  const extraGroups = store.getExtraGroups();
  const clusterGroups = store.getClusterGroups();

  const childGroups = useMemo(() => {
    if (!root?.children) return null;
    const [leftId, rightId] = root.children as [string, string];
    return [store.getGroup(leftId), store.getGroup(rightId)] as [ItemGroup | null, ItemGroup | null];
  }, [store, root]);

  const topicEntries = useMemo(() => {
    const names = topicNames ?? (topics ? Object.keys(topics) : []);
    if (names.length === 0) return [];
    return names.map(name => ({
      name,
      count: topics?.[name]?.length ?? 0,
      id: makeCollectionId(name),
    }));
  }, [topics, topicNames]);

  const hasTree = !!childGroups;
  const hasContent = hasTree || clusterGroups.length > 0 || extraGroups.length > 0 || topicEntries.length > 0;

  if (!hasContent) {
    return <div className="nav-folder-title" style={{ padding: "4px 8px", color: "var(--text-muted)" }}>No categories yet</div>;
  }

  return (
    <div className="nav-folder-children">
      {/* User topics (collections) at the top */}
      {topicEntries.length > 0 && (
        <>
          {topicEntries.map(t => {
            const isSelected = expandedCardId === t.id;
            const matchedCount = matchedToCollections?.[t.name]?.length ?? 0;
            const originalCount = t.count - matchedCount;
            return (
              <div key={t.id} className="tree-item">
                <div
                  className={`tree-item-self nav-folder-title${isSelected ? " is-selected" : ""}`}
                  style={{ paddingLeft: 4 }}
                  onClick={() => onExpandCard?.(t.id, t.id)}
                >
                  <span style={{ width: 22, display: "inline-block" }} />
                  <span className="roost-tree-dot roost-dot-collection" />
                  <span className="tree-item-inner nav-folder-title-content roost-text-collection">
                    {t.name}
                  </span>
                  {matchedCount > 0 ? (
                    <span className="roost-tree-count">
                      {originalCount}
                      <span className="roost-text-matched"> + {matchedCount}</span>
                    </span>
                  ) : (
                    <span className="roost-tree-count">{t.count}</span>
                  )}
                </div>
              </div>
            );
          })}
          <div style={{ borderTop: "1px solid var(--background-modifier-border)", margin: "4px 8px" }} />
        </>
      )}

      {/* Binary clustering tree */}
      {hasTree ? (
        <>
          {childGroups[0] && (
            <TreeNode
              store={store} group={childGroups[0]} depth={0}
              forceToggle={forceToggle} sliderSplitIds={sliderSplitIds}
              absorbedIds={absorbedIds} nodeCollectionMap={nodeCollectionMap} markedItems={markedItems}
              onToggle={onToggle} onHoverNode={onHoverNode}
              expandedCardId={expandedCardId} onExpandCard={onExpandCard}
              onMarkItems={onMarkItems}
              subcategoriesFor={subcategoriesFor}
              itemTitles={itemTitles}
              editableFolderIds={editableFolderIds}
              onEditDescription={onEditDescription}
            />
          )}
          {childGroups[1] && (
            <TreeNode
              store={store} group={childGroups[1]} depth={0}
              forceToggle={forceToggle} sliderSplitIds={sliderSplitIds}
              absorbedIds={absorbedIds} nodeCollectionMap={nodeCollectionMap} markedItems={markedItems}
              onToggle={onToggle} onHoverNode={onHoverNode}
              expandedCardId={expandedCardId} onExpandCard={onExpandCard}
              onMarkItems={onMarkItems}
              subcategoriesFor={subcategoriesFor}
              itemTitles={itemTitles}
              editableFolderIds={editableFolderIds}
              onEditDescription={onEditDescription}
            />
          )}
        </>
      ) : (
        /* Flat cluster list fallback (no tree available) */
        clusterGroups.map(g => (
          <TreeNode
            key={g.id}
            store={store} group={g} depth={0}
            forceToggle={forceToggle} sliderSplitIds={sliderSplitIds}
            absorbedIds={absorbedIds} nodeCollectionMap={nodeCollectionMap} markedItems={markedItems}
            onToggle={onToggle} onHoverNode={onHoverNode}
            expandedCardId={expandedCardId} onExpandCard={onExpandCard}
            onMarkItems={onMarkItems}
            subcategoriesFor={subcategoriesFor}
            itemTitles={itemTitles}
            editableFolderIds={editableFolderIds}
            onEditDescription={onEditDescription}
          />
        ))
      )}

      {/* Extra groups from recategorization */}
      {extraGroups.length > 0 && (
        <>
          <div style={{ borderTop: "1px solid var(--background-modifier-border)", margin: "4px 8px" }} />
          {extraGroups.map(g => (
            <TreeNode
              key={g.id}
              store={store} group={g} depth={0}
              forceToggle={forceToggle} sliderSplitIds={sliderSplitIds}
              absorbedIds={absorbedIds} nodeCollectionMap={nodeCollectionMap} markedItems={markedItems}
              onToggle={onToggle} onHoverNode={onHoverNode}
              expandedCardId={expandedCardId} onExpandCard={onExpandCard}
              onMarkItems={onMarkItems}
              subcategoriesFor={subcategoriesFor}
              itemTitles={itemTitles}
              editableFolderIds={editableFolderIds}
              onEditDescription={onEditDescription}
            />
          ))}
        </>
      )}

      {/* Noise / Uncategorized section */}
      {noiseFolder && noiseFolder.count > 0 && (
        <>
          <div style={{ borderTop: "1px solid var(--background-modifier-border)", margin: "4px 8px" }} />
          <div className="tree-item">
            <div
              className={`tree-item-self nav-folder-title${expandedCardId === noiseFolder.id ? " is-selected" : ""}`}
              style={{ paddingLeft: 4, cursor: "pointer" }}
              onClick={() => onExpandCard?.(noiseFolder.id)}
            >
              <span style={{ width: 22, display: "inline-block" }} />
              <span className="roost-tree-dot roost-dot-noise" />
              <span className="tree-item-inner nav-folder-title-content roost-text-muted">
                Uncategorized
              </span>
              <span className="roost-tree-count">{noiseFolder.count}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
