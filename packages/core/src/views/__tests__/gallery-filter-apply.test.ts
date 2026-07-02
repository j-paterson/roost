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
 * Per-run review-state reset contract.
 *
 * REGRESSION (found live): the reset originally lived in setMatchState, but
 * applyFilter calls setMatchState on EVERY data update (performDataUpdate →
 * applyFilter(currentFilter)), so each judgment's frontmatter write wiped
 * humanAssignedRoostIds and the review-pass queue ~250ms later. The reset now
 * fires ONLY on the "smartAssignRunStarted" item-click event, emitted once at
 * the start of runSmartAssignClustering.
 *
 * BookmarksBasesView cannot be instantiated in vitest (Obsidian runtime class);
 * these tests exercise the contract at the nearest testable seam — plain-object
 * mirrors of the setMatchState body and the event-handler body.
 */
describe("review-state reset lives on smartAssignRunStarted, NOT setMatchState", () => {
  it("setMatchState preserves humanAssignedRoostIds (it runs on every data update)", () => {
    const plugin = { humanAssignedRoostIds: new Set(["judged-001"]) as Set<string> | null };

    // Mirrors BookmarksBasesView fields + the CURRENT setMatchState body.
    const view = {
      matchedRoostIds: new Set(["old"]) as Set<string> | null,
      matchDetailMap: new Map() as Map<string, MatchDetail> | null,
      humanAssignedRoostIds: plugin.humanAssignedRoostIds,
      setMatchState(matched: Set<string> | null, detail: Map<string, MatchDetail> | null) {
        this.matchedRoostIds = matched;
        this.matchDetailMap = detail;
        // no review-state reset here — see smartAssignRunStarted handler
      },
    };

    view.setMatchState(null, null);

    // Mid-pass data updates must NOT wipe the judged set.
    expect(view.humanAssignedRoostIds).toEqual(new Set(["judged-001"]));
    expect(plugin.humanAssignedRoostIds).toEqual(new Set(["judged-001"]));
    expect(view.matchedRoostIds).toBeNull();
    expect(view.matchDetailMap).toBeNull();
  });

  it("the smartAssignRunStarted handler clears the judged set, plugin ref, and review pass", () => {
    const plugin = { humanAssignedRoostIds: new Set(["stale-001"]) as Set<string> | null };
    let reviewPassResets = 0;

    // Mirrors the view's onItemClick("smartAssignRunStarted") handler body.
    const view = {
      humanAssignedRoostIds: new Set(["stale-001"]) as Set<string> | null,
      getRoostPlugin() { return plugin; },
      feedMode: { resetReviewPass: () => { reviewPassResets++; } },
      onRunStarted() {
        this.humanAssignedRoostIds = null;
        const p = this.getRoostPlugin();
        if (p) p.humanAssignedRoostIds = this.humanAssignedRoostIds; // syncHumanAssignedToPlugin
        this.feedMode.resetReviewPass();
      },
    };

    view.onRunStarted();

    expect(view.humanAssignedRoostIds).toBeNull();
    expect(plugin.humanAssignedRoostIds).toBeNull();
    expect(reviewPassResets).toBe(1);
  });

  it("galleryFilterMatchState returns null/null for a folders filter (no phantom matches at staging)", () => {
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
