import type { EmbeddingCacheEntry, MatchDetail, SmartAssignInput, ClassifyProposalData } from "@/types/roost";
import type { AnchorNameEmbeddingCache } from "@/lib/anchor-name-embeddings";
import type { Embedder } from "@/lib/embedder";

export interface SmartAssignClusteringContext {
  input: SmartAssignInput;
  platform: string | undefined;
  cache: Record<string, EmbeddingCacheEntry>;
  embedder: Embedder;

  // Items and ids
  items: Array<{ id: string }>;
  unsortedIdSet: Set<string>;
  targetPlatformIds: Set<string>;
  collectionIdSet: Set<string>;
  unsortedItemIds: string[];

  // Collections (mutated through the pipeline)
  collections: Record<string, string[]>;

  // Step 1 outputs
  matched: Record<string, string[]>;
  phase1Assignments: Map<string, string>;
  phase1Unmatched: string[];
  phase1MatchDetails: Map<string, MatchDetail>;
  liveAssignedSubcats: Map<string, string | null>;
  isFilterMode: boolean;

  // Description + anchor-name caches
  descCachePath: string;
  notDescCachePath: string;
  collDescs: Map<string, string>;
  collNotDescs: Map<string, string>;
  anchorCache: AnchorNameEmbeddingCache;

  // Step 2 outputs
  miscIds: string[];
  result: ClassifyProposalData;
}

export type ClusteringStep0Slice = Pick<
  SmartAssignClusteringContext,
  | "input"
  | "platform"
  | "cache"
  | "embedder"
  | "items"
  | "unsortedIdSet"
  | "targetPlatformIds"
  | "collectionIdSet"
  | "unsortedItemIds"
  | "collections"
>;

export type ClusteringStep1Slice = Pick<
  SmartAssignClusteringContext,
  | "matched"
  | "phase1Assignments"
  | "phase1Unmatched"
  | "phase1MatchDetails"
  | "liveAssignedSubcats"
  | "isFilterMode"
  | "descCachePath"
  | "notDescCachePath"
  | "collDescs"
  | "collNotDescs"
  | "anchorCache"
>;

export type ClusteringStep2Slice = Pick<
  SmartAssignClusteringContext,
  | "miscIds"
  | "result"
>;

export function buildClusteringContext(
  step0: ClusteringStep0Slice,
  step1: ClusteringStep1Slice,
  step2: ClusteringStep2Slice,
): SmartAssignClusteringContext {
  return {
    ...step0,
    ...step1,
    ...step2,
  };
}

