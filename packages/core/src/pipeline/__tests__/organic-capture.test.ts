import { describe, it, expect } from "vitest";
import { captureEdit } from "@/pipeline/organic-capture";
import { emptyTrainingSet, rejectedClasses } from "@/pipeline/training-set";

describe("captureEdit (own-write guard + capture)", () => {
  it("ignores a write that matches the snapshot (our own write / echo)", () => {
    const r = captureEdit({ snapshot: { a: "Tech" }, ts: emptyTrainingSet(), id: "a", newCategory: "Tech", now: 1 });
    expect(r.changed).toBe(false);
    expect(r.ts.positives["a"]).toBeUndefined();
  });
  it("captures a correction that differs from the snapshot and updates the snapshot", () => {
    const r = captureEdit({ snapshot: { a: "Tech" }, ts: emptyTrainingSet(), id: "a", newCategory: "Food", now: 5 });
    expect(r.changed).toBe(true);
    expect(r.ts.positives["a"]).toEqual({ category: "Food", ts: 5 });
    expect(r.snapshot["a"]).toBe("Food");
  });
  it("captures a clear as a rejection", () => {
    const r = captureEdit({ snapshot: { a: "Tech" }, ts: emptyTrainingSet(), id: "a", newCategory: null, now: 5 });
    expect(r.changed).toBe(true);
    expect(rejectedClasses(r.ts, "a").has("Tech")).toBe(true);
    expect(r.snapshot["a"]).toBe(null);
  });
});
