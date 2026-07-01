import { useState, useRef, useCallback } from "react";
import * as React from "react";
import { App } from "obsidian";
import type { RoostFilter, MatchDetail, ClassifyProposalData, SmartAssignInput } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import type { CategoryEmbeddings, CategoryTaxonomy } from "@/pipeline/taxonomy";
import { useGroupStore } from "@/ui/hooks/use-group-store";
import type { SyncProgress } from "@/ui/components/progress-header";
import type { IRoostPlugin } from "@/types/plugin";
import { waitForMetadataQuiet } from "@/lib/metadata-cache-quiet";
import { runSmartAssignClustering, type SmartAssignClusteringHost } from "@/ui/lib/smart-assign/clustering";
import { confirmSmartAssign } from "@/ui/lib/smart-assign/confirm";
import { saveClusterDescriptionToDisk } from "@/ui/lib/smart-assign/description-cache";
import { resetSmartAssignStaging, type SmartAssignResetHost } from "@/ui/lib/smart-assign/reset-state";
import { formatStagingTreeLog } from "@/ui/lib/smart-assign/staging-log";
import {
  acceptStagingNeighborSuggestions,
  dismissStagingSuggestions,
  reassignStagingItems,
  type SmartAssignReassignHost,
} from "@/ui/lib/smart-assign/reassign";
import type { SmartAssignMode } from "@/ui/lib/smart-assign/types";
import type { NeighborSuggestion } from "@/pipeline/suggest-neighbors";
import type { TagAssignment } from "@/pipeline/evaluate";

type Mode = SmartAssignMode;

interface SmartAssignDeps {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  scanLibrary: () => Promise<void>;
  /** Optimistically repaint the sidebar counts from a known assignment delta,
   *  so confirm shows a single snappy update instead of a file-by-file ripple. */
  applyOptimisticAssignment: (delta: Map<string, number>) => void;
  applyFilter: (filter: RoostFilter) => void;
  stopSignalRef: React.MutableRefObject<StopSignal | null>;
  setSyncProgress: (p: SyncProgress | null | ((prev: SyncProgress | null) => SyncProgress | null)) => void;
}

