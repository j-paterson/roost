import { describe, it, expect } from "vitest";
import { humanOtherIds } from "@/plugin/seed-belongs-nothing";

describe("humanOtherIds", () => {
  it("selects a human-labelled collection:'Other' item", () => {
    const ids = humanOtherIds([{ id: "a1", collection: "Other", assignedBy: "human" }]);
    expect(ids).toEqual(["a1"]);
  });

  it("excludes an auto-assigned 'Other' item", () => {
    const ids = humanOtherIds([{ id: "a2", collection: "Other", assignedBy: "auto" }]);
    expect(ids).toEqual([]);
  });

  it("excludes an already-belongs-nothing item", () => {
    const ids = humanOtherIds([
      { id: "a3", collection: "Other", assignedBy: "human", belongsNothing: true },
    ]);
    expect(ids).toEqual([]);
  });

  it("excludes a real-category collection", () => {
    const ids = humanOtherIds([{ id: "a4", collection: "Finance", assignedBy: "human" }]);
    expect(ids).toEqual([]);
  });

  it("is case-insensitive on collection value", () => {
    const ids = humanOtherIds([{ id: "a5", collection: "other", assignedBy: "human" }]);
    expect(ids).toEqual(["a5"]);
  });

  it("handles all cases together — non-vacuous selection", () => {
    const items = [
      { id: "a1", collection: "Other", assignedBy: "human" },          // selected
      { id: "a2", collection: "Other", assignedBy: "auto" },            // excluded: auto
      { id: "a3", collection: "Other", assignedBy: "human", belongsNothing: true }, // excluded: already stamped
      { id: "a4", collection: "Finance", assignedBy: "human" },         // excluded: real category
      { id: "a5", collection: "other", assignedBy: "human" },           // selected: lowercase match
    ];
    expect(humanOtherIds(items)).toEqual(["a1", "a5"]);
  });

  it("excludes items with no collection", () => {
    const ids = humanOtherIds([{ id: "a6", collection: null, assignedBy: "human" }]);
    expect(ids).toEqual([]);
  });

  it("excludes items with undefined collection", () => {
    const ids = humanOtherIds([{ id: "a7", assignedBy: "human" }]);
    expect(ids).toEqual([]);
  });
});
