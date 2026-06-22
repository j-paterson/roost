/**
 * Unit tests for the stacked forward pass: softmaxProba, classifyStacked,
 * loadStackedHeads, and stackedHeadsClassesMatch.
 *
 * These tests are pure in-memory (no file I/O) except the loadStackedHeads suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileSystemAdapter } from "obsidian";
import {
  classifyStacked,
  softmaxProba,
  loadStackedHeads,
  stackedHeadsClassesMatch,
  type StackedHeads,
  type ClassifierHead,
} from "@/pipeline/classifier-head";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HEAD: ClassifierHead = { classes: ["A", "B"], W: [[1, 0], [0, 1]], b: [0, 0], dim: 2 };
const META = { classes: ["A", "B"], W: [[5, 0, 5, 0], [0, 5, 0, 5]], b: [0, 0], inDim: 4 };
const HEADS: StackedHeads = { text: HEAD, vision: HEAD, meta: META };

// ── softmaxProba ──────────────────────────────────────────────────────────────

describe("softmaxProba", () => {
  it("returns a normalized C-length vector", () => {
    const p = softmaxProba([1, 0], HEAD);
    expect(p).toHaveLength(2);
    expect(p[0] + p[1]).toBeCloseTo(1, 6);
    expect(p[0]).toBeGreaterThan(p[1]);
  });

  it("probabilities sum to 1 on a 3-class head", () => {
    const head3: ClassifierHead = {
      classes: ["A", "B", "C"],
      W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      b: [0, 2, 0],
      dim: 3,
    };
    const p = softmaxProba([1, 0, 0], head3);
    expect(p).toHaveLength(3);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("all values are in [0, 1]", () => {
    const p = softmaxProba([3, 4], HEAD);
    for (const v of p) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ── classifyStacked ───────────────────────────────────────────────────────────

describe("classifyStacked", () => {
  it("combines both heads through the meta — both pointing at class A picks A", () => {
    // both heads point at class A → meta (which weights both p_A dims) picks A
    const r = classifyStacked([1, 0], [1, 0], HEADS);
    expect(r.category).toBe("A");
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("disagreement is resolved by the meta weights", () => {
    // text says A, vision says B; symmetric meta → near-tie, deterministic argmax
    const r = classifyStacked([1, 0], [0, 1], HEADS);
    expect(["A", "B"]).toContain(r.category);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("both pointing at class B picks B", () => {
    const r = classifyStacked([0, 1], [0, 1], HEADS);
    expect(r.category).toBe("B");
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("confidence is in [0, 1]", () => {
    const r = classifyStacked([1, 0], [1, 0], HEADS);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("returns a valid category name from meta.classes", () => {
    const r = classifyStacked([1, 0], [0, 1], HEADS);
    expect(HEADS.meta.classes).toContain(r.category);
  });
});

// ── stackedHeadsClassesMatch ──────────────────────────────────────────────────

describe("stackedHeadsClassesMatch", () => {
  it("returns true when all three heads agree and match the live categories", () => {
    expect(stackedHeadsClassesMatch(HEADS, ["A", "B"])).toBe(true);
  });

  it("returns true regardless of order in the live category list", () => {
    expect(stackedHeadsClassesMatch(HEADS, ["B", "A"])).toBe(true);
  });

  it("returns false when live categories have an extra class", () => {
    expect(stackedHeadsClassesMatch(HEADS, ["A", "B", "C"])).toBe(false);
  });

  it("returns false when live categories are missing a class", () => {
    expect(stackedHeadsClassesMatch(HEADS, ["A"])).toBe(false);
  });
});

// ── loadStackedHeads ──────────────────────────────────────────────────────────

describe("loadStackedHeads", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-stacked-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeVault(root: string): import("obsidian").Vault {
    const adapter = new FileSystemAdapter();
    (adapter as unknown as { basePath: string }).basePath = root;
    return { adapter } as unknown as import("obsidian").Vault;
  }

  function writeCacheFile(name: string, data: unknown): void {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, name), JSON.stringify(data));
  }

  const GOOD_HEAD_TEXT = {
    version: 1,
    classes: ["A", "B"],
    W: [[1, 0], [0, 1]],
    b: [0, 0],
    dim: 2,
    norm: "l2",
    trainedOn: 50,
  };

  const GOOD_HEAD_VISION = {
    version: 1,
    classes: ["A", "B"],
    W: [[1, 0], [0, 1]],
    b: [0, 0],
    dim: 2,
    norm: "l2",
    trainedOn: 50,
  };

  const GOOD_META = {
    version: 1,
    classes: ["A", "B"],
    W: [[5, 0, 5, 0], [0, 5, 0, 5]],
    b: [0, 0],
    inDim: 4,
    norm: "none",
  };

  it("returns null when all three files are absent", () => {
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when classifier-head-text.json is missing", () => {
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    writeCacheFile("meta-head.json", GOOD_META);
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when classifier-head-vision.json is missing", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("meta-head.json", GOOD_META);
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when meta-head.json is missing", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when meta-head.json has wrong version", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    writeCacheFile("meta-head.json", { ...GOOD_META, version: 2 });
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when meta-head.json inDim !== 2*classes.length", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    writeCacheFile("meta-head.json", { ...GOOD_META, inDim: 5 });
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when a meta W row length mismatches inDim", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    writeCacheFile("meta-head.json", {
      ...GOOD_META,
      W: [[5, 0, 5], [0, 5, 0, 5]], // first row is too short
    });
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns null when meta W.length !== classes.length", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    writeCacheFile("meta-head.json", {
      ...GOOD_META,
      W: [[5, 0, 5, 0]], // only 1 row for 2 classes
    });
    const vault = makeVault(tmpDir);
    expect(loadStackedHeads(vault)).toBeNull();
  });

  it("returns a valid StackedHeads when all files are well-formed", () => {
    writeCacheFile("classifier-head-text.json", GOOD_HEAD_TEXT);
    writeCacheFile("classifier-head-vision.json", GOOD_HEAD_VISION);
    writeCacheFile("meta-head.json", GOOD_META);
    const vault = makeVault(tmpDir);
    const result = loadStackedHeads(vault);
    expect(result).not.toBeNull();
    expect(result!.text.classes).toEqual(["A", "B"]);
    expect(result!.vision.classes).toEqual(["A", "B"]);
    expect(result!.meta.classes).toEqual(["A", "B"]);
    expect(result!.meta.inDim).toBe(4);
  });
});
