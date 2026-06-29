import { describe, it, expect } from "vitest";
import { parseRetrainLines } from "@/pipeline/retrain-log";

describe("parseRetrainLines", () => {
  it("parses valid lines, skips garbage", () => {
    const raw =
      JSON.stringify({ ts: 1, ran: true, swapped: true, reason: "gate passed" }) +
      "\nGARBAGE\n" +
      JSON.stringify({ ts: 2, ran: true, swapped: false, reason: "gate failed" }) +
      "\n";
    const recs = parseRetrainLines(raw);
    expect(recs.length).toBe(2);
    expect(recs[1].swapped).toBe(false);
  });

  it("handles empty string", () => {
    expect(parseRetrainLines("")).toEqual([]);
  });

  it("carries optional delta fields when present", () => {
    const rec = {
      ts: 3,
      ran: true,
      swapped: false,
      reason: "gate failed",
      avgOverallDelta: -0.02,
      avgMacroDelta: -0.05,
      catastrophic: ["Movies"],
    };
    const recs = parseRetrainLines(JSON.stringify(rec) + "\n");
    expect(recs.length).toBe(1);
    expect(recs[0].catastrophic).toEqual(["Movies"]);
    expect(recs[0].avgMacroDelta).toBeCloseTo(-0.05);
  });
});
