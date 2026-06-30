// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Spy on the heavy scan so the test asserts WHEN it runs, not its vault output.
const scanLibraryTree = vi.fn(() => ({ total: 0, unsorted: 0, categories: [], platforms: [] }));
vi.mock("@/ui/lib/library-tree", () => ({
  scanLibraryTree: (...args: unknown[]) => scanLibraryTree(...args),
  applyCategoryDelta: (prev: unknown) => prev,
}));

import { useLibraryTree } from "@/ui/hooks/use-library-tree";

type ResolvedCb = () => void;
type BulkCb = (active: boolean) => void;

function makeHarness(bulkWriteInProgress = false) {
  let resolvedCb: ResolvedCb = () => {};
  let bulkCb: BulkCb = () => {};
  const app = {
    metadataCache: {
      on: (evt: string, cb: ResolvedCb) => { if (evt === "resolved") resolvedCb = cb; return { evt }; },
      offref: () => {},
    },
  } as never;
  const plugin = {
    bulkWriteInProgress,
    settings: { syncFolder: "Roost", categoryOrder: [], subcategoryOrder: {}, emptySubcategories: {} },
    onBulkWriteChange: (cb: BulkCb) => { bulkCb = cb; return () => {}; },
  } as never;
  return { app, plugin, fireResolved: () => resolvedCb(), fireBulk: (v: boolean) => bulkCb(v) };
}

describe("useLibraryTree", () => {
  beforeEach(() => { scanLibraryTree.mockClear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("scans once on mount", () => {
    const h = makeHarness();
    renderHook(() => useLibraryTree(h.app, h.plugin));
    expect(scanLibraryTree).toHaveBeenCalledTimes(1);
  });

  it("reconciles (re-scans) when the bulk-write flag flips to false", () => {
    const h = makeHarness(true); // a sync is in progress
    renderHook(() => useLibraryTree(h.app, h.plugin));
    expect(scanLibraryTree).toHaveBeenCalledTimes(1); // mount scan
    h.fireBulk(false); // sync ends → flag clears
    expect(scanLibraryTree).toHaveBeenCalledTimes(2); // reconcile
  });

  it("does NOT re-scan on 'resolved' while a bulk write is in progress", () => {
    const h = makeHarness(true);
    renderHook(() => useLibraryTree(h.app, h.plugin));
    scanLibraryTree.mockClear();
    h.fireResolved();
    vi.advanceTimersByTime(500); // past the 300ms debounce
    expect(scanLibraryTree).not.toHaveBeenCalled();
  });

  it("re-scans on 'resolved' (debounced) when idle", () => {
    const h = makeHarness(false);
    renderHook(() => useLibraryTree(h.app, h.plugin));
    scanLibraryTree.mockClear();
    h.fireResolved();
    expect(scanLibraryTree).not.toHaveBeenCalled(); // debounced, not yet
    vi.advanceTimersByTime(350);
    expect(scanLibraryTree).toHaveBeenCalledTimes(1);
  });
});
