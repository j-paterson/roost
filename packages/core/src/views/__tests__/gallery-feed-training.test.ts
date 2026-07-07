import { describe, it, expect, vi } from "vitest";
import {
  computeAdvance,
  computeReviewPassEntries,
  GalleryFeedModeController,
  type GalleryFeedModeHost,
} from "@/views/gallery-feed-mode";
import { getRoostId } from "@/lib/bases-entry";
import type { BasesEntry } from "obsidian";

// computeAdvance is the pure core of advanceAfterAction: given the remaining roostIds
// (after the judged item left the filtered set) and the judged item's index, return the
// roostId that should become active (the item that took the judged slot, else the last).
describe("computeAdvance", () => {
  it("activates the item now occupying the judged index", () => {
    expect(computeAdvance(["a", "c", "d"], 1)).toBe("c"); // b was at index 1, judged & removed
  });
  it("clamps to the last item when the judged item was last", () => {
    expect(computeAdvance(["a", "b"], 2)).toBe("b");
  });
  it("returns null when the queue is now empty", () => {
    expect(computeAdvance([], 0)).toBeNull();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEntry(roostId: string, category: string | null = null): BasesEntry {
  const fm: Record<string, unknown> = { roost_id: roostId };
  if (category !== null) {
    fm.roost_category = category;
    fm.roost_assigned_by = "auto";
  }
  return {
    file: { path: `${roostId}.md`, basename: roostId },
    getValue: (key: string) => {
      const k = key.replace(/^note\./, "");
      return fm[k] ?? undefined;
    },
    // BasesEntry has a dynamic getValue; anything else can be undefined
  } as unknown as BasesEntry;
}

// ── computeReviewPassEntries ──────────────────────────────────────────────────

describe("computeReviewPassEntries", () => {
  it("orders entries by reviewPassIds regardless of allEntries order", () => {
    const entries = [makeEntry("c"), makeEntry("a"), makeEntry("b")];
    const result = computeReviewPassEntries(["a", "b", "c"], entries, new Set());
    expect(result.map(e => getRoostId(e))).toEqual(["a", "b", "c"]);
  });

  it("excludes skipped ids", () => {
    const entries = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = computeReviewPassEntries(["a", "b", "c"], entries, new Set(["b"]));
    expect(result.map(e => getRoostId(e))).toEqual(["a", "c"]);
  });

  it("drops ids not found in allEntries (missing from vault)", () => {
    const entries = [makeEntry("a"), makeEntry("c")];
    const result = computeReviewPassEntries(["a", "b", "c"], entries, new Set());
    expect(result.map(e => getRoostId(e))).toEqual(["a", "c"]);
  });

  it("returns empty array when all are skipped", () => {
    const entries = [makeEntry("a"), makeEntry("b")];
    const result = computeReviewPassEntries(["a", "b"], entries, new Set(["a", "b"]));
    expect(result).toHaveLength(0);
  });
});

// ── GalleryFeedModeController review-pass dispatch ───────────────────────────
// These tests drive the controller without entering feed mode (no DOM).
// We set trainingMode = true and reviewPassIds directly (both public),
// then call the private handleTrainingAction via `(ctrl as any)`.
//
// The effectful host writes (processFrontMatter / save) are stubs here; the
// I/O path (real vault writes) is verified by the Task 7 smoke test.

function makeTestHost(
  entries: BasesEntry[],
  overrides: Partial<GalleryFeedModeHost> = {},
): GalleryFeedModeHost {
  return {
    app: {} as GalleryFeedModeHost["app"],
    scrollEl: {} as HTMLElement,
    containerEl: {} as HTMLElement,
    scrollCardIntoView: () => {},
    getImagePropId: () => "note.cover",
    getScopedEntries: () => entries,
    getAllEntries: () => entries,
    getRoostPlugin: () => null,
    findEntryByRoostId: (id) => entries.find(e => getRoostId(e) === id) ?? null,
    openMoveModal: vi.fn(),
    onViewModeChanged: vi.fn(),
    confirmAuto: vi.fn().mockResolvedValue(undefined),
    rejectAuto: vi.fn().mockResolvedValue(undefined),
    reviewConfirm: vi.fn().mockResolvedValue(undefined),
    reviewMove: vi.fn().mockResolvedValue(undefined),
    reviewReject: vi.fn().mockResolvedValue(undefined),
    openReviewMoveModal: vi.fn(),
    ...overrides,
  };
}

describe("GalleryFeedModeController review-pass dispatch", () => {
  it("confirm calls host.reviewConfirm with the entry's proposed category", async () => {
    const entries = [makeEntry("id1", "Tech"), makeEntry("id2", "Food")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1", "id2"]);

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("confirm", "id1");

    await vi.waitFor(() => expect(host.reviewConfirm).toHaveBeenCalledWith("id1", "Tech"));
  });

  it("reject calls host.reviewReject with the frontmatter guess when no proposal is staged", async () => {
    const entries = [makeEntry("id1", "Tech"), makeEntry("id2", "Food")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1", "id2"]);

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("reject", "id1");

    await vi.waitFor(() => expect(host.reviewReject).toHaveBeenCalledWith("id1", "Tech"));
  });

  // Other-review pass: banner shows the proposal (e.g. "Media") while frontmatter is "Other".
  // Reject must record a negative for the PROPOSAL, not the frontmatter "Other".
  it("reject passes the PROPOSED category (not frontmatter 'Other') to host.reviewReject", async () => {
    const entries = [makeEntry("id1", "Other")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1"], { id1: "Media" });

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("reject", "id1");

    await vi.waitFor(() => expect(host.reviewReject).toHaveBeenCalledWith("id1", "Media"));
  });

  it("recategorize calls openReviewMoveModal (not openMoveModal)", () => {
    const entries = [makeEntry("id1", "Tech"), makeEntry("id2", "Food")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1", "id2"]);

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("recategorize", "id1");

    expect(host.openReviewMoveModal).toHaveBeenCalledOnce();
    expect(host.openMoveModal).not.toHaveBeenCalled();
  });

  it("skip does NOT call any review host method", () => {
    const entries = [makeEntry("id1", "Tech"), makeEntry("id2", "Food")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1", "id2"]);

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("skip", "id1");

    expect(host.reviewConfirm).not.toHaveBeenCalled();
    expect(host.reviewReject).not.toHaveBeenCalled();
    expect(host.reviewMove).not.toHaveBeenCalled();
  });

  it("after confirm, advanceAfterAction excludes the confirmed id (last item → null active)", async () => {
    const entries = [makeEntry("id1", "Tech")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1"]);

    // capture what setEntries is called with to verify advance
    const setEntries = vi.fn();
    (ctrl as unknown as { feedHandle: { setEntries: typeof setEntries } | null }).feedHandle = { setEntries };

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("confirm", "id1");

    await vi.waitFor(() => expect(host.reviewConfirm).toHaveBeenCalled());
    // After the async write resolves, advanceAfterAction fires: remaining = [], next = null
    await vi.waitFor(() => expect(setEntries).toHaveBeenCalledWith([], null));
  });

  it("review-pass mode does NOT call the normal confirmAuto or rejectAuto", async () => {
    const entries = [makeEntry("id1", "Tech")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1"]);

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("confirm", "id1");
    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("reject", "id1"); // inFlight guard prevents double-fire

    await vi.waitFor(() => expect(host.reviewConfirm).toHaveBeenCalled());
    expect(host.confirmAuto).not.toHaveBeenCalled();
    expect(host.rejectAuto).not.toHaveBeenCalled();
  });

  // F1: confirm uses proposalMap category, not stale frontmatter
  it("confirm uses proposed category from proposalMap when entry has NO roost_category", async () => {
    // Entry has NO roost_category (uncategorized Smart Assign item)
    const entries = [makeEntry("id1"), makeEntry("id2")]; // no category
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1", "id2"], { id1: "Tech", id2: "Food" });

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("confirm", "id1");

    await vi.waitFor(() => expect(host.reviewConfirm).toHaveBeenCalledWith("id1", "Tech"));
  });

  it("confirm uses proposed category even when entry has a DIFFERENT stale frontmatter category", async () => {
    // Entry's frontmatter says "Music" but SA proposed "Tech"
    const entries = [makeEntry("id1", "Music")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1"], { id1: "Tech" });

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("confirm", "id1");

    await vi.waitFor(() => expect(host.reviewConfirm).toHaveBeenCalledWith("id1", "Tech"));
  });

  it("confirm with no proposal AND no frontmatter logs a warning and advances (no stuck feed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = [makeEntry("id1"), makeEntry("id2")]; // no category, no proposal
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    // No proposalMap supplied
    ctrl.startReviewPass(["id1", "id2"]);

    const setEntries = vi.fn();
    (ctrl as unknown as { feedHandle: { setEntries: typeof setEntries } | null }).feedHandle = { setEntries };

    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("confirm", "id1");

    // Should NOT call reviewConfirm
    expect(host.reviewConfirm).not.toHaveBeenCalled();
    // Should warn
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[roost]"), "id1", expect.any(String));
    // Should advance (setEntries called to move to next item)
    await vi.waitFor(() => expect(setEntries).toHaveBeenCalled());
    warnSpy.mockRestore();
  });

  // F2: setTrainingMode(false) clears reviewPassIds
  it("setTrainingMode(false) clears reviewPassIds so a later setTrainingMode(true) yields filterTrainingEntries", () => {
    // Entry has auto provenance + a category (passes autoWithGuess)
    const entries = [makeEntry("id1", "Tech")]; // auto provenance
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.reviewPassIds = ["id1", "id2"]; // simulate a prior review pass
    (ctrl as unknown as { reviewProposals: Record<string, string> | null }).reviewProposals = { id1: "Tech" };

    // Turn off training mode
    ctrl.setTrainingMode(false);

    expect(ctrl.reviewPassIds).toBeNull();
    expect((ctrl as unknown as { reviewProposals: Record<string, string> | null }).reviewProposals).toBeNull();
  });

  // Fix 2: startReviewPass must reset skipped
  it("startReviewPass clears skipped set so items skipped in training still appear in the pass", () => {
    const entries = [makeEntry("id1", "Tech"), makeEntry("id2", "Food")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    // Simulate an item that was skipped during a prior training session.
    (ctrl as unknown as { skipped: Set<string> }).skipped.add("id1");

    ctrl.startReviewPass(["id1", "id2"]);

    const skipped = (ctrl as unknown as { skipped: Set<string> }).skipped;
    expect(skipped.size).toBe(0);
    // trainingEntries() via computeReviewPassEntries now includes id1.
    const reviewEntries = (ctrl as unknown as { trainingEntries: () => BasesEntry[] }).trainingEntries();
    expect(reviewEntries.map(e => getRoostId(e))).toEqual(["id1", "id2"]);
  });

  // Fix 4: recategorize cancel must not strand the item
  it("recategorize-cancel (callback never invoked) leaves item NOT in skipped and still in the queue", () => {
    const entries = [makeEntry("id1", "Tech"), makeEntry("id2", "Food")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true;
    ctrl.startReviewPass(["id1", "id2"]);

    // Trigger recategorize — openReviewMoveModal is a stub; callback is captured but never called.
    (ctrl as unknown as { handleTrainingAction: (a: string, id: string) => void })
      .handleTrainingAction("recategorize", "id1");

    expect(host.openReviewMoveModal).toHaveBeenCalledOnce();
    // id1 must NOT be in skipped — cancel leaves it un-judged.
    const skipped = (ctrl as unknown as { skipped: Set<string> }).skipped;
    expect(skipped.has("id1")).toBe(false);
    // id1 still appears in the review queue.
    const remaining = (ctrl as unknown as { trainingEntries: () => BasesEntry[] }).trainingEntries();
    expect(remaining.map(e => getRoostId(e))).toContain("id1");
  });

  it("setTrainingMode(true) re-opens the feed when trainingMode is already on but the feed is closed", () => {
    // Regression: exiting the feed via the view-mode toggle leaves trainingMode=true.
    // Clicking "Review Pass" then hit the early-return in setTrainingMode and the
    // feed silently never opened.
    const entries = [makeEntry("id1", "Tech")];
    const host = makeTestHost(entries);
    const ctrl = new GalleryFeedModeController(host);
    ctrl.trainingMode = true; // stale: training on, feed closed (viewMode "grid")
    const setViewMode = vi.fn();
    (ctrl as unknown as { setViewMode: (m: string) => void }).setViewMode = setViewMode;

    ctrl.setTrainingMode(true);

    expect(setViewMode).toHaveBeenCalledWith("feed");
  });
});
