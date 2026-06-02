import type { BasesEntry } from "obsidian";

/** Scope raw Bases data to the indices selected by the active gallery filter. */
export function scopeBasesEntries(
  entries: BasesEntry[],
  filteredIndices: number[] | null,
): BasesEntry[] {
  return filteredIndices
    ? filteredIndices.map((i) => entries[i]).filter(Boolean)
    : entries;
}
