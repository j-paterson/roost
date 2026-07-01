import { describe, it, expect } from "vitest";
import { selectTrainingPositives } from "@/pipeline/train-head";

const P = (category: string, ts: number, source?: "correction" | "confirm") => ({ category, ts, source });

describe("selectTrainingPositives", () => {
  it("admits all correction positives, uncapped", () => {
    const positives = { a: P("Tech", 1), b: P("Tech", 2), c: P("Tech", 3) };
    const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("caps confirms at ratio × corrections per class", () => {
    // Tech: 1 correction → cap = 2 confirms admitted out of 4
    const positives = {
      k: P("Tech", 1, "correction"),
      a: P("Tech", 2, "confirm"), b: P("Tech", 3, "confirm"),
      c: P("Tech", 4, "confirm"), d: P("Tech", 5, "confirm"),
    };
    const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
    const confirms = out.filter((r) => r.id !== "k");
    expect(out.some((r) => r.id === "k")).toBe(true); // correction always admitted
    expect(confirms.length).toBe(2);                  // 2.0 × 1 correction
    // earliest-ts confirms admitted (sort-direction-sensitive: c,d have later ts)
    expect(confirms.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("a class with 0 corrections admits 0 confirms (cannot build a class alone)", () => {
    const positives = { a: P("Art", 1, "confirm"), b: P("Art", 2, "confirm") };
    const out = selectTrainingPositives(positives, new Set(["Art"]), 2.0);
    expect(out).toEqual([]);
  });

  it("excludes positives whose category is not eligible", () => {
    const positives = { a: P("Tech", 1, "correction"), b: P("Rare", 2, "correction") };
    const out = selectTrainingPositives(positives, new Set(["Tech"]), 2.0);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
});

