import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import { scopeBasesEntries } from "../scope-bases-entries";

function mkEntry(i: number): BasesEntry {
  return { file: { path: `${i}.md` } } as BasesEntry;
}

describe("scopeBasesEntries", () => {
  it("returns all entries when filteredIndices is null", () => {
    const entries = [mkEntry(0), mkEntry(1)];
    expect(scopeBasesEntries(entries, null)).toEqual(entries);
  });

  it("maps indices to entries", () => {
    const entries = [mkEntry(0), mkEntry(1), mkEntry(2)];
    expect(scopeBasesEntries(entries, [2, 0])).toEqual([mkEntry(2), mkEntry(0)]);
  });
});
