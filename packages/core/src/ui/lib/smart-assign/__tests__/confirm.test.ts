import { describe, it, expect } from "vitest";
import { buildItemCategory, captureLoopUpdates } from "../confirm";
import { emptyTrainingSet, rejectedClasses } from "@/pipeline/training-set";

describe("buildItemCategory excludes judged ids", () => {
  it("omits any id in humanAssigned", () => {
    const out = buildItemCategory({
      proposedFolders: [{ name: "Tech", itemIds: ["keep", "judged"] }],
      unsortedIds: new Set(["keep", "judged"]),
      uncertainIds: new Set<string>(),
      reassigned: new Map<string, string>(),
      rejects: new Set<string>(),
      isSubcat: false,
      assignedSubcategories: new Map<string, string | null>(),
      humanAssigned: new Set(["judged"]),
    });
    expect(out.has("keep")).toBe(true);
    expect(out.has("judged")).toBe(false);
  });
});

describe("captureLoopUpdates excludes judged ids", () => {
  it("an id in humanAssigned yields no positive, no rejection, and no eval record even when present in reassigned/rejects/guesses", () => {
    const judgedId = "already-reviewed";

    const { trainingSet, evalRecords } = captureLoopUpdates({
      ts: emptyTrainingSet(),
      // judgedId appears in itemCategory (would normally trigger positive since it's in reassigned)
      itemCategory: new Map([[judgedId, "Tech\x00"]]),
      // judgedId is human-provenance (would normally become a positive)
      reassigned: new Map([[judgedId, "g"]]),
      // judgedId also appears in rejects (would normally trigger rejection + eval)
      rejects: new Set([judgedId]),
      // judgedId has a guess (would normally trigger eval record)
      guesses: new Map([[judgedId, { guess: "Tech", tier: "stacked" as const }]]),
      now: 1000,
      humanAssigned: new Set([judgedId]),
    });

    // No positive captured
    expect(trainingSet.positives[judgedId]).toBeUndefined();
    // No rejection captured
    expect(rejectedClasses(trainingSet, judgedId).size).toBe(0);
    // No eval record captured
    expect(evalRecords.find((r) => r.roostId === judgedId)).toBeUndefined();
  });
});
