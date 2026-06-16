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
 *
 * Leaflet is NOT imported statically here — it is loaded on demand via
 * dynamic import() the first time the Places map view is rendered. This
 * keeps leaflet (~450 KB of initialization code) off the plugin startup
 * path. The render() fn returns a proxy handle immediately; the real
 * Leaflet map mounts once the dynamic import resolves (typically <50 ms
 * after the first Places filter is applied — far before the user can
 * interact with the map).
 */
import { getRoostId } from "@/lib/bases-entry";
import { loadPipelineCache } from "@/pipeline/shared";
import type { PlacesMapController } from "@/views/places-map";
import type { PipelineCacheEntry } from "@/types/roost";
import {
  registerPipelineGalleryView,
  type PipelineGalleryView,
  type GalleryRenderContext,
  type PipelineGalleryHandle,
} from "./registry";

const placesMapView: PipelineGalleryView = {
  mode: "above",
  render(container, ctx: GalleryRenderContext): PipelineGalleryHandle {
    container.addClass("roost-places-map-wrap");

    // Real controller, available after the lazy import resolves.
    let controller: PlacesMapController | null = null;
    // Set to true if dispose() is called before the import resolves.
    let disposeEarly = false;
    // roost_id queued for focusOn() before the controller was ready.
    let pendingFocusId: string | null = null;

    // Kick off the lazy load. `import("@/views/places-map")` is the only
    // statement that pulls in Leaflet; with inlineDynamicImports:true the
    // module code is bundled in main.js but its factory doesn't execute
    // until this import() resolves.
    void import("@/views/places-map").then(({ buildMapPins, renderPlacesMap }) => {
      if (disposeEarly) return;

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

      controller = renderPlacesMap(
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

      // Flush any focusOn() call that arrived before the controller was ready.
      if (pendingFocusId) {
        controller.focusOn(pendingFocusId);
        pendingFocusId = null;
      }
    });

    return {
      dispose: () => {
        disposeEarly = true;
        controller?.dispose();
        container.remove();
      },
      onExpand: (roostId) => {
        if (controller) {
          controller.focusOn(roostId);
        } else {
          // Store the most recent request; the controller will apply it on init.
          pendingFocusId = roostId;
        }
      },
    };
  },
};

registerPipelineGalleryView("Places", placesMapView);
