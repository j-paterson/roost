/**
 * In-grid FLIP expand/collapse for bookmark cards.
 */
import { animate } from "motion";
import type { BasesEntry } from "obsidian";
import { safeGetValue } from "@/lib/bases-entry";
import type { MatchDetail } from "@/types/roost";
import {
  mountExpandedCardActions,
  mountExpandedCardHost,
  mountExpandedCloseButton,
  type EntryMediaResolvers,
} from "@/views/entry-to-expanded-card";
import { buildExpandedExtraElements } from "@/views/gallery-expanded-extras";
import type { App } from "obsidian";

export interface GalleryExpandState {
  expandedEl: HTMLElement | null;
  expandedCleanup: (() => void) | null;
  savedCardContent: DocumentFragment | null;
}

export function createGalleryExpandState(): GalleryExpandState {
  return { expandedEl: null, expandedCleanup: null, savedCardContent: null };
}

/** Drop expand state when the grid rebuild removed the expanded card from the DOM. */
export function clearStaleGalleryExpand(state: GalleryExpandState): void {
  if (state.expandedEl && !state.expandedEl.isConnected) {
    state.expandedCleanup?.();
    state.expandedCleanup = null;
    state.expandedEl = null;
    state.savedCardContent = null;
  }
}

export function closeGalleryExpanded(state: GalleryExpandState): void {
  if (!state.expandedEl || !state.savedCardContent) return;
  state.expandedCleanup?.();
  state.expandedCleanup = null;
  const el = state.expandedEl;
  const first = el.getBoundingClientRect();

  el.empty();
  el.appendChild(state.savedCardContent);
  el.classList.remove("roost-expanded");

  const last = el.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sw = last.width > 0 ? first.width / last.width : 1;
  const sh = last.height > 0 ? first.height / last.height : 1;

  if (isFinite(dx) && isFinite(dy) && isFinite(sw) && isFinite(sh)) {
    animate(el, {
      x: [dx, 0],
      y: [dy, 0],
      scaleX: [sw, 1],
      scaleY: [sh, 1],
      opacity: [0.7, 1],
    }, {
      type: "spring",
      stiffness: 300,
      damping: 30,
    });
  }

  state.expandedEl = null;
  state.savedCardContent = null;
}

export interface ToggleGalleryExpandedOpts {
  app: App;
  entry: BasesEntry;
  domHost: HTMLElement;
  matchDetailMap: Map<string, MatchDetail> | null;
  mediaResolvers: EntryMediaResolvers;
  onPipelineExpand?: (roostId: string) => void;
  onCollectionClick: (entry: BasesEntry) => void;
  onMove: (entry: BasesEntry) => void;
  onDelete?: (roostId: string) => void;
}

/** Expand card in-place with FLIP; collapses previous expanded card first. */
export function toggleGalleryExpanded(
  state: GalleryExpandState,
  cardEl: HTMLElement,
  opts: ToggleGalleryExpandedOpts,
): void {
  const { entry, mediaResolvers, matchDetailMap } = opts;

  if (state.expandedEl === cardEl) {
    closeGalleryExpanded(state);
    return;
  }

  const first = cardEl.getBoundingClientRect();
  closeGalleryExpanded(state);

  state.savedCardContent = document.createDocumentFragment();
  while (cardEl.firstChild) {
    state.savedCardContent.appendChild(cardEl.firstChild);
  }

  cardEl.classList.add("roost-expanded");
  state.expandedEl = cardEl;

  const expandedId = safeGetValue(entry, "note.roost_id")?.toString();
  if (expandedId) opts.onPipelineExpand?.(expandedId);

  const extraEls = buildExpandedExtraElements({
    entry,
    domHost: opts.domHost,
    matchDetailMap,
    onCollectionClick: opts.onCollectionClick,
  });

  state.expandedCleanup = mountExpandedCardHost(cardEl, entry, mediaResolvers, extraEls);
  mountExpandedCloseButton(cardEl, () => closeGalleryExpanded(state));

  mountExpandedCardActions(cardEl, {
    entry,
    app: opts.app,
    onMove: opts.onMove,
    onDelete: expandedId ? opts.onDelete : undefined,
  });

  cardEl.offsetHeight;
  const last = cardEl.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sw = last.width > 0 ? first.width / last.width : 1;
  const sh = last.height > 0 ? first.height / last.height : 1;

  if (isFinite(dx) && isFinite(dy) && isFinite(sw) && isFinite(sh)) {
    animate(cardEl, {
      x: [dx, 0],
      y: [dy, 0],
      scaleX: [sw, 1],
      scaleY: [sh, 1],
      opacity: [0.7, 1],
    }, {
      type: "spring",
      stiffness: 300,
      damping: 30,
    });
  }

  cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
}
