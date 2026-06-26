/**
 * Integration tests for the per-item head→centroid→discovery cascade in
 * scoreAgainstCategories (embeddingOnly=true).
 *
 * TDD step 1 (red): written BEFORE the cascade implementation so the tests
 * fail while the old headClassesMatch gate is in place.
 *
 * Cascade routing:
 *   Tier 1 — stacked/single head, if confidence ≥ HEAD_REJECT_TAU → assign
 *   Tier 2 — nearest centroid (ALL live cats), if sim ≥ CENTROID_REJECT_TAU → assign
 *   Tier 3 — unmatched (residue for discovery)
 *
 * Key coexistence property: the head is used whenever structurally present.
 * An unknown live category (e.g. "X" below) can no longer DISABLE the head —
 * the cascade decides per item.
 */
import { it, expect } from "vitest";
import { scoreAgainstCategories, type CategoryDef } from "@/pipeline/evaluate";
import type { EmbeddingCacheEntry } from "@/types/roost";
import type { StackedHeads } from "@/pipeline/classifier-head";

// ── Cascade-specific fixture ───────────────────────────────────────────────────
//
// Three classes A/B/C, dim=4. Only A (dim 0) and B (dim 1) have strong weights;
// class C has zero weights so items whose embeddings point at dim 2 produce a
// flat softmax (confidence ≈ 1/3) and are deferred to the centroid tier.
//
// This lets us drive all three routing outcomes from the same fixture:
//   [9,0,0,0] → class A, conf ≈ 1.0  → HEAD tier
//   [0,0,1,0] → flat softmax, conf ≈ 0.33 → defers; if sim(X)≥τ → CENTROID tier
//   [0.1,0.1,0.1,0.9] → flat softmax, all centroid sims ≈ 0.11 → UNMATCHED
//
function mkStackedHeads(): StackedHeads {
  const C = 3;
  const dim = 4;
  const classes = ["A", "B", "C"];

  // Base head: A fires on dim 0 (weight 10), B on dim 1 (weight 10), C has zero
  // weights — it never produces a high-confidence output.
  const makeBaseHead = () => ({
    classes,
    W: [
      [10, 0, 0, 0],  // A: fires on dim 0
      [0, 10, 0, 0],  // B: fires on dim 1
      [0,  0, 0, 0],  // C: zero weights — always defers
    ],
    b: [0, 0, 0] as number[],
    dim,
  });

  // Meta head: inDim = 2*C = 6. W[c] has 10 at pText[c] and pVision[c].
  const inDim = 2 * C;
  const W = Array.from({ length: C }, (_, c) =>
    Array.from({ length: inDim }, (__, d) => (d === c || d === c + C ? 10 : 0)),
  );
  const b = Array<number>(C).fill(0);
  b[1] = 0.1; // tiebreak: B over C
  const meta = { classes, W, b, inDim };

  return { text: makeBaseHead(), vision: makeBaseHead(), meta };
}

// Live categories — A and B are in the head's class list; X is NOT.
const cats: CategoryDef[] = [
  { name: "A", description: "a", centroid: [1, 0, 0, 0] },
  { name: "B", description: "b", centroid: [0, 1, 0, 0] },
  { name: "X", description: "x", centroid: [0, 0, 1, 0] }, // not a head class
];

// ── Tests ─────────────────────────────────────────────────────────────────────

it("head-confident item → head tier (reason 'stacked'), unknown live category does NOT disable the head", async () => {
  const cache: Record<string, EmbeddingCacheEntry> = {
    h1: { vec: [9, 0, 0, 0], vecText: [9, 0, 0, 0], vision: null, summary: "x", category: null },
    x1: { vec: [0, 0, 9, 0], vecText: [0, 0, 9, 0], vision: null, summary: "x", category: null },
  };
  const r = await scoreAgainstCategories({
    itemIds: ["h1", "x1"], cache, categories: cats,
    embeddingOnly: true, stackedHeads: mkStackedHeads(),
    onLog: () => {},
  });
  // h1 is confidently class A → head tier
  expect(r.matchDetails.get("h1")?.reason).toMatch(/stacked/);
  // presence of live category "X" (not in the head) did NOT disable the head
  expect(r.assignments.has("h1")).toBe(true);
});

it("head-unsure but centroid-confident → centroid tier (reason 'centroid')", async () => {
  // x1=[0,0,1,0]: class C has zero weights → flat softmax → conf≈0.33 < HEAD_REJECT_TAU.
  // Nearest centroid is X=[0,0,1,0] with sim=1.0 ≥ CENTROID_REJECT_TAU.
  const cache: Record<string, EmbeddingCacheEntry> = {
    x1: { vec: [0, 0, 1, 0], vecText: [0, 0, 1, 0], vision: null, summary: "x", category: null },
  };
  const r = await scoreAgainstCategories({
    itemIds: ["x1"], cache, categories: cats,
    embeddingOnly: true, stackedHeads: mkStackedHeads(), onLog: () => {},
  });
  expect(r.matchDetails.get("x1")?.reason).toMatch(/centroid/);
  expect(r.assignments.get("x1")).toBe("X");
});

it("below both thresholds → unmatched (handed to discovery)", async () => {
  // z1=[0.1,0.1,0.1,0.9]: head defers (flat softmax ≈ [0.42,0.42,0.16]);
  // all centroid sims ≈ 0.109 < CENTROID_REJECT_TAU → unmatched.
  const cache: Record<string, EmbeddingCacheEntry> = {
    z1: { vec: [0.1, 0.1, 0.1, 0.9], vecText: [0.1, 0.1, 0.1, 0.9], vision: null, summary: "z", category: null },
  };
  const r = await scoreAgainstCategories({
    itemIds: ["z1"], cache, categories: cats,
    embeddingOnly: true, stackedHeads: mkStackedHeads(), onLog: () => {},
  });
  expect(r.unmatched).toContain("z1");
});
