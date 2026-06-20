/**
 * Unit tests for pipeline/uncensored-augment.ts — augmentUncensoredAssignments.
 *
 * Tests:
 *   1. No-op when uncensoredCategories is empty (no classifyUncensoredImage call).
 *   2. Adds the tag when image score fires (imageScore >= 0.5), text did not.
 *   3. Leaves tag set unchanged when neither image nor text fires.
 *   4. Skips processing (no image call) when uncensoredCategories is empty.
 *   5. Does not duplicate a tag already present in ta.tags.
 *   6. Handles multiple uncensored categories independently.
 *   7. Skips item when it has no TagAssignment in the map.
 *   8. Skips item when fileIndex has no file for that id (imagePaths=[]).
 *   9. No sidecar call when imageScore=0 (classifyUncensoredImage returns 0 for empty paths).
 *  10. Category not in detector tags is silently skipped.
 *  11. Both image and text fire → tag added (OR logic).
 *  12. Text fires alone (above textThr) but text already fired in scoreWithTagDetectors
 *      → tag already in ta.tags → no duplicate added.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TagAssignment } from "@/pipeline/evaluate";
import type { TagDetectors } from "@/pipeline/tag-detectors";
import type { EmbeddingCacheEntry } from "@/types/roost";
import { augmentUncensoredAssignments, type AugmentUncensoredOpts } from "@/pipeline/uncensored-augment";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// We mock the three external functions that have side-effects/I/O.
vi.mock("@/pipeline/uncensored-image-detector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/uncensored-image-detector")>();
  return {
    ...actual,
    // classifyUncensoredImage is replaced per-test via getClassifyUncensoredImageMock helper
    classifyUncensoredImage: vi.fn(async (_paths: string[]) => 0),
    // resolveAttachmentImagePaths: return ["fake-path"] when file is found (non-empty),
    // simulated by returning paths based on the note's roostId.
    resolveAttachmentImagePaths: vi.fn((_note: unknown) => {
      const note = _note as { roostId: string };
      // Return a fake path to simulate an existing image; the real fs check is mocked out.
      return [`/vault/${note.roostId}/cover.jpg`];
    }),
  };
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Minimal TagDetectors fixture with two tags:
 *   "Spicy"  — W=[1,0], b=0, threshold=0.4
 *   "Sports" — W=[0,1], b=0, threshold=0.5
 *
 * For embedding [3,4] (norm=5, x_norm=[0.6,0.8]):
 *   z_Spicy  = 1*0.6 + 0*0.8 + 0 = 0.6   → sigmoid ≈ 0.6457  ≥ 0.4  → FIRES
 *   z_Sports = 0*0.6 + 1*0.8 + 0 = 0.8   → sigmoid ≈ 0.6900  ≥ 0.5  → FIRES
 *
 * For embedding [0,1] (already normalised):
 *   z_Spicy  = 0   → sigmoid = 0.5  ≥ 0.4  → FIRES
 *   z_Sports = 1   → sigmoid ≈ 0.731 ≥ 0.5 → FIRES
 *
 * For embedding [1,0] (already normalised):
 *   z_Spicy  = 1   → sigmoid ≈ 0.731 ≥ 0.4 → FIRES
 *   z_Sports = 0   → sigmoid = 0.5  ≥ 0.5  → exactly at threshold → FIRES
 *
 * We use threshold=0.8 for Sports in some tests so it doesn't fire on text.
 */
function makeDet(sportsThreshold = 0.5): TagDetectors {
  return {
    tags: ["Spicy", "Sports"],
    W: [
      [1, 0], // Spicy
      [0, 1], // Sports
    ],
    b: [0, 0],
    thresholds: [0.4, sportsThreshold],
    dim: 2,
  };
}

function makeEmbeddingCache(id: string, vec: number[]): Record<string, EmbeddingCacheEntry> {
  return {
    [id]: { vec, vision: null, summary: null, category: null },
  };
}

function makeTFile(path: string): import("obsidian").TFile {
  return { path } as unknown as import("obsidian").TFile;
}

function makeMetadataCache(files: Map<string, Record<string, unknown>>): import("obsidian").MetadataCache {
  return {
    getFileCache: (file: import("obsidian").TFile) => {
      const fm = files.get((file as { path: string }).path);
      return fm ? { frontmatter: fm } : null;
    },
  } as unknown as import("obsidian").MetadataCache;
}

