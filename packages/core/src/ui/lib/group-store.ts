import type { SplitTreeNode, ClassifyProposalData, LibraryState } from "@/types/roost";
import type { ItemGroup } from "@/types/item-group";
import { ABSORPTION_THRESHOLD } from "@/config";

export interface FolderData {
  id: string;
  name: string;
  count: number;
  itemIds: string[];
  certainItemIds?: string[];
  uncertainItemIds?: string[];
  altNames?: string[];
  cohesion?: number;
  splitPreview?: [{ name: string; count: number }, { name: string; count: number }] | null;
  absorbedFrom?: { name: string; count: number }[];
}

const COLLECTION_PREFIX = "collection-";

export function makeCollectionId(name: string): string {
  return `${COLLECTION_PREFIX}${name}`;
}

/**
 * GroupStore: single source of truth for all item groups.
 *
 * Holds proposed (from clustering) and confirmed (library folders) groups
 * in one map. Provides tree queries, absorption logic, and serialization.
 *
 * Pure data store — no React, no side effects.
 */
export class GroupStore {
  private groups: Map<string, ItemGroup> = new Map();
  private treeRootId: string | null = null;
  private treeIdMap: Map<number | string, string> = new Map();
  private clusterIds: string[] = []; // ordered cluster group IDs from latest clustering
  private noiseGroupId: string | null = null;
  private extraGroupIds: string[] = []; // new leaf groups from recategorization

  // Reassignment tracking — user-initiated moves during staging
  private reassignments: Map<string, string> = new Map(); // itemId → targetGroupId
  private rejections: Set<string> = new Set(); // itemIds the user explicitly rejected (wrong, no replacement)

  // Library state
  private assignments: Map<string, string> = new Map();
  private unassigned: string[] = [];
  private lastLibraryJson = "";

  // ── Helpers ──

  private getChildPair(group: ItemGroup): [ItemGroup, ItemGroup] | null {
    if (!group.children || group.children.length !== 2) return null;
    const [leftId, rightId] = group.children as [string, string];
    const left = this.groups.get(leftId);
    const right = this.groups.get(rightId);
    if (!left || !right) return null;
    return [left, right];
  }

  // ── Loading ──

  loadFromClusterOutput(data: ClassifyProposalData): void {
    // Clear only proposal groups, keep confirmed
    for (const [id, g] of this.groups) {
      if (g.status === "proposed") this.groups.delete(id);
    }
    this.treeIdMap.clear();
    this.treeRootId = null;
    this.clusterIds = [];
    this.noiseGroupId = null;

    if (data.splitTree) {
      // Tree mode: walk the split tree to create groups with parent/children links
      const walkTree = (node: SplitTreeNode, parentId: string | null): string => {
        const id = typeof node.id === "string" ? node.id : crypto.randomUUID();
        this.treeIdMap.set(node.id, id);

        // Find matching proposal for confidence data
        const nodeIdSet = new Set(node.itemIds);
        let certainItemIds: string[] | undefined;
        let uncertainItemIds: string[] | undefined;
        if (!node.children) {
          for (const proposal of data.proposals) {
            if (proposal.itemIds.length === node.itemIds.length && proposal.itemIds.every(pid => nodeIdSet.has(pid))) {
              certainItemIds = proposal.certainItemIds;
              uncertainItemIds = proposal.uncertainItemIds;
              break;
            }
          }
        }

        const group: ItemGroup = {
          id,
          name: node.name.suggestedName,
          altNames: node.name.altNames,
          status: "proposed",
          source: node.name.fromCollection ? "collection" : "cluster",
          itemIds: node.itemIds,
          certainItemIds,
          uncertainItemIds,
          parentId,
          children: null,
          cohesion: node.cohesion,
          samples: node.samples,
          fromCollection: node.name.fromCollection ?? false,
        };

        if (node.children) {
          const leftId = walkTree(node.children[0], id);
          const rightId = walkTree(node.children[1], id);
          group.children = [leftId, rightId];
        } else {
          // Leaf node — track as cluster ID
          this.clusterIds.push(id);
        }

        this.groups.set(id, group);
        return id;
      };

      this.treeRootId = walkTree(data.splitTree, null);
    } else {
      // Flat mode fallback: create a group for each proposal
      for (const proposal of data.proposals) {
        const id = crypto.randomUUID();
        const group: ItemGroup = {
          id,
          name: proposal.suggestedName,
          altNames: proposal.altNames,
          status: "proposed",
          source: proposal.fromCollection ? "collection" : "cluster",
          itemIds: proposal.itemIds,
          certainItemIds: proposal.certainItemIds,
          uncertainItemIds: proposal.uncertainItemIds,
          parentId: null,
          children: null,
          cohesion: proposal.confidence ?? null,
          samples: proposal.samples,
          fromCollection: proposal.fromCollection ?? false,
        };
        this.groups.set(id, group);
        this.clusterIds.push(id);
      }
    }

    // Create noise group if there are noise items
    if (data.noiseItemIds && data.noiseItemIds.length > 0) {
      const noiseId = crypto.randomUUID();
      const noiseGroup: ItemGroup = {
        id: noiseId,
        name: "Uncategorized",
        altNames: [],
        status: "proposed",
        source: "noise",
        itemIds: data.noiseItemIds,
        parentId: null,
        children: null,
        cohesion: null,
        samples: data.noiseItemIds.slice(0, 6).map(id => ({ id })),
        fromCollection: false,
      };
      this.groups.set(noiseId, noiseGroup);
      this.noiseGroupId = noiseId;
    }
  }

