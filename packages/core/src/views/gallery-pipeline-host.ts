/**
 * Pipeline gallery view dispatch — mounts substitute/above views from the registry.
 *
 * Both modes are structurally symmetric:
 *
 *   above      — host creates aboveContainer, inserts it before the grid,
 *                removes it on dispose/category-change.
 *
 *   substitute — host creates substituteContainer inside containerEl,
 *                passes it to the view's render(), removes it on
 *                dispose/category-change. The view never sees containerEl
 *                directly and is not responsible for DOM cleanup beyond
 *                its own internal state (inline players, etc.).
 */
import type { App, BasesEntry } from "obsidian";
import type { RoostFilter } from "@/types/roost";
import {
  getPipelineGalleryView,
  type GalleryRenderContext,
  type PipelineGalleryHandle,
} from "@/views/pipeline-views/registry";
import { scopeBasesEntries } from "@/lib/scope-bases-entries";
import { getRoostPlugin } from "@/lib/roost-plugin";
import { isCategoryPipelineActive } from "@/lib/pipeline-gate-plugin";

export interface PipelineGalleryHostDeps {
  app: App;
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  getFeedSplitHostEl: () => HTMLElement | null;
  getFilter: () => RoostFilter;
  getEntries: () => BasesEntry[];
  getFilteredIndices: () => number[] | null;
  setFilter: (filter: RoostFilter) => void;
  rerender: () => void;
  resolveImageUrl: (entry: BasesEntry) => string | null;
  resolveVideoUrl: (entry: BasesEntry) => string | null;
  pinAndFocus: (roostId: string) => void;
  setFeedActive?: (roostId: string) => void;
  renderExpandedCard: GalleryRenderContext["renderExpandedCard"];
}

export class PipelineGalleryHost {
  private handle: PipelineGalleryHandle | null = null;
  private aboveContainer: HTMLElement | null = null;
  private substituteContainer: HTMLElement | null = null;
  private dispatchedCategory: string | null = null;

  constructor(private deps: PipelineGalleryHostDeps) {}

  getHandle(): PipelineGalleryHandle | null {
    return this.handle;
  }

  dispose(): void {
    this.handle?.dispose();
    this.handle = null;
    this.aboveContainer?.remove();
    this.aboveContainer = null;
    this.substituteContainer?.remove();
    this.substituteContainer = null;
    this.dispatchedCategory = null;
  }

  /** Returns true when a substitute-mode view took over the card grid. */
  dispatch(): boolean {
    const filter = this.deps.getFilter();
    const plugin = getRoostPlugin(this.deps.app);
    const active = !!filter?.category && !!plugin && isCategoryPipelineActive(filter.category, plugin);
    const view = active ? getPipelineGalleryView(filter) : null;
    const category = filter?.category ?? null;

    const sameCategory = category && category === this.dispatchedCategory;
    if (!sameCategory) {
      this.handle?.dispose();
      this.handle = null;
      this.aboveContainer?.remove();
      this.aboveContainer = null;
      this.substituteContainer?.remove();
      this.substituteContainer = null;
      this.dispatchedCategory = null;
    }

    if (!view) return false;

    const entries = this.deps.getEntries();
    const scoped = scopeBasesEntries(entries, this.deps.getFilteredIndices());

    const ctx: GalleryRenderContext = {
      app: this.deps.app,
      entries: scoped,
      filter,
      setFilter: this.deps.setFilter,
      rerender: this.deps.rerender,
      resolveImageUrl: this.deps.resolveImageUrl,
      resolveVideoUrl: this.deps.resolveVideoUrl,
      pinAndFocus: this.deps.pinAndFocus,
      setFeedActive: this.deps.setFeedActive,
      renderExpandedCard: this.deps.renderExpandedCard,
    };

    if (view.mode === "substitute") {
      // Render UNCONDITIONALLY (incl. same-category re-dispatch): the grid
      // driver calls containerEl.empty() + dispatch() on every onDataUpdated
      // while a substitute category is active, so the view must re-render to
      // repopulate from current entries. Remove the prior wrapper first so
      // same-category re-dispatch refreshes without accumulating wrappers
      // (in production empty() already detached it; .remove() is then a no-op).
      this.handle?.dispose();
      this.substituteContainer?.remove();
      // Reset grid inline style so the substitute wrapper claims full height.
      // The wrapper's .roost-media-list-host class handles flex layout via CSS.
      this.deps.containerEl.style.cssText = "";
      this.substituteContainer = document.createElement("div");
      this.substituteContainer.className = "roost-media-list-host";
      this.substituteContainer.style.cssText = "height:100%;min-height:0;";
      this.deps.containerEl.appendChild(this.substituteContainer);
      this.handle = view.render(this.substituteContainer, ctx);
      this.dispatchedCategory = category;
      return true;
    }

    if (!sameCategory) {
      this.aboveContainer = document.createElement("div");
      const feedSplitHostEl = this.deps.getFeedSplitHostEl();
      const outerColumn = feedSplitHostEl
        ? feedSplitHostEl.parentElement
        : this.deps.scrollEl.parentElement;
      const anchor = feedSplitHostEl ?? this.deps.scrollEl;
      outerColumn?.insertBefore(this.aboveContainer, anchor);
      this.handle = view.render(this.aboveContainer, ctx);
      this.dispatchedCategory = category;
    }
    return false;
  }
}
