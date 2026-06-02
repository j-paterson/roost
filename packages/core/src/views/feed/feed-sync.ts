/**
 * Single source of truth for the "active" item shared by the feed view's
 * grid panel and feed panel. Each consumer subscribes and acts when the
 * id changes; the `source` parameter lets a consumer ignore changes it
 * caused itself, preventing scroll-event echo loops.
 */
export type FeedSyncSource = "grid" | "feed";
export type FeedSyncListener = (roostId: string | null, source: FeedSyncSource) => void;

export interface FeedSync {
  get(): string | null;
  set(roostId: string | null, source: FeedSyncSource): void;
  subscribe(listener: FeedSyncListener): () => void;
}

export function createFeedSync(): FeedSync {
  let active: string | null = null;
  const listeners = new Set<FeedSyncListener>();
  return {
    get: () => active,
    set: (roostId, source) => {
      if (roostId === active) return;
      active = roostId;
      for (const l of listeners) l(roostId, source);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
