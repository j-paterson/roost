import { useState, useRef } from "react";
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

type Mode = SmartAssignMode;

interface SmartAssignDeps {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  scanLibrary: () => Promise<void>;
  applyFilter: (filter: RoostFilter) => void;
  stopSignalRef: React.MutableRefObject<StopSignal | null>;
  setSyncProgress: (p: SyncProgress | null | ((prev: SyncProgress | null) => SyncProgress | null)) => void;
}

export function useSmartAssign(deps: SmartAssignDeps) {
  const { app, plugin, log, scanLibrary, applyFilter, stopSignalRef, setSyncProgress } = deps;

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
    await runSmartAssignClustering(buildClusteringHost());
  }

  async function handleConfirm(proposedFolders: { name: string; itemIds: string[] }[] | null) {
    if (!proposedFolders) return;
    setConfirming(true);
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
        runUnderGuard: async () => {
          await scanLibrary();
          resetSmartAssignStaging(buildResetHost());
          await waitForMetadataQuiet(app.metadataCache);
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
    suggestions, suggestionTarget,
    acceptSuggestions, dismissSuggestions,
  };
}
