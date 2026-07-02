import { describe, it, expect } from "vitest";
import { bindGalleryGridRenderHost, type GalleryGridStateSource } from "../gallery-grid-host";

function minimalGridSource(overrides: Partial<GalleryGridStateSource> = {}): GalleryGridStateSource {
  const el = document.createElement("div");
  return {
    app: { vault: {} } as GalleryGridStateSource["app"],
    containerEl: el,
    scrollEl: el,
    config: { get: () => undefined, getAsPropertyId: () => "note.cover" },
    data: { data: [] },
    filteredIndices: null,
    splitMode: false,
    certainIndicesSplit: null,
    uncertainIndicesSplit: null,
    currentFilter: null,
    activePlatformFilter: null,
    renderedKey: "old",
    knownPlatforms: [],
    estimatedHeight: 100,
    certainGrid: null,
    uncertainGrid: null,
    totalCount: 0,
    loadedCount: 0,
    cfg: {
      imagePropId: "note.cover",
      imageFit: "cover",
      imageRatio: 0.75,
      showPlatform: true,
      showAuthor: true,
      showTags: false,
    },
    hydrationObserver: null,
    pendingExpandInPlaceId: null,
    refreshFeedEntries: () => {},
    shouldRenderPipelineSubstitute: () => false,
    dispatchPipelineGalleryView: () => false,
    applyGridStyle: () => {},
    createPlaceholder: () => {},
    expandInPlaceById: () => {},
    onPlatformsDiscovered: () => {},
    getFeedViewMode: () => "grid" as const,
    syncKeptGalleryCard: () => {},
    refreshWindowGrid: () => {},
    disableWindowGrid: () => {},
    ...overrides,
  };
}

describe("bindGalleryGridRenderHost", () => {
  it("forwards mutable field writes to the source object", () => {
    const source = minimalGridSource();
    const host = bindGalleryGridRenderHost(source);

    host.renderedKey = "new-key";
    host.estimatedHeight = 220;
    host.pendingExpandInPlaceId = "bm_1";
    host.totalCount = 5;

    expect(source.renderedKey).toBe("new-key");
    expect(source.estimatedHeight).toBe(220);
    expect(source.pendingExpandInPlaceId).toBe("bm_1");
    expect(source.totalCount).toBe(5);
  });

  it("delegates actions to the source", () => {
    let expanded: string | null = null;
    const source = minimalGridSource({
      expandInPlaceById: (id) => {
        expanded = id;
      },
    });
    bindGalleryGridRenderHost(source).expandInPlaceById("bm_0");
    expect(expanded).toBe("bm_0");
  });
});