function makeOpts(overrides: Partial<AugmentUncensoredOpts> = {}): AugmentUncensoredOpts {
  const fileIndex = new Map<string, import("obsidian").TFile>([
    ["tiktok:001", makeTFile("Bookmarks/TikTok/note1.md")],
  ]);
  const metadataCache = makeMetadataCache(new Map([
    ["Bookmarks/TikTok/note1.md", { cover: "[[Bookmarks/TikTok/tiktok-001/cover.jpg]]" }],
  ]));
  return {
    uncensoredCategories: ["Spicy"],
    det: makeDet(),
    vaultPath: "/vault",
    embeddingCache: makeEmbeddingCache("tiktok:001", [1, 0]),
    fileIndex,
    metadataCache,
    ...overrides,
  };
}

// Helper: get the mocked classifyUncensoredImage function
async function getClassifyUncensoredImageMock() {
  const mod = await import("@/pipeline/uncensored-image-detector");
  return mod.classifyUncensoredImage as ReturnType<typeof vi.fn>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("augmentUncensoredAssignments", () => {
  beforeEach(async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockReset();
    mock.mockResolvedValue(0); // default: sidecar returns 0
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. No-op when uncensoredCategories=[] ────────────────────────────────────
  it("is a no-op when uncensoredCategories is empty — no classifyUncensoredImage call", async () => {
    const mock = await getClassifyUncensoredImageMock();
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: ["Sports"], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(assignments, ["tiktok:001"], makeOpts({ uncensoredCategories: [] }));

    expect(mock).not.toHaveBeenCalled();
    // Tags unchanged
    expect(assignments.get("tiktok:001")!.tags).toEqual(["Sports"]);
  });

  // ── 2. Adds tag when image fires, text did not ───────────────────────────────
  it("adds the uncensored category tag when image score fires even if text score did not fire", async () => {
    const mock = await getClassifyUncensoredImageMock();
    // Image score = 0.7 (>= 0.5 threshold) → ensemble fires
    mock.mockResolvedValue(0.7);

    // embedding [0, 1]: Spicy sigmoid ≈ 0.5 which IS >= threshold 0.4 (text FIRES)
    // Use Sports threshold=0.8 to ensure it doesn't fire on text
    const det = makeDet(0.8);
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({
        uncensoredCategories: ["Sports"],
        det,
        embeddingCache: makeEmbeddingCache("tiktok:001", [0, 0.01]), // very low Sports sigmoid
      }),
    );

    // image=0.7 >= 0.5 → ensemble fires → Sports tag added
    expect(assignments.get("tiktok:001")!.tags).toContain("Sports");
  });

  // ── 3. Leaves set unchanged when neither fires ───────────────────────────────
  it("leaves tag set unchanged when neither image nor text fires", async () => {
    const mock = await getClassifyUncensoredImageMock();
    // Image score = 0 → ensemble can only fire from text (but text threshold=0.4,
    // and our embedding yields sigmoid≈0.5 for Spicy — still >= 0.4 — so we use
    // a high-threshold detector here)
    mock.mockResolvedValue(0);

    const det: TagDetectors = {
      ...makeDet(),
      thresholds: [0.99, 0.99], // neither fires
    };
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["Spicy"], det }),
    );

    // imageScore=0 → skip (no ensemble call needed), tags unchanged
    expect(assignments.get("tiktok:001")!.tags).toEqual([]);
    expect(mock).toHaveBeenCalled(); // call made (paths non-empty from mock)
  });

  // ── 4. No sidecar call when uncensoredCategories=[] ──────────────────────────
  it("makes zero calls to the image sidecar when uncensoredCategories is empty", async () => {
    const mock = await getClassifyUncensoredImageMock();
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Spicy", tags: ["Spicy"], canonTags: ["Spicy"] }],
    ]);

    await augmentUncensoredAssignments(assignments, ["tiktok:001"], makeOpts({ uncensoredCategories: [] }));

    expect(mock).not.toHaveBeenCalled();
  });

  // ── 5. Does not duplicate a tag already in ta.tags ───────────────────────────
  it("does not duplicate a tag that is already in ta.tags", async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockResolvedValue(0.9); // image fires

    const assignments = new Map<string, TagAssignment>([
      // "Spicy" already in tags
      ["tiktok:001", { primary: "Spicy", tags: ["Spicy"], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["Spicy"] }),
    );

    // No duplicate — still one "Spicy"
    const tags = assignments.get("tiktok:001")!.tags;
    expect(tags.filter(t => t === "Spicy")).toHaveLength(1);
  });

  // ── 6. Multiple uncensored categories handled independently ──────────────────
  it("handles multiple uncensored categories independently", async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockResolvedValue(0.8); // image fires

    // High threshold so text doesn't fire for either category
    const det: TagDetectors = { ...makeDet(), thresholds: [0.99, 0.99] };
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["Spicy", "Sports"], det }),
    );

    // image=0.8 >= 0.5 → ensemble fires for both
    const tags = assignments.get("tiktok:001")!.tags;
    expect(tags).toContain("Spicy");
    expect(tags).toContain("Sports");
  });

  // ── 7. Skips item with no TagAssignment ──────────────────────────────────────
  it("skips an item that has no TagAssignment in the map", async () => {
    const mock = await getClassifyUncensoredImageMock();
    const assignments = new Map<string, TagAssignment>();

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["Spicy"] }),
    );

    // No assignment to mutate, no sidecar call needed
    expect(assignments.size).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });

  // ── 8. Handles missing file gracefully (empty imagePaths → imageScore=0) ─────
  it("gracefully handles missing file in fileIndex (empty image paths)", async () => {
    const mock = await getClassifyUncensoredImageMock();

    const { resolveAttachmentImagePaths: resolveAttachMock } = await import(
      "@/pipeline/uncensored-image-detector"
    );
    (resolveAttachMock as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
    // classifyUncensoredImage([]) returns 0 (no sidecar call for empty array in real impl,
    // but our mock still tracks the call — in the real impl it short-circuits)
    mock.mockResolvedValue(0);

    const assignments = new Map<string, TagAssignment>([
      ["tiktok:999", { primary: "Spicy", tags: [], canonTags: ["Spicy"] }],
    ]);
    const fileIndex = new Map<string, import("obsidian").TFile>(); // empty
    const metadataCache = makeMetadataCache(new Map());

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:999"],
      makeOpts({ uncensoredCategories: ["Spicy"], fileIndex, metadataCache,
        embeddingCache: makeEmbeddingCache("tiktok:999", [1, 0]) }),
    );

    // imageScore=0 → no tag added
    expect(assignments.get("tiktok:999")!.tags).toEqual([]);
  });

  // ── 9. Category not in detector tags is silently skipped ─────────────────────
  it("silently skips uncensored categories not in the detector tag list", async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockResolvedValue(0.9);

    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["UnknownCategory"] }),
    );

    // "UnknownCategory" not in det.tags → no tag added, no crash
    expect(assignments.get("tiktok:001")!.tags).toEqual([]);
    // No image call made because all known uncensored cats were filtered out
    expect(mock).not.toHaveBeenCalled();
  });

  // ── 10. OR logic: image fires alone → adds tag ───────────────────────────────
  it("OR logic: image fires (>= 0.5), text below threshold → tag added", async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockResolvedValue(0.6);

    // Sports threshold = 0.99 so text doesn't fire
    const det: TagDetectors = { ...makeDet(), thresholds: [0.99, 0.99] };
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["Spicy"], det }),
    );

    expect(assignments.get("tiktok:001")!.tags).toContain("Spicy");
  });

  // ── 11. OR logic: neither fires → nothing added ──────────────────────────────
  it("OR logic: image below 0.5, text below textThr → tag NOT added", async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockResolvedValue(0.3); // below 0.5 image threshold

    // Spicy threshold = 0.99 → text doesn't fire either
    const det: TagDetectors = { ...makeDet(), thresholds: [0.99, 0.5] };
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({ uncensoredCategories: ["Spicy"], det }),
    );

    // image=0.3 < 0.5, text sigmoid < 0.99 → no tag added
    expect(assignments.get("tiktok:001")!.tags).toEqual([]);
  });

  // ── 12. imageScore > 0 but < imgThr, text fires → tag added ──────────────────
  it("text fires alone (image below imgThr) → tag added", async () => {
    const mock = await getClassifyUncensoredImageMock();
    mock.mockResolvedValue(0.3); // below 0.5 image threshold

    // Use embedding [1, 0]: Spicy sigmoid ≈ 0.731 >= threshold 0.4 → text fires
    const det = makeDet();
    const assignments = new Map<string, TagAssignment>([
      ["tiktok:001", { primary: "Sports", tags: [], canonTags: ["Spicy", "Sports"] }],
    ]);

    await augmentUncensoredAssignments(
      assignments,
      ["tiktok:001"],
      makeOpts({
        uncensoredCategories: ["Spicy"],
        det,
        embeddingCache: makeEmbeddingCache("tiktok:001", [1, 0]),
      }),
    );

    // image=0.3 < 0.5, but text score ≈ 0.731 >= 0.4 → ensemble fires → tag added
    expect(assignments.get("tiktok:001")!.tags).toContain("Spicy");
  });
});
