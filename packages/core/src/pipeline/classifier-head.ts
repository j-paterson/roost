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
 * Load and validate a single ClassifierHeadData file from an absolute path.
 * Returns null when the file is absent or structurally invalid.
 */
function loadHeadFile(headPath: string): ClassifierHead | null {
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
      return null;
    }
    return { classes: data.classes, W: data.W, b: data.b, dim: data.dim };
  } catch (e: unknown) {
    console.warn("[roost] Failed to load head file:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Load the classifier head from <vault>/.roost/cache/classifier-head.json.
 * Returns null when the file is absent or structurally invalid (caller falls back
 * to nearest-centroid).
 */
export function loadClassifierHead(vault: Vault): ClassifierHead | null {
  const vaultPath = vaultBasePath(vault);
  if (!vaultPath) return null;
  const headPath = cachePath(vaultPath, "classifier-head.json");
  const head = loadHeadFile(headPath);
  if (!head) {
    // Keep the original warning message for the legacy single-head path
    if (fs.existsSync(headPath)) {
      console.warn("[roost] classifier-head.json failed structural validation — falling back to nearest-centroid");
    }
  }
  return head;
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

/** Dot product of two equal-length numeric arrays. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface ClassifyResult {
  /** Predicted category name (argmax of softmax). */
  category: string;
  /** Max softmax probability in [0, 1]. Higher = more confident. */
  confidence: number;
}

/**
 * Apply the classifier head forward pass and return the full C-length softmax
 * probability vector (useful when the probabilities are fed into a meta-head).
 *
 * Forward:
 *   x_norm = x / ||x||₂
 *   z[c]   = dot(W[c], x_norm) + b[c]   for each class c
 *   return softmax(z)
 */
export function softmaxProba(vec: number[], head: ClassifierHead): number[] {
  const xNorm = l2Normalize(vec);
  const z = head.W.map((row, c) => dot(row, xNorm) + head.b[c]);
  return softmax(z);
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
  const p = softmaxProba(vec, head);
  let argmax = 0;
  let maxP = p[0];
  for (let c = 1; c < p.length; c++) {
    if (p[c] > maxP) { maxP = p[c]; argmax = c; }
  }
  return { category: head.classes[argmax], confidence: maxP };
}

// ── Stacked head types ────────────────────────────────────────────────────────

/**
 * On-disk and in-memory meta-head (C × 2C logistic regression over stacked probs).
 * W has shape C × inDim where inDim = 2*C.
 */
export interface MetaHead {
  classes: string[];
  /** Weight matrix, shape C × inDim (= C × 2C). */
  W: number[][];
  /** Bias vector, length C. */
  b: number[];
  /** Input dimension = 2*C (text probabilities concatenated with vision probabilities). */
  inDim: number;
}

/** Three-head bundle: two base heads (text, vision) plus a trained meta-head. */
export interface StackedHeads {
  text: ClassifierHead;
  vision: ClassifierHead;
  meta: MetaHead;
}

// ── Stacked forward pass ──────────────────────────────────────────────────────

/**
 * Combine a text embedding and a vision embedding through a trained meta-head.
 *
 * Forward:
 *   pText   = softmaxProba(vecText,   heads.text)    # length C
 *   pVision = softmaxProba(vecVision, heads.vision)  # length C
 *   feat    = [...pText, ...pVision]                 # length 2C  (MUST match Python exporter ordering)
 *   z[c]    = dot(meta.W[c], feat) + meta.b[c]
 *   p       = softmax(z)
 *   return { category: meta.classes[argmax(p)], confidence: max(p) }
 */
export function classifyStacked(
  vecText: number[],
  vecVision: number[],
  heads: StackedHeads,
): ClassifyResult {
  const pText = softmaxProba(vecText, heads.text);
  const pVision = softmaxProba(vecVision, heads.vision);
  const feat = [...pText, ...pVision]; // length 2C; ordering MUST match the Python exporter
  const z = heads.meta.W.map((row, c) => dot(row, feat) + heads.meta.b[c]);
  const p = softmax(z);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return { category: heads.meta.classes[best], confidence: p[best] };
}

// ── Stacked head loader ───────────────────────────────────────────────────────

/**
 * On-disk format of meta-head.json (version 1).
 * Exported for use by the retrain engine (train-head.ts).
 */
export interface MetaHeadData {
  classes: string[];
  W: number[][];
  b: number[];
  inDim: number;
  norm: "none";
  version: 1;
}

/**
 * Load the three-head bundle from:
 *   <vault>/.roost/cache/classifier-head-text.json
 *   <vault>/.roost/cache/classifier-head-vision.json
 *   <vault>/.roost/cache/meta-head.json
 *
 * Returns null when any file is absent or structurally invalid.
 * The caller should fall back to the single-head or nearest-centroid path.
 */
export function loadStackedHeads(vault: Vault): StackedHeads | null {
  const vaultPath = vaultBasePath(vault);
  if (!vaultPath) return null;

  const textHead = loadHeadFile(cachePath(vaultPath, "classifier-head-text.json"));
  if (!textHead) return null;

  const visionHead = loadHeadFile(cachePath(vaultPath, "classifier-head-vision.json"));
  if (!visionHead) return null;

  const metaPath = cachePath(vaultPath, "meta-head.json");
  try {
    if (!fs.existsSync(metaPath)) return null;
    const data: MetaHeadData = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const C = Array.isArray(data.classes) ? data.classes.length : 0;
    if (
      data.version !== 1 ||
      C === 0 ||
      !Array.isArray(data.W) ||
      data.W.length !== C ||
      !Array.isArray(data.b) ||
      data.b.length !== C ||
      typeof data.inDim !== "number" ||
      data.inDim !== 2 * C ||
      !data.W.every((row) => Array.isArray(row) && row.length === data.inDim)
    ) {
      console.warn("[roost] meta-head.json failed structural validation");
      return null;
    }
    const meta: MetaHead = { classes: data.classes, W: data.W, b: data.b, inDim: data.inDim };
    return { text: textHead, vision: visionHead, meta };
  } catch (e: unknown) {
    console.warn("[roost] Failed to load meta-head.json:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Compatibility check ───────────────────────────────────────────────────────

/**
 * Return true when every live category is a class the head can produce — i.e. the
 * live category set is a (non-empty) SUBSET of the head's classes. Called by the
 * wiring in evaluate.ts before trusting the head's output.
 *
 * The head is trained on a fixed taxonomy (the canonical classes). The live vault
 * need not currently contain every one of them — a canonical category can sit empty
 * (e.g. after a bulk re-category, or simply because nothing was ever filed there).
 * Requiring an EXACT match made the head unusable in that case and silently dropped
 * the whole run to nearest-centroid. A subset check keeps the head usable while still
 * rejecting genuinely foreign taxonomies: if the live set contains a name the head
 * was NOT trained on, the head can't represent it, so we fall back. The head may emit
 * a class not currently present in the live vault (the trained taxonomy is the
 * authority); scoreAgainstCategories logs those so the behaviour is never silent.
 */
export function headClassesMatch(head: { classes: string[] }, categoryNames: string[]): boolean {
  if (categoryNames.length === 0) return false;
  const headSet = new Set(head.classes);
  for (const name of categoryNames) {
    if (!headSet.has(name)) return false;
  }
  return true;
}

/**
 * Return true when all three heads in a StackedHeads bundle agree on the same
 * class set and that set matches the current live categories.
 *
 * All of text.classes, vision.classes, and meta.classes must be set-equal to
 * categoryNames. A mismatch means the bundle is stale (re-train needed).
 */
export function stackedHeadsClassesMatch(heads: StackedHeads, categoryNames: string[]): boolean {
  return (
    headClassesMatch(heads.meta, categoryNames) &&
    headClassesMatch(heads.text, categoryNames) &&
    headClassesMatch(heads.vision, categoryNames)
  );
}
