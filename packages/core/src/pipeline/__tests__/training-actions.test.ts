import { describe, it, expect } from "vitest";
import { planConfirm, planReject, planReviewConfirm, planCorrection } from "@/pipeline/training-actions";
import { emptyTrainingSet } from "@/pipeline/training-set";
import type { TrainingSet } from "@/pipeline/training-set";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";

const emptyTs = (): TrainingSet => ({ version: 1, positives: {}, rejections: {} });

describe("planConfirm", () => {
  it("adds a confirm positive, stamps human, eval correct, snapshot=category", () => {
    const ts = emptyTrainingSet();
    const out = planConfirm(ts, "a", "Tech", 100);
    expect(ts.positives["a"]).toEqual({ category: "Tech", ts: 100, source: "confirm" });
    expect(out.patch).toEqual({ [ASSIGNED_BY_FIELD]: "human" });
    expect(out.snapshotValue).toBe("Tech");
    expect(out.evalRecord).toMatchObject({ roostId: "a", guess: "Tech", finalLabel: "Tech", correct: true, mode: "review" });
  });
});

describe("planReject", () => {
  it("adds a rejection, never a positive, clears fields, eval wrong, snapshot=null", () => {
    const ts = emptyTrainingSet();
    const out = planReject(ts, "b", "Tech", 200);
    expect(ts.rejections["b"]).toEqual(["Tech"]);
    expect(ts.positives["b"]).toBeUndefined();
    expect(out.patch).toEqual({ [CATEGORY_FIELD]: null, [SUBCATEGORY_FIELD]: null, [ASSIGNED_BY_FIELD]: null });
    expect(out.snapshotValue).toBeNull();
    expect(out.evalRecord).toMatchObject({ roostId: "b", guess: "Tech", finalLabel: null, correct: false, mode: "review" });
  });
});

describe("planReviewConfirm", () => {
  it("writes category + human provenance and records a confirm-source positive", () => {
    const ts = emptyTs();
    const { patch, snapshotValue, evalRecord } = planReviewConfirm(ts, "id1", "Tech", 100);
    expect(patch).toMatchObject({ roost_category: "Tech", roost_assigned_by: "human" });
    expect(snapshotValue).toBe("Tech");
    expect(ts.positives["id1"]).toMatchObject({ category: "Tech", source: "confirm" });
    expect(evalRecord).toMatchObject({ roostId: "id1", finalLabel: "Tech", correct: true, mode: "review" });
  });
});

describe("planCorrection", () => {
  it("writes the new category + human provenance and records a correction positive (not confirm-source)", () => {
    const ts = emptyTs();
    const { patch, snapshotValue } = planCorrection(ts, "id2", "Design", 100);
    expect(patch).toMatchObject({ roost_category: "Design", roost_assigned_by: "human" });
    expect(snapshotValue).toBe("Design");
    expect(ts.positives["id2"].category).toBe("Design");
    expect(ts.positives["id2"].source).not.toBe("confirm"); // a correction, capped path differs
  });
});
