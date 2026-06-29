/**
 * Smart Assign clustering pipeline — embed, score, discover, stage.
 */
import * as React from "react";
import { App, Notice } from "obsidian";
import type { RoostFilter, MatchDetail, ClassifyProposalData, SmartAssignInput } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import type { CategoryEmbeddings, CategoryTaxonomy } from "@/pipeline/taxonomy";
import type { IRoostPlugin } from "@/types/plugin";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { SmartAssignMode } from "@/ui/lib/smart-assign/types";
import { runClusteringStep0Embed } from "@/ui/lib/smart-assign/clustering-step-0-embed";
import { runClusteringStep1ScoreKnown } from "@/ui/lib/smart-assign/clustering-step-1-score";
import { runClusteringStep2DiscoverAndScore } from "@/ui/lib/smart-assign/clustering-step-2-discover";
import { runClusteringStep5Finalize } from "@/ui/lib/smart-assign/clustering-step-5-finalize";
import { buildClusteringContext } from "@/ui/lib/smart-assign/clustering-context";
import { loadTagDetectors, scoreWithTagDetectors, type TagAssignment } from "@/pipeline/evaluate";
import { augmentUncensoredAssignments } from "@/pipeline/uncensored-augment";
import { buildFileIndex, vaultBasePath } from "@/lib/vault-utils";
import { runRetrain, shouldRetrain, newLabelsSince } from "@/pipeline/retrain";
import { loadTrainingSet } from "@/pipeline/training-set";
import { loadRetrainMeta } from "@/pipeline/head-store";

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
  /**
   * Called after tag-detector scoring (Wave 2 D1). Absent when smartAssignTags
   * is false or weights are not found — callers must treat it as optional.
   */
  setTagAssignments?: (assignments: Map<string, TagAssignment>) => void;
}

/**
 * Self-Improving Loop: attempt a retrain BEFORE step-1 scoring so the current
 * run benefits from the improved head. Runs only when smartAssignAutoRetrain is
 * enabled, the trigger threshold is met, and is wrapped in its own try/catch so
 * a retrain failure never aborts the run.
 *
 * Exported for unit-testing in isolation (host interface is a minimal subset).
 */
export function maybeRetrainAtRunStart(host: Pick<SmartAssignClusteringHost, "app" | "plugin" | "log">): void {
  if (!host.plugin.settings.smartAssignAutoRetrain) return;
  try {
    const vault = host.app.vault;
    const ts = loadTrainingSet(vault);
    const since = loadRetrainMeta(vault).lastRetrainTs;
    if (shouldRetrain({ newLabelsSinceLastTrain: newLabelsSince(ts, since), newlyEligibleCount: 0 })) {
      const outcome = runRetrain(vault, host.log);
      if (outcome.ran) {
        if (outcome.swapped) {
          const pct =
            outcome.avgMacroDelta !== undefined
              ? `+${(outcome.avgMacroDelta * 100).toFixed(1)}%`
              : "+?%";
          new Notice(`Classifier improved (${pct} macro)`);
        } else {
          const regressor =
            outcome.catastrophic && outcome.catastrophic.length > 0
              ? outcome.catastrophic.join(", ")
              : "overall/macro";
          new Notice(`Retrain skipped — would regress ${regressor}`);
        }
      }
    }
  } catch (e: unknown) {
    host.log(`[retrain] failed (kept current head): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runSmartAssignClustering(host: SmartAssignClusteringHost): Promise<void> {
  host.setMode("staging");
  host.setPipelineStep(0);
  const signal: StopSignal = { stopped: false, stop() { this.stopped = true; host.log("Stop requested..."); } };
  host.refs.stopSignalRef.current = signal;

  try {
    const step0 = await runClusteringStep0Embed(host, signal);
    if (!step0) return;

    // ── Wave 2 D1: Multi-label tag scoring (default-off) ─────────────────────
    // Only runs when smartAssignTags=true AND the detector weights exist.
    // When either condition is false: setTagAssignments is never called → confirm
    // receives no tagAssignments → single-label behaviour is unchanged.
    if (host.plugin.settings.smartAssignTags && host.setTagAssignments) {
      const det = loadTagDetectors(host.app.vault);
      const tagMap = scoreWithTagDetectors(
        [...step0.unsortedIdSet],
        step0.cache,
        det,
        host.log,
      );
      if (tagMap !== null) {
        // ── Uncensored content image augment (inert when uncensoredCategories=[]) ──
        const uncensoredCats = host.plugin.settings.uncensoredCategories ?? [];
        if (uncensoredCats.length > 0 && det !== null) {
          const vp = vaultBasePath(host.app.vault);
          const fileIndex = buildFileIndex(host.app, host.plugin.settings.syncFolder);
          await augmentUncensoredAssignments(tagMap, [...step0.unsortedIdSet], {
            uncensoredCategories: uncensoredCats,
            det,
            vaultPath: vp,
            embeddingCache: step0.cache,
            fileIndex,
            metadataCache: host.app.metadataCache,
            onLog: host.log,
          });
        }
        host.setTagAssignments(tagMap);
      }
    }

    // ── Self-Improving Loop: retrain BEFORE scoring so this run uses the improved head ──
    maybeRetrainAtRunStart(host);

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
