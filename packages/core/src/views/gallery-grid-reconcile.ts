/**
 * Incremental gallery grid reconciliation — keep hydrated cards by roost_id,
 * drop removed entries, append placeholders for new ones, reorder DOM to
 * match the filtered index order, and refresh metadata on kept cards.
 */
import type { BasesEntry } from "obsidian";
import { safeGetValue } from "@/lib/bases-entry";
import { traceEvent } from "@/lib/render-trace";

export interface ReconcileStandardGridArgs {
  containerEl: HTMLElement;
  entries: BasesEntry[];
  indices: number[];
  newTotal: number;
  filteredCount: number | null;
  estimatedHeight: number;
  hydrationObserver: IntersectionObserver | null;
  createPlaceholder: (parent: HTMLElement, index: number, height: number) => void;
  syncKeptCard: (card: HTMLElement, entry: BasesEntry) => void;
}

export interface ReconcileStandardGridResult {
  kept: number;
  removed: number;
  added: number;
}

export function reconcileStandardGrid(
  args: ReconcileStandardGridArgs,
): ReconcileStandardGridResult {
  const {
    containerEl, entries, indices, newTotal, filteredCount,
    estimatedHeight, hydrationObserver, createPlaceholder, syncKeptCard,
  } = args;

  const newEntryIds = new Set<string>();
  for (const idx of indices) {
    const e = entries[idx];
    if (!e) continue;
    const rid = safeGetValue(e, "note.roost_id")?.toString();
    if (rid) newEntryIds.add(rid);
  }

  const keptCardsByRid = new Map<string, HTMLElement>();
  let removed = 0;
  for (const card of containerEl.querySelectorAll<HTMLElement>(".roost-card-ready[data-roost-id]")) {
    const rid = card.dataset.roostId!;
    if (newEntryIds.has(rid)) keptCardsByRid.set(rid, card);
    else { card.remove(); removed++; }
  }

  for (const ph of containerEl.querySelectorAll<HTMLElement>(".roost-card:not(.roost-card-ready)")) {
    ph.remove();
  }

  const kept = keptCardsByRid.size;
  const added = newTotal - kept;

  traceEvent("onDataUpdated:rebuild", {
    filteredCount,
    entriesLen: entries.length,
    reconciled: true,
    kept,
    removed,
    added,
  });

  hydrationObserver?.disconnect();
  let placeholderIdx = 0;
  for (const idx of indices) {
    const e = entries[idx];
    if (!e) continue;
    const rid = safeGetValue(e, "note.roost_id")?.toString();
    const existing = rid ? keptCardsByRid.get(rid) : undefined;
    if (existing) {
      existing.dataset.idx = String(placeholderIdx);
      syncKeptCard(existing, e);
      containerEl.appendChild(existing);
    } else {
      createPlaceholder(containerEl, placeholderIdx, estimatedHeight);
    }
    placeholderIdx++;
  }

  return { kept, removed, added };
}
