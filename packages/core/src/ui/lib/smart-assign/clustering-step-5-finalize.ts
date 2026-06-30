import type { ClassifyProposalData, EmbeddingCacheEntry, MatchDetail } from "@/types/roost";
import type { SmartAssignClusteringHost } from "@/ui/lib/smart-assign/clustering";
import { PIPELINE_STEP } from "@/ui/lib/smart-assign/pipeline-steps";

export function runClusteringStep5Finalize(
  host: SmartAssignClusteringHost,
  args: {
    cache: Record<string, EmbeddingCacheEntry>;
    itemsCount: number;
    collectionCount: number;
    scoredItemsCount: number;
    phase1AssignmentsCount: number;
    phase1UnmatchedCount: number;
    miscCount: number;
    userTopics: string[];
    collections: Record<string, string[]>;
    matchDetailMap: Map<string, MatchDetail>;
    unsortedIds: Set<string>;
    assignedSubcategories: Map<string, string | null>;
    result: ClassifyProposalData;
  },
): void {
  const discoveredCount = args.scoredItemsCount - args.phase1AssignmentsCount - args.miscCount;
  host.log(`\n── Pipeline summary ──`);
  host.log(`  ${args.itemsCount} total items (${args.collectionCount} in collections, ${args.scoredItemsCount} unsorted)`);
  host.log(`  Step 1: ${args.phase1AssignmentsCount} matched known collections`);
  host.log(`  Step 2: ${args.phase1UnmatchedCount} → discovery → ${discoveredCount} categorized`);
  host.log(`  Misc:   ${args.miscCount} uncategorized`);

  host.setForceToggle(new Set());
  host.setUserRenames(new Map());

  host.log(`\n── Step 5: Review ──`);
  host.setPipelineStep(PIPELINE_STEP.REVIEW);
  const allProposals = args.result?.proposals || [];
  host.applyFilter({
    folders: allProposals.map(p => ({
      name: p.suggestedName,
      count: p.itemIds.length,
      itemIds: p.itemIds,
      cohesion: p.confidence,
    })),
  });
}

