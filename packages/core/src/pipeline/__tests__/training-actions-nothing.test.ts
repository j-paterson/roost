import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyTrainingSet, isBelongsNothing } from "@/pipeline/training-set";
import type { TFile } from "obsidian";

// Mock the vault-backed I/O so we can assert on what was written without touching the FS.
vi.mock("@/pipeline/training-set", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/training-set")>();
  return {
    ...actual,
    loadTrainingSet: vi.fn(() => actual.emptyTrainingSet()),
    saveTrainingSet: vi.fn(),
  };
});
vi.mock("@/pipeline/category-snapshot", () => ({
  loadSnapshot: vi.fn(() => ({})),
  saveSnapshot: vi.fn(),
}));
vi.mock("@/pipeline/eval-log", () => ({
  appendEvalRecords: vi.fn(),
}));

describe("markBelongsNothingItem", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks belongs-nothing in the training set and writes roost_belongs_nothing to frontmatter", async () => {
    const { markBelongsNothingItem } = await import("@/pipeline/training-actions");
    const { loadTrainingSet, saveTrainingSet } = await import("@/pipeline/training-set");

    const ts = emptyTrainingSet();
    vi.mocked(loadTrainingSet).mockReturnValueOnce(ts);

    let capturedPatch: Record<string, unknown> = {};
    const fileManager = {
      processFrontMatter: vi.fn((_file: TFile, fn: (fm: Record<string, unknown>) => void) => {
        fn(capturedPatch);
        return Promise.resolve();
      }),
    };
    const vault = {} as Parameters<typeof markBelongsNothingItem>[0]["vault"];
    const file = {} as TFile;

    await markBelongsNothingItem({
      vault,
      fileManager: fileManager as unknown as Parameters<typeof markBelongsNothingItem>[0]["fileManager"],
      file,
      id: "id-x",
      now: 1000,
    });

    // Training-set was saved with isBelongsNothing true for "id-x"
    expect(saveTrainingSet).toHaveBeenCalledOnce();
    const savedTs = vi.mocked(saveTrainingSet).mock.calls[0][1];
    expect(isBelongsNothing(savedTs, "id-x")).toBe(true);

    // Frontmatter patch stamps roost_belongs_nothing: true
    expect(capturedPatch["roost_belongs_nothing"]).toBe(true);
    expect(capturedPatch["roost_assigned_by"]).toBe("human");
  });
});
