// @ts-expect-error — fmin ships no type declarations; import via index.js (proper ESM entry)
// because fmin@0.0.4's "main" points to a UMD build that doesn't export as ESM.
import { conjugateGradient } from "fmin/index.js";
import { LOGREG_C, LOGREG_TOL, LOGREG_MAX_ITERATIONS } from "@/config";

export interface LogRegResult {
  W: number[][]; // classes × dim
  b: number[];   // classes
  classes: string[];
}

function l2norm(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

/** Fit multinomial logistic regression matching sklearn LogisticRegression
 *  (lbfgs, l2, C, class_weight=balanced): minimize
 *    C · Σ_i w_i · (−log softmax(W·x̂_i + b)[y_i]) + ½·‖W‖²_F
 *  (intercept b NOT regularized). Optimizer: fmin conjugate-gradient.
 *
 *  fmin@0.0.4 API note: conjugateGradient(f, initial, params) where
 *    f(x, fxprime) fills fxprime in-place and returns the scalar loss.
 *    params supports { maxIterations }; gradientTolerance is NOT a param
 *    (convergence is hardcoded at norm(grad) ≤ 1e-5 in fmin source).
 *    Return value: { x, fx, fxprime } — read .x for the solution.
 *  LOGREG_TOL is kept for future use if fmin gains a tol param or we swap optimizers.
 */
export function fitLogReg(
  X: number[][], labels: string[], classes: string[],
  opts: { C?: number; balanced?: boolean; tol?: number } = {},
): LogRegResult {
  const C = opts.C ?? LOGREG_C;
  // LOGREG_TOL is not directly usable with fmin@0.0.4 (no gradientTolerance param);
  // captured here so the signature is consistent with callers that may pass tol.
  void (opts.tol ?? LOGREG_TOL);
  const K = classes.length;
  const D = X[0].length;
  const N = X.length;

  const Xn = X.map(l2norm);
  const classIdx = new Map(classes.map((c, i) => [c, i]));
  const yIdx = labels.map((l) => classIdx.get(l)!);

  // Balanced sample weights: N / (K * count[class]); else 1.
  const counts = new Array(K).fill(0);
  for (const yi of yIdx) counts[yi]++;
  const sw = yIdx.map((yi) =>
    opts.balanced ? N / (K * Math.max(1, counts[yi])) : 1,
  );

  // Parameter vector theta = [W flattened row-major (K*D), b (K)].
  const P = K * D + K;
  const theta0 = new Array(P).fill(0);

  // f(theta, grad): scalar loss + in-place gradient (fmin@0.0.4 API).
  // fmin passes a reused grad array each call — must zero it first.
  const f = (theta: number[], grad: number[]) => {
    for (let p = 0; p < P; p++) grad[p] = 0;
    let loss = 0;
    // L2 on W only (not b): ½‖W‖²
    for (let p = 0; p < K * D; p++) { loss += 0.5 * theta[p] * theta[p]; grad[p] += theta[p]; }
    for (let i = 0; i < N; i++) {
      const x = Xn[i];
      // z_k = W_k·x + b_k
      const z = new Array(K);
      let zmax = -Infinity;
      for (let k = 0; k < K; k++) {
        let s = theta[K * D + k];
        const off = k * D;
        for (let d = 0; d < D; d++) s += theta[off + d] * x[d];
        z[k] = s; if (s > zmax) zmax = s;
      }
      let sum = 0;
      for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - zmax); sum += z[k]; }
      const yi = yIdx[i]; const wi = sw[i];
      // data loss: -w_i * C * log p[y_i]
      loss += -wi * C * Math.log(z[yi] / sum);
      // grad: C * w_i * (p_k - [k==y_i]) * x_d  (+ bias term)
      for (let k = 0; k < K; k++) {
        const pk = z[k] / sum;
        const g = C * wi * (pk - (k === yi ? 1 : 0));
        const off = k * D;
        for (let d = 0; d < D; d++) grad[off + d] += g * x[d];
        grad[K * D + k] += g;
      }
    }
    return loss;
  };

  // fmin@0.0.4: no gradientTolerance param; maxIterations controls iterations.
  // Convergence hardcoded to norm(grad) <= 1e-5 in fmin's source.
  const sol = conjugateGradient(f, theta0, { maxIterations: LOGREG_MAX_ITERATIONS });
  const theta = sol.x as number[];

  const W: number[][] = [];
  for (let k = 0; k < K; k++) W.push(theta.slice(k * D, k * D + D));
  const b = theta.slice(K * D, K * D + K);
  return { W, b, classes };
}
