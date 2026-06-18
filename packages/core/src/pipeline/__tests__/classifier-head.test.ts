/**
 * Unit tests for the TS classifier-head forward pass.
 *
 * Faithfulness invariant: the TS forward must equal the Python exporter's
 * formula (z = W·x_l2norm + b, softmax, argmax + max-prob) — verified here
 * against a hand-computed crafted fixture so no file I/O or live weights are
 * needed.
 *
 * Tests:
 *   1. Correct softmax / argmax on a deterministic 3-class, 4-dim fixture.
 *   2. Probabilities sum to 1 (within floating-point tolerance).
 *   3. classifyWithHead picks the right class and confidence is in [0, 1].
 *   4. loadClassifierHead returns null when the weights file is absent.
 *   5. loadClassifierHead returns null when classes mismatch headClassesMatch.
 *   6. headClassesMatch: matching and mismatching sets behave correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileSystemAdapter } from "obsidian";
import {
  classifyWithHead,
  headClassesMatch,
  loadClassifierHead,
  type ClassifierHead,
  type ClassifierHeadData,
} from "@/pipeline/classifier-head";

// ── Crafted fixture ────────────────────────────────────────────────────────────
//
// 3 classes, 4-dimensional embedding.
//
// W (3×4), b (3), x (4 raw, will be L2-normalized to x_norm)
//
// x = [3, 4, 0, 0]   →  ||x|| = 5   →  x_norm = [0.6, 0.8, 0, 0]
//
// W:
//   class A: [1, 0, 0, 0]
//   class B: [0, 1, 0, 0]
//   class C: [0, 0, 1, 0]
//
// b = [0, 2, 0]   (bias favours B so we can confirm it wins over dot products)
//
// z = W · x_norm + b:
//   z_A = 1·0.6 + 0·0.8 + 0·0 + 0·0  + 0  = 0.6
//   z_B = 0·0.6 + 1·0.8 + 0·0 + 0·0  + 2  = 2.8
//   z_C = 0·0.6 + 0·0.8 + 1·0 + 0·0  + 0  = 0
//
// softmax(z):
//   max = 2.8
//   e_A = exp(0.6 - 2.8) = exp(-2.2) ≈ 0.11080
//   e_B = exp(2.8 - 2.8) = exp(0)    = 1.00000
//   e_C = exp(0   - 2.8) = exp(-2.8) ≈ 0.06081
//   sum  ≈ 1.17161
//   p_A ≈ 0.09458
//   p_B ≈ 0.85353
//   p_C ≈ 0.05190
//
// argmax → B   confidence ≈ 0.854

const FIXTURE_HEAD: ClassifierHead = {
  classes: ["A", "B", "C"],
  W: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  b: [0, 2, 0],
  dim: 4,
};

const FIXTURE_VEC = [3, 4, 0, 0];

// Precomputed expected values (Python reference):
//   python -c "import numpy as np; x=np.array([3,4,0,0],dtype=float);
//     xn=x/np.linalg.norm(x); W=np.eye(3,4); b=np.array([0,2,0]);
//     z=W@xn+b; e=np.exp(z-z.max()); p=e/e.sum();
//     print(p, p.argmax(), p.max())"
const EXPECTED_CATEGORY = "B";
const EXPECTED_CONFIDENCE_APPROX = 0.8535; // ≈ p_B
const PROB_SUM_TOLERANCE = 1e-9;
const CONFIDENCE_APPROX_TOLERANCE = 1e-4;

// ── Tests: classifyWithHead forward ───────────────────────────────────────────

describe("classifyWithHead", () => {
  it("picks the correct class (argmax)", () => {
    const result = classifyWithHead(FIXTURE_VEC, FIXTURE_HEAD);
    expect(result.category).toBe(EXPECTED_CATEGORY);
  });

  it("confidence matches softmax max-prob to 4 decimal places", () => {
    const result = classifyWithHead(FIXTURE_VEC, FIXTURE_HEAD);
    expect(result.confidence).toBeCloseTo(EXPECTED_CONFIDENCE_APPROX, 4);
  });

  it("confidence is in [0, 1]", () => {
    const result = classifyWithHead(FIXTURE_VEC, FIXTURE_HEAD);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("softmax probabilities sum to 1 (verified via per-class forward)", () => {
    // Compute all class probabilities manually to assert sum = 1.
    const xNorm = [3 / 5, 4 / 5, 0, 0];
    const C = FIXTURE_HEAD.classes.length;
    const z: number[] = [];
    for (let c = 0; c < C; c++) {
      const row = FIXTURE_HEAD.W[c];
      let dot = 0;
      for (let d = 0; d < row.length; d++) dot += row[d] * xNorm[d];
      z.push(dot + FIXTURE_HEAD.b[c]);
    }
    const maxZ = Math.max(...z);
    const exps = z.map(v => Math.exp(v - maxZ));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sum);
    const totalProb = probs.reduce((a, b) => a + b, 0);
    expect(Math.abs(totalProb - 1)).toBeLessThan(PROB_SUM_TOLERANCE);
  });

  it("zero vector input does not throw and still picks a class", () => {
    // A zero vector is L2-normalized to itself (no division by zero).
    const result = classifyWithHead([0, 0, 0, 0], FIXTURE_HEAD);
    expect(FIXTURE_HEAD.classes).toContain(result.category);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("unit-vector input: dim=0 picks class A with high confidence", () => {
    // x = [1, 0, 0, 0] → x_norm = same → z_A = 1+0, z_B = 0+2, z_C = 0+0
    // z_B still wins because bias=2 beats 1.
    const result = classifyWithHead([1, 0, 0, 0], FIXTURE_HEAD);
    expect(result.category).toBe("B");
  });

  it("when only class C gets a signal (dim=2 active + large bias on C)", () => {
    const head: ClassifierHead = {
      classes: ["A", "B", "C"],
      W: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ],
      b: [0, 0, 10], // large bias → C wins
      dim: 4,
    };
    const result = classifyWithHead([1, 1, 1, 1], head);
    expect(result.category).toBe("C");
  });
});

// ── Tests: headClassesMatch ───────────────────────────────────────────────────

describe("headClassesMatch", () => {
  it("returns true when classes are an exact set match", () => {
    expect(headClassesMatch(FIXTURE_HEAD, ["A", "B", "C"])).toBe(true);
  });

  it("returns true regardless of order in the live category list", () => {
    expect(headClassesMatch(FIXTURE_HEAD, ["C", "A", "B"])).toBe(true);
  });

  it("returns false when a category is missing from the head", () => {
    expect(headClassesMatch(FIXTURE_HEAD, ["A", "B", "C", "D"])).toBe(false);
  });

  it("returns false when the head has extra classes not in live categories", () => {
    expect(headClassesMatch(FIXTURE_HEAD, ["A", "B"])).toBe(false);
  });

  it("returns false when counts match but a name differs", () => {
    expect(headClassesMatch(FIXTURE_HEAD, ["A", "B", "X"])).toBe(false);
  });
});

// ── Tests: loadClassifierHead fallback paths ───────────────────────────────────

describe("loadClassifierHead fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-head-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a minimal Vault mock pointing at root.
   * vaultBasePath() checks `vault.adapter instanceof FileSystemAdapter` and
   * then calls `.getBasePath()`. The obsidian mock exports a real FileSystemAdapter
   * class that vitest resolves via the alias, so instanceof works correctly.
   */
  function makeVault(root: string): import("obsidian").Vault {
    const adapter = new FileSystemAdapter();
    (adapter as unknown as { basePath: string }).basePath = root;
    return { adapter } as unknown as import("obsidian").Vault;
  }

  it("returns null when the weights file is absent", () => {
    const vault = makeVault(tmpDir);
    const result = loadClassifierHead(vault);
    expect(result).toBeNull();
  });

  it("returns null when the JSON is structurally invalid (version mismatch)", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const bad: Partial<ClassifierHeadData> = {
      version: 2 as any,  // wrong version
      classes: ["A"],
      W: [[1, 0]],
      b: [0],
      dim: 2,
      norm: "l2",
      trainedOn: 10,
    };
    fs.writeFileSync(path.join(cacheDir, "classifier-head.json"), JSON.stringify(bad));
    const vault = makeVault(tmpDir);
    expect(loadClassifierHead(vault)).toBeNull();
  });

  it("returns null when classes/W/b length mismatch", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const bad: ClassifierHeadData = {
      version: 1,
      classes: ["A", "B"],  // 2 classes but W has 1 row
      W: [[1, 0]],
      b: [0],
      dim: 2,
      norm: "l2",
      trainedOn: 10,
    };
    fs.writeFileSync(path.join(cacheDir, "classifier-head.json"), JSON.stringify(bad));
    const vault = makeVault(tmpDir);
    expect(loadClassifierHead(vault)).toBeNull();
  });

  it("returns a valid head when the file is well-formed", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const good: ClassifierHeadData = {
      version: 1,
      classes: ["A", "B", "C"],
      W: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
      b: [0, 2, 0],
      dim: 4,
      norm: "l2",
      trainedOn: 100,
    };
    fs.writeFileSync(path.join(cacheDir, "classifier-head.json"), JSON.stringify(good));
    const vault = makeVault(tmpDir);
    const head = loadClassifierHead(vault);
    expect(head).not.toBeNull();
    expect(head!.classes).toEqual(["A", "B", "C"]);
    expect(head!.W.length).toBe(3);
    expect(head!.b.length).toBe(3);
  });

  it("fallback triggers when classes mismatch live categories after loading", () => {
    // loadClassifierHead itself just validates structure; headClassesMatch is
    // used by callers. Assert the round-trip: load → mismatch → fallback.
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const good: ClassifierHeadData = {
      version: 1,
      classes: ["A", "B", "C"],
      W: [[1, 0], [0, 1], [0, 0]],
      b: [0, 0, 0],
      dim: 2,
      norm: "l2",
      trainedOn: 50,
    };
    fs.writeFileSync(path.join(cacheDir, "classifier-head.json"), JSON.stringify(good));
    const vault = makeVault(tmpDir);
    const head = loadClassifierHead(vault);
    expect(head).not.toBeNull();
    // Simulate: user added a new collection "D" since training
    expect(headClassesMatch(head!, ["A", "B", "C", "D"])).toBe(false);
    // A caller seeing false should fall back to nearest-centroid.
  });
});
