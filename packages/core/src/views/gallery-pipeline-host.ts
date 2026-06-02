/**
 * Pipeline gallery view dispatch — mounts substitute/above views from the registry.
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
      this.handle?.dispose();
      this.deps.containerEl.style.cssText = "";
      this.handle = view.render(this.deps.containerEl, ctx);
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
