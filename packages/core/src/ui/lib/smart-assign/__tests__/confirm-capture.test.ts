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

  // I2: uncertain-skipped item (has a guess, but neither confirmed nor rejected)
  // must produce NO eval record — it was never resolved by the user.
  it("uncertain-skipped item (in guesses, not in itemCategory or rejects) produces no eval record", () => {
    const { evalRecords } = captureLoopUpdates({
      ts: emptyTrainingSet(),
      itemCategory: new Map([["a", "Tech\x00"]]),
      reassigned: new Map([["a", "g"]]),
      rejects: new Set<string>(),
      guesses: new Map([
        ["a", { guess: "Tech", tier: "stacked" as const }],
        ["unc", { guess: "Food", tier: "stacked" as const }], // uncertain, user never resolved
      ]),
      now: 1000,
    });
    expect(evalRecords.find((r) => r.roostId === "unc")).toBeUndefined();
  });

  // I3: a rejected item must appear in evalRecords with finalLabel === null and correct === false.
  it("rejected item eval record has finalLabel null and correct false", () => {
    const { evalRecords } = captureLoopUpdates({
      ts: emptyTrainingSet(),
      itemCategory: new Map(),
      reassigned: new Map(),
      rejects: new Set(["z"]),
      guesses: new Map([["z", { guess: "Lifestyle", tier: "stacked" as const }]]),
      now: 1000,
    });
    const rec = evalRecords.find((r) => r.roostId === "z");
    expect(rec).toBeDefined();
    expect(rec!.finalLabel).toBeNull();
    expect(rec!.correct).toBe(false);
  });
});
