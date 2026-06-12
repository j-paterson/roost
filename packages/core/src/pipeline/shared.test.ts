import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  fusedSimilarity,
  computeCentroid,
  forEachBatch,
  withLLMRetry,
} from "./shared";

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

describe("forEachBatch", () => {
  it("visits every item exactly once, in order, in chunks of the given size", async () => {
    const seen: Array<{ batch: number[]; startIndex: number }> = [];
    await forEachBatch([1, 2, 3, 4, 5], 2, async (batch, startIndex) => {
      seen.push({ batch: [...batch], startIndex });
    });
    expect(seen).toEqual([
      { batch: [1, 2], startIndex: 0 },
      { batch: [3, 4], startIndex: 2 },
      { batch: [5], startIndex: 4 },
    ]);
  });

  it("runs batches sequentially — batch N+1 starts only after batch N's promise resolves", async () => {
    const order: string[] = [];
    await forEachBatch([1, 2], 1, async (batch) => {
      order.push(`start:${batch[0]}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${batch[0]}`);
    });
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("does nothing for an empty list", async () => {
    let calls = 0;
    await forEachBatch([], 3, async () => { calls++; });
    expect(calls).toBe(0);
  });

  it("propagates a rejection from the batch body", async () => {
    await expect(
      forEachBatch([1], 1, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
  });
});

describe("withLLMRetry", () => {
  it("returns the first non-null result without further attempts", async () => {
    let calls = 0;
    const result = await withLLMRetry(async () => { calls++; return "ok"; }, "fallback");
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on null and returns the second attempt's result", async () => {
    let calls = 0;
    const result = await withLLMRetry(async () => {
      calls++;
      return calls === 1 ? null : "second";
    }, "fallback");
    expect(result).toBe("second");
    expect(calls).toBe(2);
  });

  it("returns the fallback after all attempts produce null (default 2 attempts)", async () => {
    let calls = 0;
    const result = await withLLMRetry(async () => { calls++; return null; }, "fallback");
    expect(result).toBe("fallback");
    expect(calls).toBe(2);
  });

  it("honors a custom attempt count", async () => {
    let calls = 0;
    await withLLMRetry(async () => { calls++; return null; }, "fb", 4);
    expect(calls).toBe(4);
  });

  it("does NOT catch throws — a rejection propagates immediately", async () => {
    let calls = 0;
    await expect(
      withLLMRetry(async () => { calls++; throw new Error("ollama down"); }, "fb"),
    ).rejects.toThrow("ollama down");
    expect(calls).toBe(1); // no retry on throw — matches the bespoke loops it replaces
  });
});