export function useSmartAssign(deps: SmartAssignDeps) {
  const { app, plugin, log, scanLibrary, applyOptimisticAssignment, applyFilter, stopSignalRef, setSyncProgress } = deps;

  const [mode, setMode] = useState<Mode>("sync");
  const [pipelineStep, setPipelineStep] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [userTopics, setUserTopics] = useState<string[]>([]);
  const [proposal, setProposal] = useState<ClassifyProposalData | null>(null);
  const [vaultCollections, setVaultCollections] = useState<Record<string, string[]>>({});
  const [unsortedIds, setUnsortedIds] = useState<Set<string>>(new Set());
  const [forceToggle, setForceToggle] = useState<Set<string>>(new Set());
  const [userRenames, setUserRenames] = useState<Map<string, string>>(new Map());
  const [matchedToCollections, setMatchedToCollections] = useState<Record<string, string[]>>({});
  const [matchDetailMap, setMatchDetailMap] = useState<Map<string, MatchDetail>>(new Map());
  const [assignedSubcategories, setAssignedSubcategories] = useState<Map<string, string | null>>(new Map());
  const { store, version: storeVersion, bump: bumpStore, loadFromClusterOutput, clearProposal } = useGroupStore();

  const catEmbeddingsRef = useRef<CategoryEmbeddings | null>(null);
  const taxonomyRef = useRef<CategoryTaxonomy | null>(null);
  // Wave 2 D1: populated by runSmartAssignClustering when smartAssignTags=true
  // and detector weights are found. Cleared on each new clustering run.
  const tagAssignmentsRef = useRef<Map<string, TagAssignment> | null>(null);

  const [newClusterDescriptions, setNewClusterDescriptions] = useState<Map<string, string>>(new Map());
  const [newClusterNotDescriptions, setNewClusterNotDescriptions] = useState<Map<string, string>>(new Map());

  const descCachePathRef = useRef<string | null>(null);
  const notDescCachePathRef = useRef<string | null>(null);

  const platformRef = useRef<string | undefined>(undefined);
  const inputRef = useRef<SmartAssignInput | null>(null);

  const clusteringRefs = {
    platformRef,
    inputRef,
    stopSignalRef,
    descCachePathRef,
    notDescCachePathRef,
    catEmbeddingsRef,
    taxonomyRef,
  };

  function buildResetHost(): SmartAssignResetHost {
    return {
      setProposal,
      setVaultCollections,
      setMatchedToCollections,
      setMatchDetailMap,
      setUnsortedIds,
      catEmbeddingsRef,
      taxonomyRef,
      inputRef,
      clearProposal,
      setPipelineStep,
      applyFilter,
      setNewClusterDescriptions,
      setNewClusterNotDescriptions,
      setMode,
    };
  }

  function buildClusteringHost(): SmartAssignClusteringHost {
    return {
      app,
      plugin,
      log,
      applyFilter,
      setSyncProgress,
      getUserTopics: () => userTopics,
      getInput: () => inputRef.current,
      refs: clusteringRefs,
      setMode,
      setPipelineStep,
      setUnsortedIds,
      setMatchedToCollections,
      setMatchDetailMap,
      setVaultCollections,
      setProposal,
      setNewClusterDescriptions,
      setNewClusterNotDescriptions,
      setAssignedSubcategories,
      setForceToggle,
      setUserRenames,
      loadFromClusterOutput,
      // Wave 2 D1: store tag assignments so handleConfirm can pass them through.
      setTagAssignments: (assignments) => { tagAssignmentsRef.current = assignments; },
    };
  }

  const [suggestions, setSuggestions] = useState<NeighborSuggestion[]>([]);
  const [suggestionTarget, setSuggestionTarget] = useState<string | null>(null);

  function buildReassignHost(): SmartAssignReassignHost {
    return {
      log,
      vault: app.vault,
      clipFusionAlpha: plugin.settings.clipFusionAlpha,
      getVaultCollections: () => vaultCollections,
      setVaultCollections,
      applyFilter,
      bumpStore,
      store,
      setSuggestions,
      setSuggestionTarget,
    };
  }

  async function run(input: SmartAssignInput) {
    inputRef.current = input;
    platformRef.current = undefined;
    const scopeLabel = input.write.into === "subcategoryOf"
      ? `Sort "${input.write.parent}" into subcategories`
      : input.allowDiscovery
      ? `${input.itemIds.length} items`
      : `resort ${input.itemIds.length} items`;
    log(`Smart Assign targeting: ${scopeLabel} (${input.itemIds.length} items, ${Object.keys(input.collections).length} anchor collections, ${input.topics.length} topics)`);
    setUserTopics([...input.topics].sort());
    setMode("topics");
  }

  async function runClustering_() {
    // Clear any tag assignments from a prior run before starting a new one.
    tagAssignmentsRef.current = null;
    await runSmartAssignClustering(buildClusteringHost());
  }

  async function handleConfirm(proposedFolders: { name: string; itemIds: string[] }[] | null) {
    if (!proposedFolders) return;
    setConfirming(true);

    // Optimistic, single repaint of the sidebar counts: we already know each item's
    // assigned category, so move the unsorted items into their categories now rather
    // than waiting for Obsidian to lazily re-index the bulk write file-by-file. The
    // reconcile scanLibrary() below corrects any drift (uncertain-skips, failures).
    const delta = new Map<string, number>();
    let moved = 0;
    for (const folder of proposedFolders) {
      let n = 0;
      for (const id of folder.itemIds) if (unsortedIds.has(id)) n++;
      if (n > 0) { delta.set(folder.name, (delta.get(folder.name) ?? 0) + n); moved += n; }
    }
    applyOptimisticAssignment(delta);
    // Hold the rebuild-suppression flag long enough for a write this size to finish
    // indexing, so trailing "resolved" events don't re-derive partial counts on top
    // of the optimistic repaint. Scales with batch size; capped.
    const settleTimeoutMs = Math.min(90_000, 15_000 + moved * 4);

    try {
      await confirmSmartAssign({
        plugin,
        syncFolder: plugin.settings.syncFolder,
        log,
        setSyncProgress,
        getInput: () => inputRef.current,
        unsortedIds,
        assignedSubcategories,
        store,
        fileManager: app.fileManager,
        metadataCache: app.metadataCache,
        // Wave 2 D1: pass tag assignments when they were computed during clustering.
        // tagAssignmentsRef.current is null (never set) when smartAssignTags=false
        // or the detector weights were absent — confirm falls back to single-label.
        tagAssignments: tagAssignmentsRef.current ?? undefined,
        // Self-Improving Loop: provide the phase-1 match-detail map so captureLoopUpdates
        // can extract each item's pre-confirm guess and tier.
        getMatchDetails: () => matchDetailMap,
        // Review-pass exclusion (Task 3 guard, now live): pass the human-judged set so
        // buildItemCategory and captureLoopUpdates skip already-judged ids. The gallery
        // view's class field is the canonical store; the plugin holds the same Set
        // instance (written by reviewConfirm/reviewMove/reviewReject via syncToPlugin).
        humanAssignedRoostIds: plugin.humanAssignedRoostIds ?? undefined,
        runUnderGuard: async () => {
          resetSmartAssignStaging(buildResetHost());
          // bulkWriteInProgress stays true here, so the optimistic counts hold while
          // Obsidian finishes indexing; reconcile with a single re-scan once quiet.
          await waitForMetadataQuiet(app.metadataCache, { quietMs: 600, timeoutMs: settleTimeoutMs });
          await scanLibrary();
          // Refresh pending-pipeline counts now that frontmatter has settled,
          // then auto-enqueue any pipelines that have new work.
          plugin.refreshPendingPipelines();
          void plugin.autoEnqueuePendingPipelines();
        },
      }, proposedFolders);
    } finally {
      setConfirming(false);
    }
  }

  function handleCancel() {
    resetSmartAssignStaging(buildResetHost());
  }

  function reassignItems(itemIds: string[], fromGroupId: string, toGroupId: string) {
    return reassignStagingItems(buildReassignHost(), itemIds, fromGroupId, toGroupId);
  }

  function dismissSuggestions() {
    dismissStagingSuggestions(buildReassignHost());
  }

  function acceptSuggestions(itemIds: string[]) {
    if (!suggestionTarget) return;
    acceptStagingNeighborSuggestions(buildReassignHost(), suggestions, suggestionTarget, itemIds);
  }

  const rejectItem = useCallback((itemId: string) => {
    store.rejectItem(itemId);
    bumpStore();
  }, [store, bumpStore]);

  const rejectItems = useCallback((ids: string[]) => {
    store.rejectItems(ids);
    bumpStore();
  }, [store, bumpStore]);

  function moveItemsTo(ids: string[], toGroupId: string): void {
    store.reassignItemsTo(ids, toGroupId);
    bumpStore();
    const filter = plugin.activeFilter;
    if (filter?.groupId) {
      const group = store.getGroup(filter.groupId);
      if (group) applyFilter({ itemIds: group.itemIds, groupId: filter.groupId });
    }
  }

  const sliderSplitIds = React.useMemo(() => {
    if (!proposal) return new Set<string>();
    return store.getSliderSplits(15);
  }, [proposal, storeVersion]);

  const proposalResult = React.useMemo(() => {
    if (!proposal) return null;
    return store.getVisibleLeaves(sliderSplitIds, forceToggle, vaultCollections, userRenames);
  }, [proposal, sliderSplitIds, forceToggle, vaultCollections, userRenames, storeVersion]);

  const proposedFolders = proposalResult?.folders ?? null;
  const absorbedNodeIds = proposalResult?.absorbedIds ?? new Set<string>();
  const nodeCollectionMap = proposalResult?.nodeCollectionMap ?? new Map<string, string>();
  const noiseFolder = proposalResult?.noiseFolder ?? null;

  plugin.proposedFolderNames = proposedFolders
    ? proposedFolders.map(f => ({ id: f.id, name: f.name }))
    : [];

  React.useEffect(() => {
    if (!proposedFolders) return;
    const { leakLines, body } = formatStagingTreeLog({
      proposedFolders,
      vaultCollections,
      nodeCollectionMap,
      noiseFolder,
      getGroupLabel: (nodeId) => {
        const group = store.getGroup(nodeId);
        return { name: group?.name || nodeId, itemCount: group?.itemIds.length || 0 };
      },
    });
    if (leakLines.length > 0) {
      log(`--- COLLECTION LEAKS ---\n${leakLines.join("\n")}`);
    }
    log(body);
  }, [proposedFolders, vaultCollections, nodeCollectionMap, noiseFolder, storeVersion]);

  async function saveClusterDescription(name: string, desc: string, notDesc: string): Promise<void> {
    const nextDescs = new Map(newClusterDescriptions);
    nextDescs.set(name, desc);
    setNewClusterDescriptions(nextDescs);

    const nextNotDescs = new Map(newClusterNotDescriptions);
    if (notDesc) nextNotDescs.set(name, notDesc);
    else nextNotDescs.delete(name);
    setNewClusterNotDescriptions(nextNotDescs);

    await saveClusterDescriptionToDisk(name, desc, notDesc, descCachePathRef.current, notDescCachePathRef.current, log);
  }

  return {
    mode, setMode,
    pipelineStep, confirming,
    userTopics, setUserTopics,
    suggestedTopics: inputRef.current?.suggestedTopics ?? [],
    proposal, vaultCollections, matchedToCollections, matchDetailMap,
    forceToggle, setForceToggle, userRenames,
    store, storeVersion,
    proposedFolders, absorbedNodeIds, nodeCollectionMap, noiseFolder,
    sliderSplitIds,
    assignedSubcategories, setAssignedSubcategories,
    newClusterDescriptions, newClusterNotDescriptions, saveClusterDescription,
    run,
    runClustering: runClustering_,
    handleConfirm,
    handleCancel,
    reassignItems,
    rejectItem,
    rejectItems,
    moveItemsTo,
    suggestions, suggestionTarget,
    acceptSuggestions, dismissSuggestions,
  };
}
