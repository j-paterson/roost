import { useState, useCallback, useRef } from "react";
import { GroupStore } from "@/ui/lib/group-store";
import type { ClassifyProposalData, LibraryState } from "@/types/roost";

/**
 * React hook wrapping GroupStore with version-based reactivity.
 * The store instance is stable across renders.
 */
export function useGroupStore() {
  const storeRef = useRef(new GroupStore());
  const store = storeRef.current;
  const [version, setVersion] = useState(0);

  const bump = useCallback(() => setVersion(v => v + 1), []);

  const loadFromClusterOutput = useCallback((data: ClassifyProposalData) => {
    store.loadFromClusterOutput(data);
    bump();
  }, [store, bump]);

  const loadFromLibraryState = useCallback((state: LibraryState) => {
    // Only bump if data actually changed (avoids cascading memo invalidation)
    if (store.loadFromLibraryState(state)) bump();
  }, [store, bump]);

  const clearProposal = useCallback(() => {
    store.clearProposal();
    bump();
  }, [store, bump]);

  const applyRecategorization = useCallback((result: Parameters<typeof store.applyRecategorization>[0]) => {
    store.applyRecategorization(result);
    bump();
  }, [store, bump]);

  return {
    store,
    version,
    bump,
    loadFromClusterOutput,
    loadFromLibraryState,
    clearProposal,
    applyRecategorization,
  };
}
