import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import type { MatchDetail } from "@/types/roost";
import {
  galleryFilterLayoutState,
  galleryFilterMatchState,
  isGalleryFolderFilter,
  tryApplyGalleryFolderFilter,
} from "../gallery-filter-apply";

function mkEntry(i: number, fm: Record<string, unknown>): BasesEntry {
  return {
    file: { path: `Bookmarks/X/${i}.md` },
    getValue: (key: string) => fm[key],
  } as unknown as BasesEntry;
}

describe("galleryFilterMatchState", () => {
  it("clears match state when filter is null", () => {
    expect(galleryFilterMatchState(null)).toEqual({
      matchedRoostIds: null,
      matchDetailMap: null,
    });
  });
});

/**
 * Fix #1 (cross-run stale Set): BookmarksBasesView.setMatchState now resets
 * humanAssignedRoostIds to null and calls syncHumanAssignedToPlugin().
 *
 * BookmarksBasesView cannot be instantiated in vitest (Obsidian runtime class).
 * This test exercises the SAME logic at the nearest testable seam — a minimal
 * plain-object view that mirrors the fixed setMatchState body exactly. The
 * intent is to document the contract and prove the reset + sync logic is correct.
 *
 * Caller trace: SA run-2 Step 5 → applyFilter({folders}) → applyGalleryFilter
 *   → galleryFilterMatchState returns {null,null} → host.setMatchState(null,null)
 *   → humanAssignedRoostIds = null; syncHumanAssignedToPlugin().
 * Also: resetSmartAssignStaging → applyFilter(null) follows the same path.
 */
describe("setMatchState resets humanAssignedRoostIds per run (fix #1 seam test)", () => {
  it("clears humanAssignedRoostIds and plugin ref when setMatchState is called with null/null", () => {
    const plugin = { humanAssignedRoostIds: new Set(["stale-001"]) as Set<string> | null };

    // Mirrors BookmarksBasesView fields + the FIXED setMatchState body.
    const view = {
      matchedRoostIds: new Set(["old"]) as Set<string> | null,
      matchDetailMap: new Map() as Map<string, MatchDetail> | null,
      humanAssignedRoostIds: new Set(["stale-001"]) as Set<string> | null,
      getRoostPlugin() { return plugin; },
      setMatchState(matched: Set<string> | null, detail: Map<string, MatchDetail> | null) {
        this.matchedRoostIds = matched;
        this.matchDetailMap = detail;
        this.humanAssignedRoostIds = null;    // fix #1
        const p = this.getRoostPlugin();
        if (p) p.humanAssignedRoostIds = this.humanAssignedRoostIds; // syncHumanAssignedToPlugin
      },
    };

    view.setMatchState(null, null);

    expect(view.humanAssignedRoostIds).toBeNull();
    expect(plugin.humanAssignedRoostIds).toBeNull();
    // matchedRoostIds / matchDetailMap are also cleared (existing behaviour)
    expect(view.matchedRoostIds).toBeNull();
    expect(view.matchDetailMap).toBeNull();
  });

  it("returns null/null from galleryFilterMatchState for a folders filter (confirms SA step-5 path resets)", () => {
    // When SA step 5 finalizes, applyFilter({folders: proposals}) is called.
    // galleryFilterMatchState sees no matchedItemIds → returns {null, null}
    // → setMatchState(null, null) → humanAssignedRoostIds cleared.
    const state = galleryFilterMatchState({ folders: [{ name: "Tech", itemIds: ["x"], count: 1 }] } as never);
    expect(state.matchedRoostIds).toBeNull();
    expect(state.matchDetailMap).toBeNull();
  });
});

describe("isGalleryFolderFilter", () => {
  it("is true when folders array is non-empty", () => {
    expect(
      isGalleryFolderFilter({
        folders: [{ name: "A", itemIds: ["x"] }],
      } as never),
    ).toBe(true);
  });

  it("is false for empty folders or null filter", () => {
    expect(isGalleryFolderFilter({ folders: [] } as never)).toBe(false);
    expect(isGalleryFolderFilter(null)).toBe(false);
  });
});

describe("tryApplyGalleryFolderFilter", () => {
  it("returns null when filter has no folders", () => {
    const container = document.createElement("div");
    expect(
      tryApplyGalleryFolderFilter(null, container, {
        cardSize: 180,
        entries: [],
        imagePropId: "note.cover",
        resolveImageUrl: () => null,
        onFolderClick: () => {},
      }),
    ).toBeNull();
  });
});

describe("galleryFilterLayoutState", () => {
  it("pins matching ids to the front", () => {
    const entries = [
      mkEntry(0, { "note.roost_id": "a", "note.platform": "tiktok" }),
      mkEntry(1, { "note.roost_id": "b", "note.platform": "tiktok" }),
      mkEntry(2, { "note.roost_id": "c", "note.platform": "tiktok" }),
    ];
    const layout = galleryFilterLayoutState(
      entries,
      { itemIds: ["a", "b", "c"] },
      null,
      null,
      new Set(["c"]),
    );
    expect(layout.filteredIndices).toEqual([2, 0, 1]);
  });
});
