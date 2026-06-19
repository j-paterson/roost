/**
 * Unit tests for the TS tag-detector forward pass (multi-label sigmoid heads).
 *
 * Faithfulness invariant: the TS forward must match the Python eval-tag-detectors.py
 * formula exactly — (L2-normalize, W·x+b, sigmoid, fire iff >= threshold) — verified
 * here against a hand-computed crafted fixture so no file I/O or live weights are needed.
 *
 * Fixture: 3 tags, 4-dimensional embedding.
 *
 *   x = [3, 4, 0, 0]   →  ||x|| = 5   →  x_norm = [0.6, 0.8, 0, 0]
 *
 *   W (3×4):
 *     tag "Art":    [1, 0, 0, 0]
 *     tag "Tech":   [0, 1, 0, 0]
 *     tag "Humor":  [0, 0, 1, 0]
 *
 *   b = [0.5, -0.5, -5.0]
 *
 *   z = W · x_norm + b:
 *     z_Art   = 1·0.6 + 0·0.8 + 0 + 0  + 0.5  =  1.1
 *     z_Tech  = 0·0.6 + 1·0.8 + 0 + 0  - 0.5  =  0.3
 *     z_Humor = 0·0.6 + 0·0.8 + 1·0 + 0 - 5.0 = -5.0
 *
 *   sigmoid(z):
 *     s_Art   = 1/(1+e^{-1.1}) ≈ 0.75026
 *     s_Tech  = 1/(1+e^{-0.3}) ≈ 0.57444
 *     s_Humor = 1/(1+e^{5.0})  ≈ 0.00669
 *
 *   thresholds = [0.7, 0.6, 0.1]
 *     Art   fires: 0.75026 >= 0.7  → YES
 *     Tech  fires: 0.57444 >= 0.6  → NO
 *     Humor fires: 0.00669 >= 0.1  → NO
 *
 *   fired tags = ["Art"]
 *   primary    = "Art"  (argmax sigmoid across all 3 tags)
 *
 * Tests:
 *   1. Fired tags = correct set (Art only).
 *   2. Primary = argmax sigmoid (Art).
 *   3. Sigmoid scores have expected values (hand-computed, 4 dp).
 *   4. Changing thresholds fires a different set.
 *   5. All-below-threshold → empty tags but primary still set.
 *   6. All-above-threshold → all tags fire.
 *   7. Zero vector does not throw; primary is still returned.
 *   8. loadTagDetectors returns null on missing file.
 *   9. loadTagDetectors returns null on version mismatch.
 *  10. loadTagDetectors returns null on thresholds length mismatch.
 *  11. loadTagDetectors returns a valid head on well-formed JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileSystemAdapter } from "obsidian";
import {
  classifyTags,
  loadTagDetectors,
  type TagDetectors,
  type TagDetectorData,
} from "@/pipeline/tag-detectors";

// ── Crafted fixture ────────────────────────────────────────────────────────────

const FIXTURE_DET: TagDetectors = {
  tags: ["Art", "Tech", "Humor"],
  W: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  b: [0.5, -0.5, -5.0],
  thresholds: [0.7, 0.6, 0.1],
  dim: 4,
};

const FIXTURE_VEC = [3, 4, 0, 0];

// Hand-computed expected sigmoid values (to 5 significant figures):
//   python -c "import numpy as np; x=np.array([3,4,0,0],dtype=float);
//     xn=x/np.linalg.norm(x); W=np.array([[1,0,0,0],[0,1,0,0],[0,0,1,0]],dtype=float);
//     b=np.array([0.5,-0.5,-5.0]); z=W@xn+b; s=1/(1+np.exp(-z)); print(s)"
const EXPECTED_SCORE_ART   = 0.75026;  // sigmoid(1.1)
const EXPECTED_SCORE_TECH  = 0.57444;  // sigmoid(0.3)
const EXPECTED_SCORE_HUMOR = 0.00669;  // sigmoid(-5.0)
const SCORE_TOLERANCE = 1e-4;

// ── Tests: classifyTags forward ───────────────────────────────────────────────

describe("classifyTags — fired tag set", () => {
  it("fires only Art (score 0.750 >= threshold 0.7)", () => {
    const result = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    expect(result.tags).toEqual(["Art"]);
  });

  it("primary = Art (highest sigmoid across all tags)", () => {
    const result = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    expect(result.primary).toBe("Art");
  });

  it("scores[0] (descending) is Art with expected value", () => {
    const result = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    expect(result.scores[0].tag).toBe("Art");
    expect(result.scores[0].score).toBeCloseTo(EXPECTED_SCORE_ART, 4);
  });

  it("scores[1] is Tech with expected value", () => {
    const result = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    expect(result.scores[1].tag).toBe("Tech");
    expect(result.scores[1].score).toBeCloseTo(EXPECTED_SCORE_TECH, 4);
  });

  it("scores[2] is Humor with expected value", () => {
    const result = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    expect(result.scores[2].tag).toBe("Humor");
    expect(result.scores[2].score).toBeCloseTo(EXPECTED_SCORE_HUMOR, 4);
  });

  it("scores are sorted descending", () => {
    const result = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    for (let i = 0; i < result.scores.length - 1; i++) {
      expect(result.scores[i].score).toBeGreaterThanOrEqual(result.scores[i + 1].score);
    }
  });
});

describe("classifyTags — threshold variations", () => {
  it("lowering Tech threshold to 0.5 fires both Art and Tech", () => {
    const det: TagDetectors = { ...FIXTURE_DET, thresholds: [0.7, 0.5, 0.1] };
    const result = classifyTags(FIXTURE_VEC, det);
    expect(result.tags).toContain("Art");
    expect(result.tags).toContain("Tech");
    expect(result.tags).not.toContain("Humor");
  });

  it("lowering Humor threshold to 0.001 fires all three tags", () => {
    const det: TagDetectors = { ...FIXTURE_DET, thresholds: [0.5, 0.5, 0.001] };
    const result = classifyTags(FIXTURE_VEC, det);
    expect(result.tags).toEqual(expect.arrayContaining(["Art", "Tech", "Humor"]));
    expect(result.tags).toHaveLength(3);
  });

  it("raising all thresholds above max score → empty fired set but primary still set", () => {
    const det: TagDetectors = { ...FIXTURE_DET, thresholds: [0.99, 0.99, 0.99] };
    const result = classifyTags(FIXTURE_VEC, det);
    expect(result.tags).toHaveLength(0);
    // primary is always the argmax sigmoid, regardless of threshold
    expect(result.primary).toBe("Art");
  });
});

describe("classifyTags — primary = argmax sigmoid", () => {
  it("when bias flips the winner, primary follows the sigmoid argmax", () => {
    // Give Humor a huge positive bias so its sigmoid dominates
    const det: TagDetectors = {
      tags: ["Art", "Tech", "Humor"],
      W: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ],
      b: [0.5, -0.5, 10.0],   // Humor bias = 10 → sigmoid ≈ 1.0
      thresholds: [0.7, 0.6, 0.1],
      dim: 4,
    };
    const result = classifyTags(FIXTURE_VEC, det);
    expect(result.primary).toBe("Humor");
  });
});

describe("classifyTags — edge cases", () => {
  it("zero vector does not throw", () => {
    expect(() => classifyTags([0, 0, 0, 0], FIXTURE_DET)).not.toThrow();
  });

  it("zero vector still returns a non-null primary", () => {
    const result = classifyTags([0, 0, 0, 0], FIXTURE_DET);
    // After L2-norm of zero: xNorm = [0,0,0,0]; z = b only → compare biases
    // b = [0.5, -0.5, -5.0] → sigmoid(0.5) ≈ 0.622, sigmoid(-0.5) ≈ 0.378, sigmoid(-5.0) ≈ 0.007
    // primary = Art
    expect(result.primary).toBe("Art");
  });

  it("single-tag detector fires when score >= threshold", () => {
    const det: TagDetectors = {
      tags: ["Food"],
      W: [[1, 0]],
      b: [0],
      thresholds: [0.5],
      dim: 2,
    };
    // x = [1, 0] → x_norm = [1, 0] → z = 1+0 = 1 → sigmoid(1) ≈ 0.731 >= 0.5
    const result = classifyTags([1, 0], det);
    expect(result.tags).toEqual(["Food"]);
    expect(result.primary).toBe("Food");
  });

  it("single-tag detector does NOT fire when score < threshold", () => {
    const det: TagDetectors = {
      tags: ["Food"],
      W: [[1, 0]],
      b: [0],
      thresholds: [0.8],
      dim: 2,
    };
    // sigmoid(1) ≈ 0.731 < 0.8 → does not fire
    const result = classifyTags([1, 0], det);
    expect(result.tags).toHaveLength(0);
    expect(result.primary).toBe("Food");   // still the only tag, so it's the argmax
  });
});

// ── Tests: loadTagDetectors fallback paths ─────────────────────────────────────

describe("loadTagDetectors fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-tagdet-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Minimal Vault mock — mirrors classifier-head.test.ts pattern.
   * vaultBasePath() checks `vault.adapter instanceof FileSystemAdapter`
   * then calls `.getBasePath()`.
   */
  function makeVault(root: string): import("obsidian").Vault {
    const adapter = new FileSystemAdapter();
    (adapter as unknown as { basePath: string }).basePath = root;
    return { adapter } as unknown as import("obsidian").Vault;
  }

  it("returns null when the weights file is absent", () => {
    const vault = makeVault(tmpDir);
    expect(loadTagDetectors(vault)).toBeNull();
  });

  it("returns null when version !== 2", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const bad = {
      version: 1,         // wrong
      norm: "l2",
      tags: ["Art"],
      W: [[1, 0]],
      b: [0],
      thresholds: [0.5],
    };
    fs.writeFileSync(path.join(cacheDir, "tag-detectors.json"), JSON.stringify(bad));
    expect(loadTagDetectors(makeVault(tmpDir))).toBeNull();
  });

  it("returns null when norm !== 'l2'", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const bad = {
      version: 2,
      norm: "cosine",     // wrong
      tags: ["Art"],
      W: [[1, 0]],
      b: [0],
      thresholds: [0.5],
    };
    fs.writeFileSync(path.join(cacheDir, "tag-detectors.json"), JSON.stringify(bad));
    expect(loadTagDetectors(makeVault(tmpDir))).toBeNull();
  });

  it("returns null when thresholds.length !== tags.length", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const bad: Partial<TagDetectorData> = {
      version: 2,
      norm: "l2",
      tags: ["Art", "Tech"],
      W: [[1, 0], [0, 1]],
      b: [0, 0],
      thresholds: [0.5],   // length 1, not 2
    };
    fs.writeFileSync(path.join(cacheDir, "tag-detectors.json"), JSON.stringify(bad));
    expect(loadTagDetectors(makeVault(tmpDir))).toBeNull();
  });

  it("returns null when W row length is inconsistent", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const bad = {
      version: 2,
      norm: "l2",
      tags: ["Art", "Tech"],
      W: [[1, 0], [0, 1, 2]],   // row 1 has 2 cols, row 2 has 3 → inconsistent
      b: [0, 0],
      thresholds: [0.5, 0.5],
    };
    fs.writeFileSync(path.join(cacheDir, "tag-detectors.json"), JSON.stringify(bad));
    expect(loadTagDetectors(makeVault(tmpDir))).toBeNull();
  });

  it("returns a valid TagDetectors on a well-formed file", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const good: TagDetectorData = {
      version: 2,
      norm: "l2",
      tags: ["Art", "Tech", "Humor"],
      W: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ],
      b: [0.5, -0.5, -5.0],
      thresholds: [0.7, 0.6, 0.1],
      trainedOn: 265,
    };
    fs.writeFileSync(path.join(cacheDir, "tag-detectors.json"), JSON.stringify(good));
    const det = loadTagDetectors(makeVault(tmpDir));
    expect(det).not.toBeNull();
    expect(det!.tags).toEqual(["Art", "Tech", "Humor"]);
    expect(det!.W).toHaveLength(3);
    expect(det!.b).toHaveLength(3);
    expect(det!.thresholds).toHaveLength(3);
    expect(det!.dim).toBe(4);
  });

  it("loaded detector produces the same result as the in-memory fixture", () => {
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const good: TagDetectorData = {
      version: 2,
      norm: "l2",
      tags: FIXTURE_DET.tags,
      W: FIXTURE_DET.W,
      b: FIXTURE_DET.b,
      thresholds: FIXTURE_DET.thresholds,
    };
    fs.writeFileSync(path.join(cacheDir, "tag-detectors.json"), JSON.stringify(good));
    const det = loadTagDetectors(makeVault(tmpDir));
    expect(det).not.toBeNull();
    const result = classifyTags(FIXTURE_VEC, det!);
    expect(result.tags).toEqual(["Art"]);
    expect(result.primary).toBe("Art");
    expect(result.scores[0].score).toBeCloseTo(EXPECTED_SCORE_ART, 4);
  });
});
