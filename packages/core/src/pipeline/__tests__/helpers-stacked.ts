/**
 * Shared stacked-heads fixture for unit tests.
 *
 * Extracted from evaluate-stacked.test.ts so the same constructor can be
 * imported by any test file that needs a well-formed StackedHeads object.
 */
import type { StackedHeads } from "@/pipeline/classifier-head";

/** Returns a unit vector with 1 at position i in a dim-dimensional space. */
export function unit(i: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
}

/**
 * Build a StackedHeads fixture with C=3 classes and dim=4 embeddings.
 *
 * Default classes: ["Italian", "Strength", "Cardio"]
 * Pass an explicit `classes` array to use different class names (same weight
 * structure, same dim=4).
 *
 * Base heads: W[c][c] = 10 for all c; b = 0.
 *   unit(0) → argmax 0 → classes[0]  (confidence ≈ 1.0)
 *   unit(1) → argmax 1 → classes[1]  (confidence ≈ 1.0)
 *   unit(2) → argmax 2 → classes[2]  (confidence ≈ 1.0)
 *
 * Meta head: inDim = 2*C = 6. feat = [...pText, ...pVision].
 * Text slots (index c, weight 20) are weighted 4× more than vision slots
 * (index c+C, weight 5) so the text head dominates when heads disagree:
 *   unit(1)/unit(2): pText≈[0,1,0], pVision≈[0,0,1]
 *     z[1]=20*1+5*0=20, z[2]=20*0+5*1=5 → "classes[1]" wins with conf>>HEAD_REJECT_TAU
 *
 * b[1] = 0.1 to break any exact tie in favour of classes[1].
 */
export function mkStackedHeads(classes = ["Italian", "Strength", "Cardio"]): StackedHeads {
  const C = classes.length;
  const dim = 4;

  // Single-embedding base head: W[c][c] = 10, rest 0; b = [0,0,0].
  const makeBaseHead = () => ({
    classes,
    W: Array.from({ length: C }, (_, c) =>
      Array.from({ length: dim }, (__, d) => (d === c ? 10 : 0)),
    ),
    b: Array<number>(C).fill(0),
    dim,
  });

  // Meta head: inDim = 2*C.
  // Text slots (index c, weight 20) dominate over vision slots (index c+C, weight 5).
  // When text and vision heads agree: conf = softmax([25,...]) ≈ 1.0.
  // When they disagree (item2: text→classes[1], vision→classes[2]):
  //   z[1]=20, z[2]=5 → softmax → classes[1] wins decisively (conf >> HEAD_REJECT_TAU).
  // b[1] = 0.1 to break any exact tie in favour of classes[1].
  const inDim = 2 * C;
  const W = Array.from({ length: C }, (_, c) =>
    Array.from({ length: inDim }, (__, d) => {
      if (d === c) return 20;     // text slot: high weight
      if (d === c + C) return 5;  // vision slot: lower weight
      return 0;
    }),
  );
  const b = Array<number>(C).fill(0);
  b[1] = 0.1; // tiny bias to break exact ties: classes[1] over classes[2]
  const meta = { classes, W, b, inDim };

  return { text: makeBaseHead(), vision: makeBaseHead(), meta };
}
