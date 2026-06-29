import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureEdit, processSnapshotChange } from "@/pipeline/organic-capture";
import { emptyTrainingSet, rejectedClasses } from "@/pipeline/training-set";
import type { Vault } from "obsidian";

// ── Mocks for processSnapshotChange disk I/O ──────────────────────────────────
// vi.mock is hoisted before imports; all importers of these modules (including
// organic-capture.ts) will see the mocked versions.
vi.mock("@/pipeline/category-snapshot", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/pipeline/category-snapshot")>();
  return { ...real, loadSnapshot: vi.fn(), saveSnapshot: vi.fn() };
});

vi.mock("@/pipeline/training-set", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/pipeline/training-set")>();
  return { ...real, loadTrainingSet: vi.fn(), saveTrainingSet: vi.fn() };
});

import { loadSnapshot, saveSnapshot } from "@/pipeline/category-snapshot";
import { loadTrainingSet, saveTrainingSet } from "@/pipeline/training-set";

describe("captureEdit (own-write guard + capture)", () => {
  it("ignores a write that matches the snapshot (our own write / echo)", () => {
    const r = captureEdit({ snapshot: { a: "Tech" }, ts: emptyTrainingSet(), id: "a", newCategory: "Tech", now: 1 });
    expect(r.changed).toBe(false);
    expect(r.ts.positives["a"]).toBeUndefined();
  });
  it("captures a correction that differs from the snapshot and updates the snapshot", () => {
    const r = captureEdit({ snapshot: { a: "Tech" }, ts: emptyTrainingSet(), id: "a", newCategory: "Food", now: 5 });
    expect(r.changed).toBe(true);
    expect(r.ts.positives["a"]).toEqual({ category: "Food", ts: 5 });
    expect(r.snapshot["a"]).toBe("Food");
  });
  it("captures a clear as a rejection", () => {
    const r = captureEdit({ snapshot: { a: "Tech" }, ts: emptyTrainingSet(), id: "a", newCategory: null, now: 5 });
    expect(r.changed).toBe(true);
    expect(rejectedClasses(r.ts, "a").has("Tech")).toBe(true);
    expect(r.snapshot["a"]).toBe(null);
  });
});

describe("processSnapshotChange (timing-independent own-write guard)", () => {
  const fakeVault = {} as Vault;

  beforeEach(() => {
    vi.mocked(loadTrainingSet).mockReturnValue(emptyTrainingSet());
    vi.mocked(saveTrainingSet).mockReset();
    vi.mocked(saveSnapshot).mockReset();
  });

  it("returns false and skips saveTrainingSet when value matches on-disk snapshot (cross-write safety)", () => {
    // Simulates confirm.ts having written "Tech" to the disk snapshot, then the
    // metadataCache "changed" event firing with the same value (possibly after
    // bulkWriteInProgress has already cleared). The fresh disk read must prevent capture.
    vi.mocked(loadSnapshot).mockReturnValue({ "id-1": "Tech" });

    const captured = processSnapshotChange(fakeVault, "id-1", "Tech");

    expect(captured).toBe(false);
    expect(saveTrainingSet).not.toHaveBeenCalled();
    // saveSnapshot is still called to keep the snapshot file up-to-date (no-change path).
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns true and persists positive when value differs from on-disk snapshot", () => {
    vi.mocked(loadSnapshot).mockReturnValue({ "id-1": "Tech" });

    const captured = processSnapshotChange(fakeVault, "id-1", "Food");

    expect(captured).toBe(true);
    expect(saveTrainingSet).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    // Verify the snapshot written to disk reflects the new category.
    const writtenSnap = vi.mocked(saveSnapshot).mock.calls[0][1] as Record<string, string | null>;
    expect(writtenSnap["id-1"]).toBe("Food");
  });
});
