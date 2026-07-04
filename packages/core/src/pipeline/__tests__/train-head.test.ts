import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectTrainingPositives, buildTrainingRows } from "@/pipeline/train-head";
import type { TrainingSet } from "@/pipeline/training-set";

// ── Mock vault-I/O dependencies so buildTrainingRows can be unit-tested ──────
vi.mock("@/pipeline/training-set", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/training-set")>();
  return { ...actual, loadTrainingSet: vi.fn() };
});
vi.mock("@/pipeline/shared", () => ({
  loadEmbeddingCache: vi.fn(),
}));

import { loadTrainingSet } from "@/pipeline/training-set";
import { loadEmbeddingCache } from "@/pipeline/shared";

const P = (category: string, ts: number, source?: "correction" | "confirm") => ({ category, ts, source });

describe("selectTrainingPositives", () => {
  it("admits all correction positives, uncapped", () => {
    const positives = { a: P("Tech", 1), b: P("Tech", 2), c: P("Tech", 3) };
    const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("caps confirms at ratio × corrections per class", () => {
    // Tech: 1 correction → cap = 2 confirms admitted out of 4
    const positives = {
      k: P("Tech", 1, "correction"),
      a: P("Tech", 2, "confirm"), b: P("Tech", 3, "confirm"),
      c: P("Tech", 4, "confirm"), d: P("Tech", 5, "confirm"),
    };
    const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
    const confirms = out.filter((r) => r.id !== "k");
    expect(out.some((r) => r.id === "k")).toBe(true); // correction always admitted
    expect(confirms.length).toBe(2);                  // 2.0 × 1 correction
    // earliest-ts confirms admitted (sort-direction-sensitive: c,d have later ts)
    expect(confirms.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("a class with 0 corrections admits 0 confirms (cannot build a class alone)", () => {
    const positives = { a: P("Art", 1, "confirm"), b: P("Art", 2, "confirm") };
    const out = selectTrainingPositives(positives, new Set(["Art"]), 2.0);
    expect(out).toEqual([]);
  });

  it("excludes positives whose category is not eligible", () => {
    const positives = { a: P("Tech", 1, "correction"), b: P("Rare", 2, "correction") };
    const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("buildTrainingRows — reserved category exclusion", () => {
  const mockVault = {} as import("obsidian").Vault;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("excludes rows for 'Other' even when it has enough positives to be eligible", () => {
    // TrainingSet with 6 positives in 'Other' (≥ TRAIN_ELIGIBILITY_MIN=5) and 5 in 'Tech'
    const ts: TrainingSet = {
      version: 1,
      positives: {
        o1: { category: "Other", ts: 1 },
        o2: { category: "Other", ts: 2 },
        o3: { category: "Other", ts: 3 },
        o4: { category: "Other", ts: 4 },
        o5: { category: "Other", ts: 5 },
        o6: { category: "Other", ts: 6 },
        t1: { category: "Tech", ts: 7 },
        t2: { category: "Tech", ts: 8 },
        t3: { category: "Tech", ts: 9 },
        t4: { category: "Tech", ts: 10 },
        t5: { category: "Tech", ts: 11 },
      },
      rejections: {},
    };
    vi.mocked(loadTrainingSet).mockReturnValue(ts);
    const vec = [1, 0, 0];
    vi.mocked(loadEmbeddingCache).mockReturnValue({
      o1: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o2: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o3: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o4: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o5: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o6: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      t1: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      t2: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      t3: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      t4: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      t5: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
    } as any);

    const rows = buildTrainingRows(mockVault);
    expect(rows.some((r) => r.category === "Other")).toBe(false);
    expect(rows.some((r) => r.category === "Tech")).toBe(true);
  });

  it("excludes 'other' case-insensitively (lowercase variant)", () => {
    const ts: TrainingSet = {
      version: 1,
      positives: {
        o1: { category: "other", ts: 1 },
        o2: { category: "other", ts: 2 },
        o3: { category: "other", ts: 3 },
        o4: { category: "other", ts: 4 },
        o5: { category: "other", ts: 5 },
      },
      rejections: {},
    };
    vi.mocked(loadTrainingSet).mockReturnValue(ts);
    const vec = [1, 0, 0];
    vi.mocked(loadEmbeddingCache).mockReturnValue({
      o1: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o2: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o3: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o4: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
      o5: { vec, vecText: vec, vision: null, summary: null, category: null, clipVec: null },
    } as any);

    const rows = buildTrainingRows(mockVault);
    expect(rows).toHaveLength(0);
  });
});

