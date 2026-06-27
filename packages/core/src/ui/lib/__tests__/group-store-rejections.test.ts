import { describe, it, expect } from "vitest";
import { GroupStore } from "../group-store";

describe("GroupStore rejections", () => {
  it("records and exposes rejected item ids", () => {
    const s = new GroupStore();
    s.rejectItem("a");
    s.rejectItem("a"); // idempotent
    s.rejectItem("b");
    expect(s.getRejects()).toEqual(new Set(["a", "b"]));
  });

  it("unrejectItem removes an id", () => {
    const s = new GroupStore();
    s.rejectItem("a");
    s.unrejectItem("a");
    expect(s.getRejects().has("a")).toBe(false);
  });

  it("clearProposal clears rejections", () => {
    const s = new GroupStore();
    s.rejectItem("a");
    s.clearProposal();
    expect(s.getRejects().size).toBe(0);
  });
});
