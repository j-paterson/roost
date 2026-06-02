/**
 * Gallery expand/focus helpers — neighbor navigation after delete, in-place expand.
 */
import type { BasesEntry } from "obsidian";
import { getRoostId } from "@/lib/bases-entry";
import {
  clearStaleGalleryExpand,
  type GalleryExpandState,
} from "@/views/gallery-expanded";

export interface GalleryExpandFocusActions {
  hydrateCard(el: HTMLElement, index: number): void;
  toggleExpandedCard(cardEl: HTMLElement, entry: BasesEntry): void;
  getEntryByIndex(index: number): BasesEntry | null;
}

export interface GalleryExpandFocusHost extends GalleryExpandFocusActions {
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  expandState: GalleryExpandState;
}

/** Next roost_id after delete (following item, else previous). */
export function findNeighborRoostId(
  entries: BasesEntry[],
  filteredIndices: number[] | null,
  currentRoostId: string,
): string | null {
  const indices =
    filteredIndices ?? Array.from({ length: entries.length }, (_, i) => i);
  const posInFilter = indices.findIndex(
    (i) => getRoostId(entries[i]) === currentRoostId,
  );
  if (posInFilter < 0) return null;
  const neighbor = indices[posInFilter + 1] ?? indices[posInFilter - 1];
  if (neighbor == null) return null;
  return getRoostId(entries[neighbor]);
}

function hydrateCardIfNeeded(
  host: GalleryExpandFocusHost,
  el: HTMLElement,
): void {
  const idxStr = el.dataset.idx;
  if (idxStr == null || el.dataset.hydrated) return;
  el.dataset.hydrated = "1";
  host.hydrateCard(el, parseInt(idxStr, 10));
}

/** Expand a card by roost_id without scrolling (post-delete neighbor). */
export function expandGalleryInPlaceById(
  host: GalleryExpandFocusHost,
  roostId: string,
): void {
  clearStaleGalleryExpand(host.expandState);
  requestAnimationFrame(() => {
    const cards = Array.from(
      host.containerEl.querySelectorAll(".roost-card"),
    ) as HTMLElement[];
    for (const el of cards) {
      const idxStr = el.dataset.idx;
      if (idxStr == null) continue;
      hydrateCardIfNeeded(host, el);
      if (el.dataset.roostId === roostId) {
        const entry = host.getEntryByIndex(parseInt(idxStr, 10));
        if (entry) host.toggleExpandedCard(el, entry);
        return;
      }
    }
  });
}

/** Scroll to top and expand index-0 when it matches roostId (map pin / pin sort). */
export function focusAndExpandGalleryCard(
  host: GalleryExpandFocusHost,
  roostId: string,
): void {
  host.scrollEl.scrollTop = 0;
  clearStaleGalleryExpand(host.expandState);
  requestAnimationFrame(() => {
    const el = host.containerEl.querySelector(
      `.roost-card[data-idx="0"]`,
    ) as HTMLElement | null;
    if (!el) return;
    hydrateCardIfNeeded(host, el);
    if (el.dataset.roostId !== roostId) return;
    const entry = host.getEntryByIndex(0);
    if (entry) host.toggleExpandedCard(el, entry);
  });
}
