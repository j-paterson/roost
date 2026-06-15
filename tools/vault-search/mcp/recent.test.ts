import { describe, it, expect } from "vitest";
import { RecentRing } from "./recent";

describe("RecentRing", () => {
  it("retains the most recent N entries and drops older ones", () => {
    const r = new RecentRing<number>(3);
    r.push(1); r.push(2); r.push(3); r.push(4);
    expect(r.snapshot()).toEqual([2, 3, 4]);
  });

  it("returns a copy on snapshot, not the internal buffer", () => {
    const r = new RecentRing<number>(3);
    r.push(1);
    const snap = r.snapshot();
    snap.push(99);
    expect(r.snapshot()).toEqual([1]);
  });

  it("throws on non-positive capacity", () => {
    expect(() => new RecentRing<number>(0)).toThrow();
    expect(() => new RecentRing<number>(-1)).toThrow();
  });
});
