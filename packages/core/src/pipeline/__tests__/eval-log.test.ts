import { describe, it, expect } from "vitest";
import { excludeReview, fadingWindowAccuracy, parseEvalLines, type EvalRecord } from "@/pipeline/eval-log";

describe("excludeReview", () => {
  const rec = (roostId: string, mode?: "review"): EvalRecord => ({
    ts: 1, roostId, guess: "Tech", tier: "stacked", finalLabel: "Tech", correct: true,
    ...(mode ? { mode } : {}),
  });

  it("excludeReview drops mode:'review' records, keeps organic ones", () => {
    const recs = [rec("a"), rec("b", "review"), rec("c")];
    expect(excludeReview(recs).map((r) => r.roostId)).toEqual(["a", "c"]);
  });

  it("mode survives JSONL round-trip", () => {
    const line = JSON.stringify(rec("x", "review"));
    expect(parseEvalLines(line)[0].mode).toBe("review");
  });
});

function rec(ts: number, guess: string, tier: EvalRecord["tier"], final: string): EvalRecord {
  return { ts, roostId: `${ts}-${guess}`, guess, tier, finalLabel: final, correct: guess === final };
}

describe("parseEvalLines", () => {
  it("returns both valid records when one line is garbage", () => {
    const line1 = JSON.stringify(rec(1, "Food", "stacked", "Food"));
    const line2 = JSON.stringify(rec(2, "Tech", "centroid", "Tech"));
    const raw = [line1, "NOT_VALID_JSON{{{", line2].join("\n");
    const result = parseEvalLines(raw);
    expect(result).toHaveLength(2);
    expect(result[0].roostId).toBe("1-Food");
    expect(result[1].roostId).toBe("2-Tech");
  });

  it("returns [] for empty string", () => {
    expect(parseEvalLines("")).toEqual([]);
  });
});

describe("fadingWindowAccuracy", () => {
  it("weights recent batches more than old ones", () => {
    // batch ts=1 (old): all wrong;  batch ts=2 (recent): all right
    const records = [
      rec(1, "Tech", "stacked", "Food"),
      rec(1, "Tech", "stacked", "Food"),
      rec(2, "Food", "stacked", "Food"),
      rec(2, "Food", "stacked", "Food"),
    ];
    const a = fadingWindowAccuracy(records, 1); // half-life 1 batch
    // recent batch (right) weighted 2x the old (wrong) → accuracy > 0.5
    expect(a.overall).toBeGreaterThan(0.5);
  });

  it("segments by tier and by final-label class", () => {
    const records = [
      rec(1, "Tech", "stacked", "Tech"),     // correct, tier stacked, class Tech
      rec(1, "Food", "centroid", "Money"),   // wrong, tier centroid, class Money
    ];
    const a = fadingWindowAccuracy(records, 5);
    expect(a.byTier["stacked"]).toBe(1);
    expect(a.byTier["centroid"]).toBe(0);
    expect(a.byClass["Tech"]).toBe(1);
    expect(a.byClass["Money"]).toBe(0);
  });

  it("returns 0 buckets safely for empty input", () => {
    const a = fadingWindowAccuracy([], 5);
    expect(a.overall).toBe(0);
    expect(a.byTier).toEqual({});
  });
});
