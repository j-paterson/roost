/**
 * Pipeline gallery host wiring for the bookmarks Bases view.
 */
import type { App, BasesEntry } from "obsidian";
import {
  mountExpandedCardActions,
  mountExpandedCardHost,
  type EntryMediaResolvers,
} from "@/views/entry-to-expanded-card";
import { PipelineGalleryHost } from "@/views/gallery-pipeline-host";
import type { RoostFilter } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";
import type { GalleryCardConfig } from "@/views/gallery-cards";

export interface BookmarksPipelineHostDeps {
  app: App;
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  cfg: GalleryCardConfig;
  getFeedSplitHostEl: () => HTMLElement | null;
  getFilter: () => RoostFilter;
  getEntries: () => BasesEntry[];
  getFilteredIndices: () => number[] | null;
  getRoostPlugin: () => IRoostPlugin | null;
  mediaResolvers: () => EntryMediaResolvers;
  onRerender: () => void;
  onPinAndFocus: (roostId: string) => void;
  onSetFeedActive: (roostId: string) => void;
  onMove: (entry: BasesEntry) => void;
}

export function createBookmarksPipelineHost(
  deps: BookmarksPipelineHostDeps,
): PipelineGalleryHost {
  return new PipelineGalleryHost({
    app: deps.app,
    containerEl: deps.containerEl,
    scrollEl: deps.scrollEl,
    getFeedSplitHostEl: deps.getFeedSplitHostEl,
    getFilter: deps.getFilter,
    getEntries: deps.getEntries,
    getFilteredIndices: deps.getFilteredIndices,
    setFilter: (filter) => deps.getRoostPlugin()?.setFilter(filter),
    rerender: deps.onRerender,
    resolveImageUrl: (entry) =>
      deps.mediaResolvers().resolveImageUrl(entry, deps.cfg.imagePropId),
    resolveVideoUrl: (entry) => deps.mediaResolvers().resolveVideoUrl(entry),
    pinAndFocus: deps.onPinAndFocus,
    setFeedActive: deps.onSetFeedActive,
    renderExpandedCard: (container, entry) => {
      const cleanup = mountExpandedCardHost(container, entry, deps.mediaResolvers());
      const plugin = deps.getRoostPlugin();
      mountExpandedCardActions(container, {
        entry,
        app: deps.app,
        onMove: deps.onMove,
        onDelete: plugin
          ? (roostId) => plugin.fireItemClick({ action: "delete", roostId })
          : undefined,
      });
      return cleanup;
    },
  });
}