  /**
   * Load confirmed library state. Skips rebuild if the data hasn't changed.
   */
  loadFromLibraryState(state: LibraryState): boolean {
    const json = JSON.stringify(state);
    if (json === this.lastLibraryJson) return false;
    this.lastLibraryJson = json;

    // Clear confirmed groups
    for (const [id, g] of this.groups) {
      if (g.status === "confirmed") this.groups.delete(id);
    }
    this.assignments.clear();
    this.unassigned = [...state.unassigned];

    // Build inverse index: folderId → itemIds (avoids O(F*A))
    const folderItems = new Map<string, string[]>();
    for (const [itemId, folderId] of Object.entries(state.assignments)) {
      this.assignments.set(itemId, folderId);
      let arr = folderItems.get(folderId);
      if (!arr) { arr = []; folderItems.set(folderId, arr); }
      arr.push(itemId);
    }

    for (const [id, folder] of Object.entries(state.folders)) {
      const group: ItemGroup = {
        id,
        name: folder.name,
        altNames: [],
        status: "confirmed",
        source: folder.source as ItemGroup["source"],
        itemIds: folderItems.get(id) || [],
        parentId: folder.parent,
        children: null,
        cohesion: null,
        samples: [],
        fromCollection: folder.source === "collection",
      };
      this.groups.set(id, group);
    }

    // Wire up children for confirmed groups
    const confirmedIds = Object.keys(state.folders);
    for (const id of confirmedIds) {
      const group = this.groups.get(id)!;
      const childIds = confirmedIds.filter(cid => this.groups.get(cid)!.parentId === id);
      group.children = childIds.length > 0 ? childIds : null;
    }

    return true;
  }

  /**
   * Apply recategorization results: update existing leaves and add new groups.
   */
  applyRecategorization(result: {
    updatedLeaves: { id: string; name: string; altNames: string[]; itemIds: string[] }[];
    newGroups?: { name: string; altNames: string[]; itemIds: string[]; cohesion: number }[];
  }): void {
    // Update existing leaves — empty ones were dissolved
    for (const ul of result.updatedLeaves) {
      const group = this.groups.get(ul.id);
      if (!group) continue;
      if (ul.itemIds.length === 0) {
        this.groups.delete(ul.id);
      } else {
        group.itemIds = ul.itemIds;
      }
    }

    // Add new groups as extras
    if (result.newGroups) {
      for (const ng of result.newGroups) {
        const id = crypto.randomUUID();
        const group: ItemGroup = {
          id,
          name: ng.name,
          altNames: ng.altNames || [],
          status: "proposed",
          source: "cluster",
          itemIds: ng.itemIds,
          parentId: null,
          children: null,
          cohesion: ng.cohesion,
          samples: ng.itemIds.slice(0, 6).map(itemId => ({ id: itemId })),
          fromCollection: false,
        };
        this.groups.set(id, group);
        this.extraGroupIds.push(id);
      }
    }
  }

  /** Get extra leaf groups (from recategorization). */
  getExtraGroups(): ItemGroup[] {
    return this.extraGroupIds.map(id => this.groups.get(id)).filter(Boolean) as ItemGroup[];
  }

