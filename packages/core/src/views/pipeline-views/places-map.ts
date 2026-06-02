/**
 * Places map — mounted above the gallery card grid when the active filter
 * is Places (or a Places subcategory). The gallery cards continue to
 * render below, scoped to whatever items the map's filter callback
 * selects.
 *
 * Pin-click flow:
 *   - User clicks a pin (or a pin cluster)
 *   - Map callback pins the roost_id to the top of the next render +
 *     calls setFilter with the matching item ids
 *   - Gallery re-renders, expanding the focused card at index 0
 *
 * Wraps src/views/places-map.ts (the standalone renderPlacesMap fn,
 * Leaflet integration) inside the registry shape so the gallery can
 * dispatch to it via the same path as Media's substitute view.
 */
import type { BasesEntry } from "obsidian";
import { getRoostId } from "@/lib/bases-entry";
import { loadPipelineCache } from "@/pipeline/shared";
import { buildMapPins, renderPlacesMap, type PlacesMapController } from "@/views/places-map";
import type { PipelineCacheEntry } from "@/types/roost";
import {
  registerPipelineGalleryView,
  type PipelineGalleryView,
  type GalleryRenderContext,
} from "./registry";

export const placesMapView: PipelineGalleryView = {
  mode: "above",
  render(container, ctx: GalleryRenderContext) {
    container.addClass("roost-places-map-wrap");

    const cache = loadPipelineCache<PipelineCacheEntry>(ctx.app.vault, "places-cache.json");
    const pins = buildMapPins(cache);

    // roost_id → cover URL for pin thumbnails. Resolved via the gallery's
    // own image resolver so map and cards stay in sync on what they show.
    const coverByRoostId = new Map<string, string>();
    for (const entry of ctx.entries) {
      const id = getRoostId(entry);
      if (!id) continue;
      const url = ctx.resolveImageUrl(entry);
      if (url) coverByRoostId.set(id, url);
    }

    const controller: PlacesMapController = renderPlacesMap(
      container,
      pins,
      (roostIds, focusId) => {
        // Defer the setFilter so the map's moveend (which fires
        // synchronously during fitBounds / invalidateSize) doesn't
        // re-enter applyFilter → onDataUpdated while the outer render
        // is still building the card grid. Without this, the nested
        // onDataUpdated calls containerEl.empty() mid-render and the
        // grid flashes then vanishes.
        queueMicrotask(() => {
          if (!roostIds) {
            ctx.setFilter({ category: "Places" });
            return;
          }
          if (focusId) ctx.pinAndFocus(focusId);
          ctx.setFilter({ category: "Places", itemIds: roostIds });
        });
      },
      (roostId) => coverByRoostId.get(roostId) ?? null,
    );

    return {
      dispose: () => {
        controller.dispose();
        container.remove();
      },
      onExpand: (roostId) => { controller.focusOn(roostId); },
    };
  },
};

registerPipelineGalleryView("Places", placesMapView);
