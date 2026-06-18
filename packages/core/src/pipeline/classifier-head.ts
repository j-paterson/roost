/**
 * Trained classifier head for Smart Assign Step 1.
 *
 * Implements a multinomial LogReg forward pass over L2-normalized v2 embeddings.
 * Weights are exported by scripts/train-classifier-head.py and cached at
 * <vault>/.roost/cache/classifier-head.json.
 *
 * Forward pass (must equal the Python exporter exactly — unit-tested):
 *   x_norm = x / ||x||₂
 *   z      = W · x_norm + b         (C logits)
 *   p      = softmax(z)
 *   category   = classes[argmax(p)]
 *   confidence = max(p)             in [0, 1]
 *
 * Falls back to nearest-centroid when the weights file is absent or its classes
 * don't match the current category set. Default off (settings.smartAssignClassifierHead).
 */

import * as fs from "fs";
import type { Vault } from "obsidian";
import { vaultBasePath } from "@/lib/vault-utils";
import { cachePath } from "@/lib/roost-paths";

// ── Schema ────────────────────────────────────────────────────────────────────

/** On-disk format of classifier-head.json (version 1). */
export interface ClassifierHeadData {
  /** Ordered class names (length C). argmax index → category name. */
  classes: string[];
  /** Weight matrix W, shape C × dim. Row i = weights for class i. */
  W: number[][];
  /** Bias vector b, length C. */
  b: number[];
  /** Embedding dimension — must equal 768 for v2. */
  dim: number;
  /** Normalisation applied to input vectors before W · x + b. */
  norm: "l2";
  /** Number of training items the head was trained on. Informational only. */
  trainedOn: number;
  /** Schema version. This code handles version 1 only. */
  version: 1;
}

/** Loaded, validated classifier head ready for inference. */
export interface ClassifierHead {
  classes: string[];
  /** W[c][d] = weight for class c, dimension d. */
  W: number[][];
  b: number[];
  dim: number;
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load the classifier head from <vault>/.roost/cache/classifier-head.json.
 * Returns null when the file is absent or structurally invalid (caller falls back
 * to nearest-centroid).
 */
export function loadClassifierHead(vault: Vault): ClassifierHead | null {
  const vaultPath = vaultBasePath(vault);
  if (!vaultPath) return null;
  const headPath = cachePath(vaultPath, "classifier-head.json");
  try {
    if (!fs.existsSync(headPath)) return null;
    const data: ClassifierHeadData = JSON.parse(fs.readFileSync(headPath, "utf8"));
    // Structural validation
    if (
      data.version !== 1 ||
      data.norm !== "l2" ||
      !Array.isArray(data.classes) ||
      data.classes.length === 0 ||
      !Array.isArray(data.W) ||
      data.W.length !== data.classes.length ||
      !Array.isArray(data.b) ||
      data.b.length !== data.classes.length ||
      typeof data.dim !== "number" ||
      data.dim < 1 ||
      // each W row must have exactly `dim` columns, else the dot product is silently wrong
      !data.W.every((row) => Array.isArray(row) && row.length === data.dim)
    ) {
      console.warn("[roost] classifier-head.json failed structural validation — falling back to nearest-centroid");
      return null;
    }
    return { classes: data.classes, W: data.W, b: data.b, dim: data.dim };
  } catch (e: unknown) {
    console.warn("[roost] Failed to load classifier-head.json:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Forward pass ──────────────────────────────────────────────────────────────

/**
 * L2-normalise a vector in place (returns a new array).
 * A zero vector is returned unchanged (no division by zero).
 */
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec.slice();
  return vec.map(x => x / norm);
}

/**
 * Numerically stable softmax over logit array.
 * Subtracts max before exp to prevent overflow.
 */
function softmax(z: number[]): number[] {
  let max = -Infinity;
  for (const v of z) if (v > max) max = v;
  let sum = 0;
  const exp = z.map(v => { const e = Math.exp(v - max); sum += e; return e; });
  return exp.map(e => e / sum);
}

export interface ClassifyResult {
  /** Predicted category name (argmax of softmax). */
  category: string;
  /** Max softmax probability in [0, 1]. Higher = more confident. */
  confidence: number;
}

/**
 * Apply the classifier head forward pass to a single embedding vector.
 *
 * Forward:
 *   x_norm = x / ||x||₂
 *   z[c]   = dot(W[c], x_norm) + b[c]   for each class c
 *   p      = softmax(z)
 *   return { category: classes[argmax(p)], confidence: max(p) }
 *
 * The TS implementation is kept intentionally simple (no SIMD) so it is
 * straightforward to audit against the Python exporter's identical formula.
 */
export function classifyWithHead(vec: number[], head: ClassifierHead): ClassifyResult {
  const xNorm = l2Normalize(vec);
  const C = head.classes.length;
  const z = new Array<number>(C);
  for (let c = 0; c < C; c++) {
    let dot = 0;
    const row = head.W[c];
    for (let d = 0; d < row.length; d++) dot += row[d] * xNorm[d];
    z[c] = dot + head.b[c];
  }
  const p = softmax(z);
  let argmax = 0;
  let maxP = p[0];
  for (let c = 1; c < C; c++) {
    if (p[c] > maxP) { maxP = p[c]; argmax = c; }
  }
  return { category: head.classes[argmax], confidence: maxP };
}

// ── Compatibility check ───────────────────────────────────────────────────────

/**
 * Return true when the head's classes exactly match the current live category set.
 * Called by the wiring in evaluate.ts before trusting the head's output.
 *
 * A mismatch means the user added/removed collections since the head was trained —
 * fall back to nearest-centroid so the head never silently routes to a stale label.
 */
export function headClassesMatch(head: ClassifierHead, categoryNames: string[]): boolean {
  if (head.classes.length !== categoryNames.length) return false;
  const headSet = new Set(head.classes);
  for (const name of categoryNames) {
    if (!headSet.has(name)) return false;
  }
  return true;
}