  /** Clear proposal data (e.g., after confirm or cancel). */
  clearProposal(): void {
    for (const [id, g] of this.groups) {
      if (g.status === "proposed") this.groups.delete(id);
    }
    this.treeIdMap.clear();
    this.treeRootId = null;
    this.clusterIds = [];
    this.noiseGroupId = null;
    this.extraGroupIds = [];
    this.reassignments.clear();
    this.rejections.clear();
  }

  // ── Item reassignment ──

  /** Move items from one group to another. Tracks moves for neighbor suggestions. */
  reassignItems(itemIds: string[], fromGroupId: string, toGroupId: string): void {
    const from = this.groups.get(fromGroupId);
    const to = this.groups.get(toGroupId);
    if (!from || !to) return;

    const moveSet = new Set(itemIds);
    from.itemIds = from.itemIds.filter(id => !moveSet.has(id));
    to.itemIds = [...to.itemIds, ...itemIds];

    for (const id of itemIds) this.reassignments.set(id, toGroupId);
  }

  /** Get all user reassignments (itemId → targetGroupId). */
  getReassignments(): Map<string, string> { return this.reassignments; }

  /** Mark an item's auto-assignment wrong WITHOUT picking a replacement. */
  rejectItem(itemId: string): void {
    this.rejections.add(itemId);
  }

  /** Bulk-reject items. Same training-signal path as single rejectItem. */
  rejectItems(ids: string[]): void {
    for (const id of ids) this.rejections.add(id);
  }

  /** Undo a rejection (e.g. the user then picks a category). */
  unrejectItem(itemId: string): void {
    this.rejections.delete(itemId);
  }

  /**
   * Move items to `toGroupId`, resolving each item's current source group
   * independently. Handles mixed-source selections (items from different groups).
   */
  reassignItemsTo(ids: string[], toGroupId: string): void {
    if (!this.groups.has(toGroupId)) return;
    const moveSet = new Set(ids);
    // Build fromGroupId → itemIds-to-move map before any mutations
    const fromMap = new Map<string, string[]>();
    for (const [gId, group] of this.groups) {
      if (gId === toGroupId) continue;
      const toMove = group.itemIds.filter(id => moveSet.has(id));
      if (toMove.length > 0) fromMap.set(gId, toMove);
    }
    for (const [fromGroupId, moveIds] of fromMap) {
      this.reassignItems(moveIds, fromGroupId, toGroupId);
    }
  }

  /** Items the user explicitly rejected this proposal. */
  getRejects(): Set<string> {
    return this.rejections;
  }

  // ── Tree queries ──

  getTreeRoot(): ItemGroup | null {
    return this.treeRootId ? this.groups.get(this.treeRootId) ?? null : null;
  }

  getGroup(id: string): ItemGroup | null {
    return this.groups.get(id) ?? null;
  }

  /** Get the noise group, if any. */
  getNoiseGroup(): ItemGroup | null {
    return this.noiseGroupId ? this.groups.get(this.noiseGroupId) ?? null : null;
  }

  /** Get all cluster groups (leaf nodes from tree, or flat list). */
  getClusterGroups(): ItemGroup[] {
    return this.clusterIds.map(id => this.groups.get(id)).filter(Boolean) as ItemGroup[];
  }

  getSliderSplits(sliderValue: number): Set<string> {
    const root = this.getTreeRoot();
    if (!root) return new Set();

    const sliderSplit = new Set<string>();
    let leaves: ItemGroup[] = [root];

    while (leaves.length < sliderValue) {
      let bestIdx = -1, bestPriority = -Infinity;
      for (let i = 0; i < leaves.length; i++) {
        if (!leaves[i].children) continue;
        const priority = leaves[i].itemIds.length * (1 - (leaves[i].cohesion ?? 1));
        if (priority > bestPriority) { bestPriority = priority; bestIdx = i; }
      }
      if (bestIdx === -1) break;
      sliderSplit.add(leaves[bestIdx].id);
      const pair = this.getChildPair(leaves[bestIdx]);
      if (!pair) break;
      leaves.splice(bestIdx, 1, pair[0], pair[1]);
    }

    return sliderSplit;
  }

  private flattenTree(sliderSplit: Set<string>, forceToggle: Set<string>): ItemGroup[] {
    const root = this.getTreeRoot();
    if (!root) {
      // No tree — return flat cluster list
      return this.getClusterGroups().sort((a, b) => b.itemIds.length - a.itemIds.length);
    }

    const collectLeaves = (group: ItemGroup): ItemGroup[] => {
      if (!group.children) return [group];
      if (sliderSplit.has(group.id) === forceToggle.has(group.id)) return [group];
      const pair = this.getChildPair(group);
      if (!pair) return [group];
      return [...collectLeaves(pair[0]), ...collectLeaves(pair[1])];
    };

    return collectLeaves(root).sort((a, b) => b.itemIds.length - a.itemIds.length);
  }

