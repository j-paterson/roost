import type { BasesEntry } from "obsidian";
import { safeGetValue, getRoostId } from "@/lib/bases-entry";

export function readGuess(entry: BasesEntry): { category: string | null; assignedBy: "human" | "auto" } {
  const cat = safeGetValue(entry, "note.roost_category")?.toString()?.trim() || null;
  const assignedBy = safeGetValue(entry, "note.roost_assigned_by")?.toString() === "human" ? "human" : "auto";
  return { category: cat, assignedBy };
}

/** A machine-introduced item with a concrete guess to judge: auto provenance + a category. */
export function autoWithGuess(entry: BasesEntry): boolean {
  const { category, assignedBy } = readGuess(entry);
  return assignedBy !== "human" && category !== null;
}

export function filterTrainingEntries(entries: BasesEntry[], skipped: Set<string>): BasesEntry[] {
  return entries.filter((e) => autoWithGuess(e) && !skipped.has(getRoostId(e)));
}
