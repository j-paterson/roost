import { describe, it, expect } from "vitest";
import { cosineSimilarity, fusedSimilarity, computeCentroid } from "./shared";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("handles zero vector gracefully", () => {
    const result = cosineSimilarity([0, 0], [1, 1]);
    expect(result).toBeCloseTo(0);
  });
});

describe("fusedSimilarity", () => {
  const textVec = [1, 0, 0];
  const textCentroid = [0.9, 0.1, 0];
  const clipVec = [0, 1, 0];
  const clipCentroid = [0, 0.8, 0.2];

  it("returns text-only similarity when clipVec is null", () => {
    const result = fusedSimilarity(textVec, textCentroid, null, clipCentroid, 0.5);
    expect(result).toBeCloseTo(cosineSimilarity(textVec, textCentroid));
  });

  it("returns text-only similarity when clipCentroid is null", () => {
    const result = fusedSimilarity(textVec, textCentroid, clipVec, null, 0.5);
    expect(result).toBeCloseTo(cosineSimilarity(textVec, textCentroid));
  });

  it("returns text-only similarity when clipVec is undefined", () => {
    const result = fusedSimilarity(textVec, textCentroid, undefined, clipCentroid, 0.5);
    expect(result).toBeCloseTo(cosineSimilarity(textVec, textCentroid));
  });

  it("returns text-only similarity when alpha is 0", () => {
    const result = fusedSimilarity(textVec, textCentroid, clipVec, clipCentroid, 0);
    expect(result).toBeCloseTo(cosineSimilarity(textVec, textCentroid));
  });

  it("returns clip-only similarity when alpha is 1", () => {
    const result = fusedSimilarity(textVec, textCentroid, clipVec, clipCentroid, 1);
    expect(result).toBeCloseTo(cosineSimilarity(clipVec, clipCentroid));
  });

  it("blends at alpha=0.5 as average of both similarities", () => {
    const textSim = cosineSimilarity(textVec, textCentroid);
    const clipSim = cosineSimilarity(clipVec, clipCentroid);
    const expected = 0.5 * clipSim + 0.5 * textSim;
    const result = fusedSimilarity(textVec, textCentroid, clipVec, clipCentroid, 0.5);
    expect(result).toBeCloseTo(expected);
  });

  it("weights correctly at alpha=0.3", () => {
    const textSim = cosineSimilarity(textVec, textCentroid);
    const clipSim = cosineSimilarity(clipVec, clipCentroid);
    const expected = 0.3 * clipSim + 0.7 * textSim;
    const result = fusedSimilarity(textVec, textCentroid, clipVec, clipCentroid, 0.3);
    expect(result).toBeCloseTo(expected);
  });

  it("fused value is between text-only and clip-only", () => {
    const textSim = cosineSimilarity(textVec, textCentroid);
    const clipSim = cosineSimilarity(clipVec, clipCentroid);
    const result = fusedSimilarity(textVec, textCentroid, clipVec, clipCentroid, 0.5);
    expect(result).toBeGreaterThanOrEqual(Math.min(textSim, clipSim) - 1e-9);
    expect(result).toBeLessThanOrEqual(Math.max(textSim, clipSim) + 1e-9);
  });
});

describe("computeCentroid", () => {
  it("returns the single vector for a 1-element list", () => {
    const c = computeCentroid([[1, 2, 3]]);
    expect(c).toEqual([1, 2, 3]);
  });

  it("averages two vectors", () => {
    const c = computeCentroid([[1, 0], [0, 1]]);
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
  });
});
