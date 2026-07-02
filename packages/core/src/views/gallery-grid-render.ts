/**
 * Gallery card grid rebuild — placeholders, split panes, pipeline dispatch hook.
 */
import type { BasesEntry } from "obsidian";
import { traceEvent } from "@/lib/render-trace";
import { safeGetValue } from "@/lib/bases-entry";
import {
  estimateGalleryCardHeight,
} from "@/views/gallery-cards";
import { galleryEntryCount } from "@/views/gallery-entry-index";
import type { GalleryGridRenderHost } from "@/views/gallery-grid-host";

export type { GalleryGridConfigAccess, GalleryGridRenderHost } from "@/views/gallery-grid-host";

function buildRenderedKey(
  entries: BasesEntry[],
  host: GalleryGridRenderHost,
): string {
  const f = host.currentFilter;
  const filterKey = f
    ? `${f.platform}:${f.category}:${f.itemIds?.length ?? ""}:${f.folders?.length ?? ""}`
    : "all";
  return (
    `${entries.length}|${entries[0]?.file.path}|${entries[entries.length - 1]?.file.path}|${filterKey}|gp:${host.activePlatformFilter ?? "all"}|` +
    JSON.stringify([
      host.config.get("cardSize"),
      host.config.get("imageRatio"),
      host.config.get("imageFit"),
      host.config.get("showPlatform"),
      host.config.get("showAuthor"),
      host.config.get("showTags"),
    ])
  );
}

function discoverPlatforms(entries: BasesEntry[]): string[] {
  const platformSet = new Set<string>();
  for (const entry of entries) {
    const p = safeGetValue(entry, "note.platform")?.toString();
    if (p) platformSet.add(p);
  }
  return [...platformSet].sort();
}

/** Rebuild the card grid DOM when data or filter changes. Returns false if skipped (same key). */
export function rebuildGalleryGrid(host: GalleryGridRenderHost): boolean {
  const entries = host.data.data;
  const newKey = buildRenderedKey(entries, host);
  if (newKey === host.renderedKey) {
    traceEvent("onDataUpdated:keyMatch:skip");
    return false;
  }
  host.renderedKey = newKey;

  const newPlatforms = discoverPlatforms(entries);
  if (newPlatforms.join(",") !== host.knownPlatforms.join(",")) {
    host.onPlatformsDiscovered(newPlatforms);
  }

  const cardSize = (host.config.get("cardSize") as number) ?? 220;
  const imageRatio = ((host.config.get("imageRatio") as number) ?? 75) / 100;
  const imageFit = (host.config.get("imageFit") as string) ?? "cover";
  const imagePropId = host.config.getAsPropertyId("imageProperty") ?? "note.cover";
  const showPlatform = (host.config.get("showPlatform") as boolean) ?? true;
  const showAuthor = (host.config.get("showAuthor") as boolean) ?? true;
  const showTags = (host.config.get("showTags") as boolean) ?? false;

  host.cfg = { imagePropId, imageFit, imageRatio, showPlatform, showAuthor, showTags };

  const imageRatioPct = (host.config.get("imageRatio") as number) ?? 75;
  host.estimatedHeight = estimateGalleryCardHeight(cardSize, imageRatioPct);

  host.refreshFeedEntries(host.currentFilter);

  // Split-pane mode or pipeline substitute require full teardown.
  const needsSplitPane = host.splitMode && host.certainIndicesSplit
    && host.uncertainIndicesSplit && host.uncertainIndicesSplit.length > 0;
  const needsPipelineSubstitute = !needsSplitPane && host.shouldRenderPipelineSubstitute();

  if (needsSplitPane || needsPipelineSubstitute) {
    host.hydrationObserver?.disconnect();
    host.containerEl.empty();
    host.disableWindowGrid();

    traceEvent("onDataUpdated:rebuild", {
      filteredCount: host.filteredIndices?.length ?? null,
      entriesLen: entries.length,
      reconciled: false,
    });

    if (needsPipelineSubstitute) {
      host.dispatchPipelineGalleryView();
      host.refreshFeedEntries(host.currentFilter);
      return true;
    }

    host.certainGrid = null;
    host.uncertainGrid = null;

    host.containerEl.style.cssText = `display:flex;gap:0;height:100%;min-height:0;`;
    const certainCount = host.certainIndicesSplit!.length;
    const uncertainCount = host.uncertainIndicesSplit!.length;

    const leftPane = host.containerEl.createDiv({ cls: "roost-split-pane roost-split-certain" });
    leftPane.createDiv({ cls: "roost-split-label" }).setText(`Certain · ${certainCount}`);
    host.certainGrid = leftPane.createDiv({ cls: "roost-split-grid" });
    host.applyGridStyle(cardSize, host.certainGrid);

    host.containerEl.createDiv({ cls: "roost-split-divider" });

    const rightPane = host.containerEl.createDiv({ cls: "roost-split-pane roost-split-uncertain" });
    rightPane.createDiv({ cls: "roost-split-label" }).setText(`Uncertain · ${uncertainCount}`);
    host.uncertainGrid = rightPane.createDiv({ cls: "roost-split-grid" });
    host.applyGridStyle(cardSize, host.uncertainGrid);

    host.totalCount = certainCount + uncertainCount;
    host.loadedCount = host.totalCount;

    for (let i = 0; i < certainCount; i++) host.createPlaceholder(host.certainGrid, i, host.estimatedHeight);
    for (let i = 0; i < uncertainCount; i++) host.createPlaceholder(host.uncertainGrid, certainCount + i, host.estimatedHeight);

    host.refreshFeedEntries(host.currentFilter);
    return true;
  }

  // ── Standard grid: windowed rendering (only near-viewport cards mounted) ──

  host.certainGrid = null;
  host.uncertainGrid = null;
  host.applyGridStyle(cardSize);

  const newTotal = galleryEntryCount(host.data, host.filteredIndices);

  host.totalCount = newTotal;
  host.loadedCount = newTotal;

  traceEvent("onDataUpdated:rebuild", {
    filteredCount: host.filteredIndices?.length ?? null,
    entriesLen: entries.length,
    reconciled: true,
  });

  host.refreshWindowGrid();

  host.dispatchPipelineGalleryView();

  if (host.pendingExpandInPlaceId) {
    const id = host.pendingExpandInPlaceId;
    host.pendingExpandInPlaceId = null;
    host.expandInPlaceById(id);
  }

  host.refreshFeedEntries(host.currentFilter);
  return true;
}
