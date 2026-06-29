import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { readGuess, autoWithGuess, filterTrainingEntries } from "@/views/feed/training-mode";

// Minimal BasesEntry stub: safeGetValue reads via entry.getValue(key).
function entry(roostId: string, category: string | null, assignedBy: string | null): BasesEntry {
  const map: Record<string, unknown> = {
    "note.roost_id": roostId,
    "note.roost_category": category,
    "note.roost_assigned_by": assignedBy,
  };
  return { getValue: (k: string) => map[k], file: { basename: roostId } } as unknown as BasesEntry;
}

describe("readGuess / autoWithGuess", () => {
  it("auto item with a category is included", () => {
    const e = entry("a", "Tech", "auto");
    expect(readGuess(e)).toEqual({ category: "Tech", assignedBy: "auto" });
    expect(autoWithGuess(e)).toBe(true);
  });
  it("missing assigned_by is treated as auto", () => {
    expect(autoWithGuess(entry("b", "Art", null))).toBe(true);
  });
  it("human item is excluded", () => {
    expect(autoWithGuess(entry("c", "Tech", "human"))).toBe(false);
  });
  it("unsorted item (no category) is excluded", () => {
    expect(autoWithGuess(entry("d", null, "auto"))).toBe(false);
    expect(autoWithGuess(entry("e", "", "auto"))).toBe(false);
  });
});

describe("filterTrainingEntries", () => {
  it("keeps auto+guess entries not in the skipped set", () => {
    const es = [entry("a", "Tech", "auto"), entry("b", "Art", "human"), entry("c", "Art", "auto")];
    const out = filterTrainingEntries(es, new Set(["c"]));
    expect(out.map((e) => (e.getValue("note.roost_id") as unknown as string))).toEqual(["a"]);
  });
});