  /**
   * Get visible leaves with absorption and view data.
   * Accepts pre-computed sliderSplits and forceToggle for tree mode.
   */
  getVisibleLeaves(
    sliderSplits: Set<string>,
    forceToggle: Set<string>,
    collections: Record<string, string[]>,
    userRenames: Map<string, string>,
  ): {
    folders: (FolderData & { pending: boolean })[];
    absorbedIds: Set<string>;
    nodeCollectionMap: Map<string, string>;
    noiseFolder: (FolderData & { pending: boolean }) | null;
  } {
    const leaves = this.flattenTree(sliderSplits, forceToggle);

    // Build collection seed sets
    const collectionSeedSets: Record<string, Set<string>> = {};
    const allCollectionIds = new Set<string>();
    for (const [name, ids] of Object.entries(collections)) {
      collectionSeedSets[name] = new Set(ids);
      for (const id of ids) allCollectionIds.add(id);
    }

    // Absorption: merge leaf into collection if >30% threshold or name match
    const THRESHOLD = ABSORPTION_THRESHOLD;
    const absorbed: Record<string, { fromLeaf: string; itemIds: string[] }[]> = {};
    const absorbedIds = new Set<string>();
    for (const name of Object.keys(collections)) absorbed[name] = [];

    for (const leaf of leaves) {
      const leafDisplayName = userRenames.get(leaf.id) ?? leaf.name;

      const hits: Record<string, number> = {};
      for (const id of leaf.itemIds) {
        for (const [name, seedSet] of Object.entries(collectionSeedSets)) {
          if (seedSet.has(id)) hits[name] = (hits[name] || 0) + 1;
        }
      }
      let bestColl: string | null = null, bestCount = 0;
      for (const [name, count] of Object.entries(hits)) {
        if (count > bestCount) { bestCount = count; bestColl = name; }
      }

      let nameMatch: string | null = null;
      for (const collName of Object.keys(collections)) {
        if (collName.toLowerCase() === leafDisplayName.toLowerCase()) { nameMatch = collName; break; }
      }

      const matchedColl = nameMatch ?? ((bestColl && bestCount >= leaf.itemIds.length * THRESHOLD) ? bestColl : null);

      if (matchedColl) {
        const newItems = leaf.itemIds.filter(id => !allCollectionIds.has(id));
        absorbed[matchedColl].push({ fromLeaf: leaf.name, itemIds: newItems });
        absorbedIds.add(leaf.id);
      }
    }

    const collectionCards: (FolderData & { pending: boolean })[] = Object.entries(collections)
      .map(([name, seedIds]) => {
        const absorbedGroups = absorbed[name] || [];
        const absorbedItemIds = absorbedGroups.flatMap(g => g.itemIds);
        const allIds = [...seedIds, ...absorbedItemIds];
        return {
          id: makeCollectionId(name),
          name,
          count: allIds.length,
          itemIds: allIds,
          pending: false,
          absorbedFrom: absorbedGroups.filter(g => g.itemIds.length > 0).map(g => ({
            name: g.fromLeaf,
            count: g.itemIds.length,
          })),
        };
      })
      .sort((a, b) => b.count - a.count);

    const discoveredCards: (FolderData & { pending: boolean })[] = leaves
      .filter(l => !absorbedIds.has(l.id))
      .map((leaf) => {
        const filteredIds = leaf.itemIds.filter(id => !allCollectionIds.has(id));
        const filteredSet = new Set(filteredIds);
        let splitPreview: [{ name: string; count: number }, { name: string; count: number }] | null = null;
        const pair = this.getChildPair(leaf);
        if (pair) {
          splitPreview = [
            { name: pair[0].name, count: pair[0].itemIds.length },
            { name: pair[1].name, count: pair[1].itemIds.length },
          ];
        }
        return {
          id: leaf.id,
          name: userRenames.get(leaf.id) ?? leaf.name,
          count: filteredIds.length,
          itemIds: filteredIds,
          certainItemIds: leaf.certainItemIds?.filter(id => filteredSet.has(id)),
          uncertainItemIds: leaf.uncertainItemIds?.filter(id => filteredSet.has(id)),
          altNames: leaf.altNames,
          cohesion: leaf.cohesion ?? undefined,
          splitPreview,
          pending: true,
        };
      })
      .filter(f => f.count > 0)
      .sort((a, b) => b.count - a.count);

    const nodeCollectionMap = new Map<string, string>();
    for (const leaf of leaves) {
      if (absorbedIds.has(leaf.id)) {
        for (const [collName, groups] of Object.entries(absorbed)) {
          if (groups.some(g => g.fromLeaf === leaf.name)) {
            nodeCollectionMap.set(leaf.id, collName);
          }
        }
      }
    }

    // Extra groups from recategorization
    const extraCards: (FolderData & { pending: boolean })[] = this.getExtraGroups()
      .map(g => ({
        id: g.id,
        name: userRenames.get(g.id) ?? g.name,
        count: g.itemIds.length,
        itemIds: g.itemIds,
        altNames: g.altNames,
        cohesion: g.cohesion ?? undefined,
        pending: true,
      }))
      .filter(f => f.count > 0);

    // Noise folder
    const noiseGroup = this.getNoiseGroup();
    const noiseFolder = noiseGroup && noiseGroup.itemIds.length > 0 ? {
      id: noiseGroup.id,
      name: "Uncategorized",
      count: noiseGroup.itemIds.length,
      itemIds: noiseGroup.itemIds,
      pending: true,
    } : null;

    return {
      folders: [...collectionCards, ...discoveredCards, ...extraCards],
      absorbedIds,
      nodeCollectionMap,
      noiseFolder,
    };
  }

