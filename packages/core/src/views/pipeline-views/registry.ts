/**
 * Registry for pipeline-specific gallery views.
 *
 * When a user filters the gallery to a pipeline's category (Media,
 * Places, etc.), the gallery looks up that category here and dispatches
 * to a custom render function instead of (or alongside) its default card
 * grid. Adding a new pipeline visualization is one new entry in this
 * registry — no surgery on bookmarks-bases-view.ts.
 *
 * Two modes are supported:
 *
 *   - substitute — replaces the card grid entirely. Used by text-dense
 *     visualizations like Media's sortable table.
 *
 *   - above — mounts above the card grid, which continues to render
 *     normally below. Used by overlay visualizations like the Places
 *     map.
 *
 * The render fn returns a handle with a dispose callback (always called
 * when the filter changes away from this view's category) and optional
 * onExpand hook (called when a card is expanded inline — the Places map
 * uses this to focus the matching pin).
 */
import type { App } from "obsidian";
import type { BasesEntry } from "obsidian";
import type { RoostFilter } from "@/types/roost";

export type PipelineGalleryMode = "substitute" | "above";

export interface PipelineGalleryView {
  mode: PipelineGalleryMode;
  render: (container: HTMLElement, ctx: GalleryRenderContext) => PipelineGalleryHandle;
}

export interface GalleryRenderContext {
  app: App;
  /** Entries already scoped to the active filter. */
  entries: BasesEntry[];
  filter: RoostFilter;
  /** Update the global plugin filter — used by "above"-mode views (like
   *  the Places map) to re-filter the gallery below on user interaction. */
  setFilter: (filter: RoostFilter) => void;
  /** Trigger a re-render of the current view. Used by views with internal
   *  interactive state (e.g. sort column) so a click can re-flow data. */
  rerender: () => void;
  /** Resolve a cover image URL for an entry the same way gallery cards do.
   *  Pin thumbnails on the Places map use this to match what the user
   *  sees on cards. */
  resolveImageUrl: (entry: BasesEntry) => string | null;
  /** Resolve a local video URL for an entry (vault resource path, e.g.
   *  `app://...media.mp4`). Returns null when no cached video exists.
   *  Used by inline players that want to play the source bookmark's
   *  audio directly instead of searching an external service. */
  resolveVideoUrl: (entry: BasesEntry) => string | null;
  /** Pin a roost_id to the top of the next card render and expand it in
   *  place. Used by "above"-mode views like the Places map when a user
   *  clicks a pin — the click should also focus the matching gallery card
   *  below. Has no effect if no card render follows (substitute mode). */
  pinAndFocus: (roostId: string) => void;
  /** Render the gallery's expanded-card view for a given entry into the
   *  supplied container. Returns a cleanup fn the caller invokes before
   *  re-rendering or switching to a different entry. Lets substitute-mode
   *  views (Media list) show a master-detail layout — table left, expanded
   *  card right — without duplicating the gallery's media + frontmatter
   *  resolution logic. */
  renderExpandedCard: (container: HTMLElement, entry: BasesEntry) => () => void;
  /** Fire the feed pane's active item — only present when the gallery's
   *  viewMode is "feed". Pipeline views (e.g. media-list) call this from
   *  row-click handlers so the right-side feed pane snaps to the clicked
   *  item instead of having to render their own detail pane. */
  setFeedActive?: (roostId: string) => void;
}

export interface PipelineGalleryHandle {
  /** Called when the active filter changes away from this view's
   *  category (or on view unload). Tear down listeners, DOM, etc. */
  dispose: () => void;
  /** Called when the gallery expands a card inline. The Places map uses
   *  this to focus the matching pin; substitute-mode views can ignore. */
  onExpand?: (roostId: string) => void;
}

const REGISTRY: Record<string, PipelineGalleryView> = {};

export function registerPipelineGalleryView(category: string, view: PipelineGalleryView): void {
  REGISTRY[category] = view;
}

export function getPipelineGalleryView(filter: RoostFilter | null | undefined): PipelineGalleryView | null {
  if (!filter?.category) return null;
  return REGISTRY[filter.category] ?? null;
}

/** Pure predicate — true when the active filter uses a substitute-mode pipeline view. */
export function isPipelineSubstituteView(filter: RoostFilter | null | undefined): boolean {
  return getPipelineGalleryView(filter)?.mode === "substitute";
}

/**
 * TEST ONLY — clears the pipeline gallery view registry between test cases.
 * Never call from production code.
 */
export function _testOnlyResetRegistry(): void {
  for (const key of Object.keys(REGISTRY)) {
    delete REGISTRY[key];
  }
}
