/**
 * Gallery view mount — plugin subscriptions and intersection hydration.
 */
import type { RoostFilter } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";

export interface GalleryPluginSubscriptionHost {
  getRoostPlugin(): IRoostPlugin | null;
  applyFilter(filter: RoostFilter, pushHistory?: boolean): void;
  onDataUpdated(): void;
  getCurrentFilter(): RoostFilter;
}

export interface GalleryPluginSubscriptions {
  unsubFilter: (() => void) | null;
  unsubDataRefresh: (() => void) | null;
}

/** Sidebar filter + pipeline data-refresh listeners. */
export function attachGalleryPluginSubscriptions(
  host: GalleryPluginSubscriptionHost,
): GalleryPluginSubscriptions {
  const plugin = host.getRoostPlugin();
  let unsubFilter: (() => void) | null = null;
  let unsubDataRefresh: (() => void) | null = null;

  if (plugin?.onFilterChange) {
    unsubFilter = plugin.onFilterChange((filter: RoostFilter) => {
      host.applyFilter(filter);
    });
    if (plugin.activeFilter) host.applyFilter(plugin.activeFilter);
  }

  if (plugin?.onDataRefresh) {
    unsubDataRefresh = plugin.onDataRefresh(() => {
      if (host.getCurrentFilter()) {
        host.applyFilter(host.getCurrentFilter(), false);
      } else {
        host.onDataUpdated();
      }
    });
  }

  return { unsubFilter, unsubDataRefresh };
}

/** Lazy-hydrate placeholders when they approach the viewport. */
export function createGalleryHydrationObserver(
  hydrateCard: (el: HTMLElement, index: number) => void,
  rootMargin = "400px",
): IntersectionObserver {
  const observer = new IntersectionObserver(
    entries => {
      for (const io of entries) {
        if (!io.isIntersecting) continue;
        const el = io.target as HTMLElement;
        const idx = el.dataset.idx;
        if (idx == null || el.dataset.hydrated) continue;
        el.dataset.hydrated = "1";
        observer.unobserve(el);
        hydrateCard(el, parseInt(idx, 10));
      }
    },
    { rootMargin },
  );
  return observer;
}