  // ── Library queries ──

  getFolderTree(): FolderTreeEntry[] {
    const entries: Map<string, FolderTreeEntry> = new Map();

    for (const [id, group] of this.groups) {
      if (group.status !== "confirmed") continue;
      entries.set(id, {
        id, name: group.name, source: group.source,
        parent: group.parentId, count: group.itemIds.length,
        children: [],
      });
    }

    const roots: FolderTreeEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.parent && entries.has(entry.parent)) {
        entries.get(entry.parent)!.children.push(entry);
      } else {
        roots.push(entry);
      }
    }

    for (const entry of entries.values()) {
      entry.children.sort((a, b) => b.count - a.count);
    }
    return roots.sort((a, b) => b.count - a.count);
  }

  getSelectedFolderInfo(folderId: string): SelectedFolderInfo | null {
    const group = this.groups.get(folderId);
    if (!group || group.status !== "confirmed") return null;

    const children = [...this.groups.values()]
      .filter(g => g.status === "confirmed" && g.parentId === folderId)
      .map(g => ({ id: g.id, name: g.name, itemIds: g.itemIds, count: g.itemIds.length }))
      .sort((a, b) => b.count - a.count);

    let platform: string | null = null;
    if (group.parentId) {
      const parent = this.groups.get(group.parentId);
      if (parent?.name === "TikTok") platform = "tiktok";
      else if (parent?.name === "X") platform = "twitter";
    }
    if (group.name === "TikTok") platform = "tiktok";
    if (group.name === "X") platform = "twitter";

    return { isUnsorted: group.name === "Unsorted", isParent: children.length > 0, children, platform };
  }

  getItemsInFolder(folderId: string): string[] {
    const folderIds = new Set<string>([folderId]);
    for (const [id, g] of this.groups) {
      if (g.status === "confirmed" && g.parentId === folderId) folderIds.add(id);
    }
    const items: string[] = [];
    for (const [itemId, assignedFolderId] of this.assignments) {
      if (folderIds.has(assignedFolderId)) items.push(itemId);
    }
    return items;
  }

  getFolderName(folderId: string): string | undefined {
    const g = this.groups.get(folderId);
    return g?.status === "confirmed" ? g.name : undefined;
  }

  getFolderParent(folderId: string): string | null {
    const g = this.groups.get(folderId);
    return g?.status === "confirmed" ? g.parentId : null;
  }

  getTotalItemCount(): number {
    return this.assignments.size + this.unassigned.length;
  }

  hasLibrary(): boolean {
    for (const g of this.groups.values()) {
      if (g.status === "confirmed") return true;
    }
    return this.unassigned.length > 0;
  }
}

interface FolderTreeEntry {
  id: string;
  name: string;
  source: string;
  parent: string | null;
  count: number;
  children: FolderTreeEntry[];
}

interface SelectedFolderInfo {
  isUnsorted: boolean;
  isParent: boolean;
  children: { id: string; name: string; itemIds: string[]; count: number }[];
  platform: string | null;
}
