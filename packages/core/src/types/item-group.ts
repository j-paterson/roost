import type { ClassifySample } from "@/types/roost";

/**
 * Canonical representation of a group of items.
 * Used for tree nodes, proposals, collection groups, and persisted folders.
 */
export interface ItemGroup {
  /** Stable UUID — generated once, never changes */
  id: string;

  /** Display name (user-editable) */
  name: string;

  /** Alternative name suggestions */
  altNames: string[];

  /** Lifecycle status */
  status: "proposed" | "confirmed" | "archived";

  /** Origin of this group */
  source: "cluster" | "collection" | "noise" | "smart-assign" | "manual" | "imported";

  /** Items directly in this group */
  itemIds: string[];

  /** High-confidence items (subset of itemIds) */
  certainItemIds?: string[];

  /** Low-confidence items — passed scoring but below conviction threshold (subset of itemIds) */
  uncertainItemIds?: string[];

  /** Parent group ID, or null for root */
  parentId: string | null;

  /**
   * Child group IDs, or null for leaf nodes.
   */
  children: string[] | null;

  /** Cluster cohesion score (0-1). Only meaningful for cluster-derived groups. */
  cohesion: number | null;

  /** Representative samples for thumbnail display */
  samples: ClassifySample[];

  /** Whether this group was derived from a TikTok collection tag */
  fromCollection: boolean;
}
