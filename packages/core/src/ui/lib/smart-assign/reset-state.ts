/**
 * Reset Smart Assign staging state after cancel or successful confirm.
 */
import type * as React from "react";
import type { ClassifyProposalData, MatchDetail, RoostFilter, SmartAssignInput } from "@/types/roost";
import type { CategoryEmbeddings, CategoryTaxonomy } from "@/pipeline/taxonomy";
import type { SmartAssignMode } from "@/ui/lib/smart-assign/types";

export interface SmartAssignResetHost {
  setProposal: (p: ClassifyProposalData | null) => void;
  setVaultCollections: (c: Record<string, string[]>) => void;
  setMatchedToCollections: (m: Record<string, string[]>) => void;
  setMatchDetailMap: (m: Map<string, MatchDetail>) => void;
  setUnsortedIds: (ids: Set<string>) => void;
  catEmbeddingsRef: React.MutableRefObject<CategoryEmbeddings | null>;
  taxonomyRef: React.MutableRefObject<CategoryTaxonomy | null>;
  inputRef: React.MutableRefObject<SmartAssignInput | null>;
  clearProposal: () => void;
  setPipelineStep: (step: number | null) => void;
  applyFilter: (filter: RoostFilter | null) => void;
  setNewClusterDescriptions: (m: Map<string, string>) => void;
  setNewClusterNotDescriptions: (m: Map<string, string>) => void;
  setMode: (mode: SmartAssignMode) => void;
}

export function resetSmartAssignStaging(host: SmartAssignResetHost): void {
  host.setProposal(null);
  host.setVaultCollections({});
  host.setMatchedToCollections({});
  host.setMatchDetailMap(new Map());
  host.setUnsortedIds(new Set());
  host.catEmbeddingsRef.current = null;
  host.taxonomyRef.current = null;
  host.inputRef.current = null;
  host.clearProposal();
  host.setPipelineStep(null);
  host.applyFilter(null);
  host.setNewClusterDescriptions(new Map());
  host.setNewClusterNotDescriptions(new Map());
  host.setMode("sync");
}
