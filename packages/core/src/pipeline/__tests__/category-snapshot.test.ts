import { describe, it, expect } from "vitest";
import { classifyTransition, applyTransition } from "@/pipeline/category-snapshot";
import { emptyTrainingSet, rejectedClasses } from "@/pipeline/training-set";

describe("classifyTransition", () => {
  it("X→Y is a correction", () => expect(classifyTransition("Tech","Food")).toMatchObject({ kind:"correction", to:"Food" }));
  it("X→∅ is a rejection", () => expect(classifyTransition("Tech",null)).toMatchObject({ kind:"rejection", from:"Tech" }));
  it("∅→Y is a new positive", () => expect(classifyTransition(null,"Food")).toMatchObject({ kind:"new", to:"Food" }));
  it("X→X (or ∅→∅) is none", () => {
    expect(classifyTransition("Tech","Tech").kind).toBe("none");
    expect(classifyTransition(null,null).kind).toBe("none");
    expect(classifyTransition(undefined,null).kind).toBe("none");
  });
});
describe("applyTransition", () => {
  it("correction/new add a positive; rejection adds a negative", () => {
    let ts = emptyTrainingSet();
    applyTransition(ts, "a", classifyTransition("Tech","Food"), 100);
    expect(ts.positives["a"]).toEqual({ category:"Food", ts:100 });
    applyTransition(ts, "b", classifyTransition("Tech", null), 100);
    expect(rejectedClasses(ts,"b").has("Tech")).toBe(true);
    expect(ts.positives["b"]).toBeUndefined(); // never infer a positive from a rejection
  });
});
