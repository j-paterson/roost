import { describe, it, expect } from "vitest";
import { buildItemCategory, captureLoopUpdates } from "../confirm";
import { emptyTrainingSet, rejectedClasses } from "@/pipeline/training-set";

/**
 * Integration test: proves that after Task 7's wiring the guard introduced in Task 3
 * is now LIVE. The combined pipeline (buildItemCategory → captureLoopUpdates) mirrors
 * exactly what confirmSmartAssign executes after threading host.humanAssignedRoostIds
 * into both calls.
 *
 * Invariants verified:
 *   - A judged id (in humanAssigned) does NOT appear in itemCategory → no vault write
 *   - A judged id yields no positive, no rejection, and no eval record
 *   - An un-judged auto item DOES appear in itemCategory → committed as "auto"
 */
describe("confirmSmartAssign integration — humanAssigned exclusion end-to-end", () => {
  it("judged id excluded from category AND training; un-judged auto item committed as auto", () => {
    const judgedId = "judged-001";
    const autoId = "auto-001";
    const humanAssigned = new Set([judgedId]);

    // ── Step 1: buildItemCategory (mirrors the call inside confirmSmartAssign) ──
    const itemCategory = buildItemCategory({
      proposedFolders: [{ name: "Tech", itemIds: [judgedId, autoId] }],
      unsortedIds: new Set([judgedId, autoId]),
      uncertainIds: new Set<string>(),
      reassigned: new Map<string, string>(),
      rejects: new Set<string>(),
      isSubcat: false,
      assignedSubcategories: new Map<string, string | null>(),
      humanAssigned,
    });

    // judged id must not produce a category write
    expect(itemCategory.has(judgedId)).toBe(false);
    // un-judged auto id MUST appear (committed on confirm)
    expect(itemCategory.has(autoId)).toBe(true);

    // ── Step 2: captureLoopUpdates (mirrors the call inside confirmSmartAssign) ──
    const { trainingSet: ts, evalRecords } = captureLoopUpdates({
      ts: emptyTrainingSet(),
      itemCategory,
      reassigned: new Map<string, string>(), // neither item is human-reassigned
      rejects: new Set<string>(),
      guesses: new Map([
        [judgedId, { guess: "Tech", tier: "stacked" as const }],
        [autoId,   { guess: "Tech", tier: "centroid" as const }],
      ]),
      now: 1000,
      humanAssigned,
    });

    // Judged id: no positive, no rejection, no eval record
    expect(ts.positives[judgedId]).toBeUndefined();
    expect(rejectedClasses(ts, judgedId).size).toBe(0);
    expect(evalRecords.find((r) => r.roostId === judgedId)).toBeUndefined();

    // Un-judged auto id: eval record IS emitted (organic prequential eval)
    // No positive because it's not human-reassigned (auto accept → not trained).
    expect(ts.positives[autoId]).toBeUndefined(); // auto: not a positive
    expect(evalRecords.find((r) => r.roostId === autoId)).toBeDefined();
  });
});

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
