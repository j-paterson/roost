/**
 * Multi-label tag-detector forward pass for Smart Assign v2.
 *
 * Implements per-tag sigmoid binary heads over L2-normalized v2 embeddings.
 * Weights are exported by scripts/eval-tag-detectors.py and cached at
 * <vault>/.roost/cache/tag-detectors.json.
 *
 * Forward pass (must match scripts/eval-tag-detectors.py EXACTLY):
 *   x_l2norm = x / ||x||₂
 *   z[t]     = dot(W[t], x_l2norm) + b[t]   for each tag t
 *   s[t]     = sigmoid(z[t])
 *   fires    = s[t] >= thresholds[t]
 *   tags     = every tag that fires
 *   primary  = tags[argmax(s)]               (highest sigmoid tag)
 *
 * Returns null from loadTagDetectors when the file is absent or fails validation
 * (version !== 2, norm !== "l2", W row length !== dim, thresholds length !== tags).
 */

import * as fs from "fs";
import type { Vault } from "obsidian";
import { vaultBasePath } from "@/lib/vault-utils";
import { cachePath } from "@/lib/roost-paths";

// ── Schema ────────────────────────────────────────────────────────────────────

/** On-disk format of tag-detectors.json (version 2). */
export interface TagDetectorData {
  /** Ordered tag names (length T). */
  tags: string[];
  /** Weight matrix W, shape T × dim. Row t = weights for tag t. */
  W: number[][];
  /** Bias vector b, length T. */
  b: number[];
  /** Per-tag calibrated thresholds (length T). Tag fires iff sigmoid >= threshold. */
  thresholds: number[];
  /** Normalisation applied to input vectors before W · x + b. */
  norm: "l2";
  /** Schema version. This code handles version 2 only. */
  version: 2;
  /** Informational: how thresholds were tuned. */
  thresholdMode?: string;
  thresholdMult?: number;
  /** Number of training items the heads were trained on. Informational only. */
  trainedOn?: number;
}

/** Loaded, validated tag detectors ready for inference. */
export interface TagDetectors {
  /** Ordered tag names (length T). */
  tags: string[];
  /** W[t][d] = weight for tag t, dimension d. */
  W: number[][];
  /** Bias per tag, length T. */
  b: number[];
  /** Per-tag sigmoid thresholds, length T. Tag fires iff sigmoid(z) >= thresholds[t]. */
  thresholds: number[];
  /** Embedding dimension (must equal 768 for v2 embeddings). */
  dim: number;
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load tag detectors from <vault>/.roost/cache/tag-detectors.json.
 * Returns null when the file is absent or structurally invalid.
 */
export function loadTagDetectors(vault: Vault): TagDetectors | null {
  const vaultPath = vaultBasePath(vault);
  if (!vaultPath) return null;
  const detPath = cachePath(vaultPath, "tag-detectors.json");
  try {
    if (!fs.existsSync(detPath)) return null;
    const data: TagDetectorData = JSON.parse(fs.readFileSync(detPath, "utf8"));

    // Structural validation
    if (
      data.version !== 2 ||
      data.norm !== "l2" ||
      !Array.isArray(data.tags) ||
      data.tags.length === 0 ||
      !Array.isArray(data.W) ||
      data.W.length !== data.tags.length ||
      !Array.isArray(data.b) ||
      data.b.length !== data.tags.length ||
      !Array.isArray(data.thresholds) ||
      data.thresholds.length !== data.tags.length
    ) {
      console.warn("[roost] tag-detectors.json failed structural validation — multi-label tags unavailable");
      return null;
    }

    // Infer dim from the first W row; validate all rows match
    const dim = data.W[0].length;
    if (dim < 1 || !data.W.every((row) => Array.isArray(row) && row.length === dim)) {
      console.warn("[roost] tag-detectors.json W row length mismatch — multi-label tags unavailable");
      return null;
    }

    return { tags: data.tags, W: data.W, b: data.b, thresholds: data.thresholds, dim };
  } catch (e: unknown) {
    console.warn("[roost] Failed to load tag-detectors.json:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Forward pass ──────────────────────────────────────────────────────────────

/**
 * L2-normalise a vector (returns a new array).
 * A zero vector is returned unchanged (no division by zero).
 */
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec.slice();
  return vec.map(x => x / norm);
}

/** Sigmoid: σ(z) = 1 / (1 + e^{-z}). */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export interface TagClassifyResult {
  /** All tags whose sigmoid score meets or exceeds their per-tag threshold. */
  tags: string[];
  /**
   * The primary tag — the tag with the highest sigmoid score among ALL tags
   * (not only the firing ones). Null only when the detector set is empty.
   */
  primary: string | null;
  /** Full sigmoid scores for every tag, sorted descending. */
  scores: { tag: string; score: number }[];
}

/**
 * Apply the multi-label tag-detector forward pass to a single embedding vector.
 *
 * Forward (matches eval-tag-detectors.py exactly):
 *   x_norm = x / ||x||₂
 *   z[t]   = dot(W[t], x_norm) + b[t]   for each tag t
 *   s[t]   = sigmoid(z[t])
 *   fires  = { t : s[t] >= thresholds[t] }
 *   primary = tag with max s[t] (over all T tags)
 *
 * @param vec   Raw embedding vector (length must equal det.dim).
 * @param det   Loaded & validated TagDetectors.
 */
export function classifyTags(vec: number[], det: TagDetectors): TagClassifyResult {
  const xNorm = l2Normalize(vec);
  const T = det.tags.length;

  const scores: { tag: string; score: number }[] = new Array(T);
  for (let t = 0; t < T; t++) {
    const row = det.W[t];
    let dot = 0;
    for (let d = 0; d < row.length; d++) dot += row[d] * xNorm[d];
    const s = sigmoid(dot + det.b[t]);
    scores[t] = { tag: det.tags[t], score: s };
  }

  // Primary = argmax sigmoid (over all tags, threshold-independent)
  let primaryIdx = 0;
  let maxScore = scores[0].score;
  for (let t = 1; t < T; t++) {
    if (scores[t].score > maxScore) {
      maxScore = scores[t].score;
      primaryIdx = t;
    }
  }

  const firedTags: string[] = [];
  for (let t = 0; t < T; t++) {
    if (scores[t].score >= det.thresholds[t]) {
      firedTags.push(det.tags[t]);
    }
  }

  // Sort scores descending for the caller's convenience
  const sortedScores = scores.slice().sort((a, b) => b.score - a.score);

  return {
    tags: firedTags,
    primary: T > 0 ? scores[primaryIdx].tag : null,
    scores: sortedScores,
  };
}
