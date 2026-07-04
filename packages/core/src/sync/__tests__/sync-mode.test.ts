import { describe, it, expect } from "vitest";
import { resolveSyncMode, sliceUntilKnown } from "@/sync/sync-mode";

describe("resolveSyncMode", () => {
  it("explicit full is always full", () => {
    expect(resolveSyncMode("full", true, true)).toBe("full");
    expect(resolveSyncMode("full", false, false)).toBe("full");
  });
  it("quick falls back to full on first-ever sync (no prior state)", () => {
    expect(resolveSyncMode("quick", false, false)).toBe("full");
  });
  it("quick falls back to full when the prior sync did not complete", () => {
    expect(resolveSyncMode("quick", true, false)).toBe("full");
  });
  it("quick stays quick when prior state exists and completed", () => {
    expect(resolveSyncMode("quick", true, true)).toBe("quick");
  });
});

describe("sliceUntilKnown", () => {
  const k = (...ids: string[]) => new Set(ids);
  const recs = (...ids: string[]) => ids.map((id) => ({ id }));

  it("full mode collects everything and never signals a boundary", () => {
    const r = sliceUntilKnown(recs("a", "b", "c"), k("b"), "full");
    expect(r.collect.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(r.boundary).toBe(false);
  });
  it("quick collects up to (excluding) the first known id and signals boundary", () => {
    const r = sliceUntilKnown(recs("new1", "new2", "old", "older"), k("old", "older"), "quick");
    expect(r.collect.map((x) => x.id)).toEqual(["new1", "new2"]);
    expect(r.boundary).toBe(true);
  });
  it("quick with a known id at index 0 collects nothing and signals boundary", () => {
    const r = sliceUntilKnown(recs("old", "older"), k("old", "older"), "quick");
    expect(r.collect).toEqual([]);
    expect(r.boundary).toBe(true);
  });
  it("quick with all-new collects everything, no boundary", () => {
    const r = sliceUntilKnown(recs("a", "b"), k("z"), "quick");
    expect(r.collect.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.boundary).toBe(false);
  });
  it("quick with an empty batch collects nothing, no boundary", () => {
    const r = sliceUntilKnown([], k("x"), "quick");
    expect(r.collect).toEqual([]);
    expect(r.boundary).toBe(false);
  });
});
