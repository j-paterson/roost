/**
 * Contract test for the stacked-heads JSON output emitted by
 * scripts/train-stacked-heads.py.
 *
 * This test pins the EXACT JSON shape that the Python trainer must produce.
 * Three hand-authored fixture JSONs (2 classes, base dim 2, meta inDim 4)
 * are written to a temp dir and fed through the TS loaders.
 *
 * The real end-to-end training run (against embedding-vectors-text.bin +
 * embedding-vectors.bin) is deferred to Task 7 once the text-only backfill
 * has produced embedding-vectors-text.bin.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileSystemAdapter } from "obsidian";
import {
  loadStackedHeads,
  stackedHeadsClassesMatch,
  classifyStacked,
} from "@/pipeline/classifier-head";

// ── Fixture definitions (must exactly mirror train-stacked-heads.py output) ──

/**
 * classifier-head-text.json (ClassifierHeadData shape):
 *   { classes, W (C×dim), b (C), dim, norm:"l2", trainedOn, version:1 }
 */
const FIXTURE_HEAD_TEXT = {
  version: 1 as const,
  classes: ["A", "B"],
  W: [
    [1.0, 0.0],  // class A weights
    [0.0, 1.0],  // class B weights
  ],
  b: [0.0, 0.0],
  dim: 2,
  norm: "l2" as const,
  trainedOn: 100,
};

/**
 * classifier-head-vision.json (ClassifierHeadData shape — same as text head).
 * In production this is trained on vision-on embeddings; here it's a mirror.
 */
const FIXTURE_HEAD_VISION = {
  version: 1 as const,
  classes: ["A", "B"],
  W: [
    [1.0, 0.0],
    [0.0, 1.0],
  ],
  b: [0.0, 0.0],
  dim: 2,
  norm: "l2" as const,
  trainedOn: 100,
};

/**
 * meta-head.json:
 *   { classes, W (C×2C), b (C), inDim:(2*C), norm:"none", version:1 }
 *
 * Feature order: [...p_text(C), ...p_vision(C)]  — first text, then vision.
 * The Python trainer concatenates OOF softmax probabilities as:
 *   feat = np.hstack([P_text_oof, P_vision_oof])
 * and the TS classifyStacked forward pass mirrors:
 *   feat = [...pText, ...pVision]
 *
 * This meta weights both the text-A slot (index 0) and vision-A slot (index 2)
 * to pick class A when both base heads agree on A.
 */
const FIXTURE_META = {
  version: 1 as const,
  classes: ["A", "B"],
  W: [
    [5.0, 0.0, 5.0, 0.0],  // class A: weights on p_text[A] and p_vision[A]
    [0.0, 5.0, 0.0, 5.0],  // class B: weights on p_text[B] and p_vision[B]
  ],
  b: [0.0, 0.0],
  inDim: 4,  // 2 * C = 2 * 2
  norm: "none" as const,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVault(root: string): import("obsidian").Vault {
  const adapter = new FileSystemAdapter();
  (adapter as unknown as { basePath: string }).basePath = root;
  return { adapter } as unknown as import("obsidian").Vault;
}

function writeCacheFile(tmpDir: string, name: string, data: unknown): void {
  const cacheDir = path.join(tmpDir, ".roost", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, name), JSON.stringify(data));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stacked-roundtrip: loadStackedHeads accepts Python-emitted fixture JSONs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-stacked-roundtrip-"));
    writeCacheFile(tmpDir, "classifier-head-text.json", FIXTURE_HEAD_TEXT);
    writeCacheFile(tmpDir, "classifier-head-vision.json", FIXTURE_HEAD_VISION);
    writeCacheFile(tmpDir, "meta-head.json", FIXTURE_META);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadStackedHeads returns non-null for well-formed fixture files", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault);
    expect(heads).not.toBeNull();
  });

  it("loaded heads expose correct class lists for all three heads", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    expect(heads.text.classes).toEqual(["A", "B"]);
    expect(heads.vision.classes).toEqual(["A", "B"]);
    expect(heads.meta.classes).toEqual(["A", "B"]);
  });

  it("loaded meta has correct inDim = 2 * C", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    expect(heads.meta.inDim).toBe(4); // 2 * 2 classes
  });

  it("stackedHeadsClassesMatch returns true for matching class list", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    expect(stackedHeadsClassesMatch(heads, ["A", "B"])).toBe(true);
  });

  it("stackedHeadsClassesMatch returns true regardless of live-list order", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    expect(stackedHeadsClassesMatch(heads, ["B", "A"])).toBe(true);
  });

  it("stackedHeadsClassesMatch returns false for mismatched live classes", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    expect(stackedHeadsClassesMatch(heads, ["A", "B", "C"])).toBe(false);
  });

  it("classifyStacked returns a valid category from meta.classes", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    const result = classifyStacked([1, 0], [1, 0], heads);
    expect(heads.meta.classes).toContain(result.category);
  });

  it("classifyStacked picks class A when both embeddings point to A", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    const result = classifyStacked([1, 0], [1, 0], heads);
    expect(result.category).toBe("A");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifyStacked picks class B when both embeddings point to B", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    const result = classifyStacked([0, 1], [0, 1], heads);
    expect(result.category).toBe("B");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("confidence is always in [0, 1]", () => {
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    const result = classifyStacked([1, 0], [1, 0], heads);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("meta feature order is [text, vision] — text weights in slots 0..C-1, vision in slots C..2C-1", () => {
    // Use a meta that ONLY weights the text slots (indices 0,1) and zeroes out vision.
    // text says A ([1,0]), vision says B ([0,1]).
    // If feat order were [...pVision, ...pText] the meta would see vision-A=~0 in
    // the text slot and pick B. The correct [text,vision] order picks A.
    const textOnlyMeta = {
      ...FIXTURE_META,
      W: [
        [10.0, 0.0, 0.0, 0.0], // weight only p_text[A] (slot 0)
        [0.0, 10.0, 0.0, 0.0], // weight only p_text[B] (slot 1)
      ],
    };
    writeCacheFile(tmpDir, "meta-head.json", textOnlyMeta);
    const vault = makeVault(tmpDir);
    const heads = loadStackedHeads(vault)!;
    const result = classifyStacked([1, 0], [0, 1], heads);
    // text → A is in slot 0; if order were swapped, vision-B would be in slot 0 → picks B
    expect(result.category).toBe("A");
  });
});

describe("stacked-roundtrip: contract shape validation (loader rejects malformed files)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-stacked-contract-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when meta-head.json has an unsupported version", () => {
    writeCacheFile(tmpDir, "classifier-head-text.json", FIXTURE_HEAD_TEXT);
    writeCacheFile(tmpDir, "classifier-head-vision.json", FIXTURE_HEAD_VISION);
    writeCacheFile(tmpDir, "meta-head.json", { ...FIXTURE_META, version: 2 });
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when meta inDim does not equal 2 * classes.length", () => {
    writeCacheFile(tmpDir, "classifier-head-text.json", FIXTURE_HEAD_TEXT);
    writeCacheFile(tmpDir, "classifier-head-vision.json", FIXTURE_HEAD_VISION);
    writeCacheFile(tmpDir, "meta-head.json", { ...FIXTURE_META, inDim: 5 });
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when base head has wrong version", () => {
    writeCacheFile(tmpDir, "classifier-head-text.json", { ...FIXTURE_HEAD_TEXT, version: 2 });
    writeCacheFile(tmpDir, "classifier-head-vision.json", FIXTURE_HEAD_VISION);
    writeCacheFile(tmpDir, "meta-head.json", FIXTURE_META);
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });
});
