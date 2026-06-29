import { describe, it, expect } from "vitest";
import {
  emptyTrainingSet, addPositive, addRejection, rejectedClasses,
  suppressionMap, categoryCounts, eligibleCategories,
} from "@/pipeline/training-set";

it("addPositive defaults to no source (correction) and back-compat shape", () => {
  const ts = addPositive(emptyTrainingSet(), "a", "Tech", 5);
  expect(ts.positives["a"]).toEqual({ category: "Tech", ts: 5 });
  expect("source" in ts.positives["a"]).toBe(false);
});

it("addPositive records source:'confirm' when passed", () => {
  const ts = addPositive(emptyTrainingSet(), "b", "Art", 7, "confirm");
  expect(ts.positives["b"]).toEqual({ category: "Art", ts: 7, source: "confirm" });
});

it("addPositive(confirm) still clears that class from the item's rejections", () => {
  const ts = emptyTrainingSet();
  ts.rejections["c"] = ["Art", "Tech"];
  addPositive(ts, "c", "Art", 9, "confirm");
  expect(ts.rejections["c"]).toEqual(["Tech"]);
});

describe("training-set", () => {
  it("records positives keyed by id, latest-human-wins", () => {
    let ts = emptyTrainingSet();
    ts = addPositive(ts, "a", "Tech", 100);
    ts = addPositive(ts, "a", "Money", 200); // correction overrides
    expect(ts.positives["a"]).toEqual({ category: "Money", ts: 200 });
    expect(categoryCounts(ts)).toEqual({ Money: 1 });
  });

  it("accumulates rejections as a per-item set, no positive inferred", () => {
    let ts = emptyTrainingSet();
    ts = addRejection(ts, "a", "Tech");
    ts = addRejection(ts, "a", "Tech"); // dedup
    ts = addRejection(ts, "a", "Food");
    expect(rejectedClasses(ts, "a")).toEqual(new Set(["Tech", "Food"]));
    expect(ts.positives["a"]).toBeUndefined(); // never inferred
  });

  it("an explicit positive pick clears that class from the item's rejections", () => {
    let ts = emptyTrainingSet();
    ts = addRejection(ts, "a", "Tech");
    ts = addPositive(ts, "a", "Tech", 300); // user later affirms Tech
    expect(rejectedClasses(ts, "a").has("Tech")).toBe(false);
  });

  it("suppressionMap exposes id → rejected set for scoring", () => {
    let ts = emptyTrainingSet();
    ts = addRejection(ts, "x", "Lifestyle");
    const m = suppressionMap(ts);
    expect(m.get("x")).toEqual(new Set(["Lifestyle"]));
  });

  it("eligibleCategories returns classes at or above the floor", () => {
    let ts = emptyTrainingSet();
    for (let i = 0; i < 5; i++) ts = addPositive(ts, `t${i}`, "Tech", i);
    for (let i = 0; i < 4; i++) ts = addPositive(ts, `f${i}`, "Food", i);
    expect(eligibleCategories(ts, 5)).toEqual(["Tech"]);
  });
});
