/**
 * Smart Assign clustering pipeline — embed, score, discover, stage.
 */
import * as React from "react";
import { App } from "obsidian";
import type { RoostFilter, MatchDetail, ClassifyProposalData, SmartAssignInput } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import type { IRoostPlugin } from "@/types/plugin";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { SmartAssignMode } from "@/ui/lib/smart-assign/types";
import { runClusteringStep0Embed } from "@/ui/lib/smart-assign/clustering-step-0-embed";
import { runClusteringStep1ScoreKnown } from "@/ui/lib/smart-assign/clustering-step-1-score";
import { runClusteringStep2DiscoverAndScore } from "@/ui/lib/smart-assign/clustering-step-2-discover";
import { runClusteringStep5Finalize } from "@/ui/lib/smart-assign/clustering-step-5-finalize";
import { buildClusteringContext } from "@/ui/lib/smart-assign/clustering-context";

export interface SmartAssignClusteringRefs {
  platformRef: React.MutableRefObject<string | undefined>;
  inputRef: React.MutableRefObject<SmartAssignInput | null>;
  stopSignalRef: React.MutableRefObject<StopSignal | null>;
  descCachePathRef: React.MutableRefObject<string | null>;
  notDescCachePathRef: React.MutableRefObject<string | null>;
  catEmbeddingsRef: React.MutableRefObject<CategoryEmbeddings | null>;
  taxonomyRef: React.MutableRefObject<CategoryTaxonomy | null>;
}

export interface SmartAssignClusteringHost {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  applyFilter: (filter: RoostFilter) => void;
  setSyncProgress: (p: SyncProgress | null | ((prev: SyncProgress | null) => SyncProgress | null)) => void;
  getUserTopics: () => string[];
  getInput: () => SmartAssignInput | null;
  refs: SmartAssignClusteringRefs;
  setMode: (mode: SmartAssignMode) => void;
  setPipelineStep: (step: number | null) => void;
  setUnsortedIds: (ids: Set<string>) => void;
  setMatchedToCollections: (m: Record<string, string[]>) => void;
  setMatchDetailMap: (m: Map<string, MatchDetail>) => void;
  setVaultCollections: (c: Record<string, string[]>) => void;
  setProposal: (p: ClassifyProposalData | null) => void;
  setNewClusterDescriptions: (m: Map<string, string>) => void;
  setNewClusterNotDescriptions: (m: Map<string, string>) => void;
  setAssignedSubcategories: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
  setForceToggle: (s: Set<string>) => void;
  setUserRenames: (m: Map<string, string>) => void;
  loadFromClusterOutput: (result: ClassifyProposalData) => void;
}

export async function runSmartAssignClustering(host: SmartAssignClusteringHost): Promise<void> {
  host.setMode("staging");
  host.setPipelineStep(0);
  const signal: StopSignal = { stopped: false, stop() { this.stopped = true; host.log("Stop requested..."); } };
  host.refs.stopSignalRef.current = signal;

  try {
    const step0 = await runClusteringStep0Embed(host, signal);
    if (!step0) return;

    const step1 = await runClusteringStep1ScoreKnown(host, signal, step0);
    if (!step1) return;

    const step2 = await runClusteringStep2DiscoverAndScore(host, signal, { ...step0, ...step1 });
    if (!step2) return;

    const ctx = buildClusteringContext(step0, step1, step2);

    runClusteringStep5Finalize(host, {
      cache: ctx.cache,
      itemsCount: ctx.items.length,
      collectionCount: ctx.collectionIdSet.size,
      scoredItemsCount: ctx.unsortedItemIds.length,
      phase1AssignmentsCount: ctx.phase1Assignments.size,
      phase1UnmatchedCount: ctx.phase1Unmatched.length,
      miscCount: ctx.miscIds.length,
      userTopics: host.getUserTopics(),
      collections: ctx.collections,
      matchDetailMap: ctx.phase1MatchDetails,
      unsortedIds: ctx.unsortedIdSet,
      assignedSubcategories: ctx.liveAssignedSubcats,
      result: ctx.result,
    });
  } catch (e: unknown) {
    host.log(`[ERROR] ${(e instanceof Error ? e.message : String(e))}`);
    host.setMode("sync");
    host.setPipelineStep(null);
    host.setNewClusterDescriptions(new Map());
    host.setNewClusterNotDescriptions(new Map());
  } finally {
    host.refs.stopSignalRef.current = null;
    host.setSyncProgress(null);
  }
}
