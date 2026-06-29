import { describe, it, expect } from "vitest";
import { planConfirm, planReject } from "@/pipeline/training-actions";
import { emptyTrainingSet } from "@/pipeline/training-set";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, ASSIGNED_BY_FIELD } from "@/config";

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
