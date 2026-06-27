import { describe, it, expect } from "vitest";
import { captureLoopUpdates } from "../confirm";
import { emptyTrainingSet, rejectedClasses } from "@/pipeline/training-set";

describe("captureLoopUpdates", () => {
  it("adds human positives (reassigned items) only, never auto", () => {
    const { trainingSet, evalRecords } = captureLoopUpdates({
      ts: emptyTrainingSet(),
      itemCategory: new Map([["a", "Tech\x00"], ["b", "Food\x00"]]),
      reassigned: new Map([["a", "g"]]),       // a is human; b is auto-accepted
      rejects: new Set<string>(),
      guesses: new Map([["a", { guess: "Money", tier: "stacked" as const }], ["b", { guess: "Food", tier: "stacked" as const }]]),
      now: 1000,
    });
    expect(trainingSet.positives["a"]).toEqual({ category: "Tech", ts: 1000 });
    expect(trainingSet.positives["b"]).toBeUndefined(); // auto never trained
    // eval records cover both reviewed items: a was wrong (guess Money vs final Tech), b correct
    expect(evalRecords.find((r) => r.roostId === "a")!.correct).toBe(false);
    expect(evalRecords.find((r) => r.roostId === "b")!.correct).toBe(true);
  });

  it("records rejections as negatives (id ✗ guessed class)", () => {
    const { trainingSet } = captureLoopUpdates({
      ts: emptyTrainingSet(),
      itemCategory: new Map(),               // rejected item not written
      reassigned: new Map(),
      rejects: new Set(["z"]),
      guesses: new Map([["z", { guess: "Lifestyle", tier: "stacked" as const }]]),
      now: 1000,
    });
    expect(rejectedClasses(trainingSet, "z")).toEqual(new Set(["Lifestyle"]));
    expect(trainingSet.positives["z"]).toBeUndefined();
  });
});
