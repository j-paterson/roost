/**
 * Abstract base class for card-grid Bases views.
 *
 * Provides the shared rendering infrastructure:
 * - CSS grid layout with configurable card size
 * - Skeleton placeholder loading before data arrives
 * - Deferred hydration via IntersectionObserver (400px look-ahead)
 * - Incremental batch loading with sentinel observer (60-card batches)
 * - FLIP expand/collapse animation (spring physics via "motion")
 * - Image URL resolution from frontmatter properties
 *
 * Subclasses implement:
 * - `hydrateCard()` — how to render card content
 * - `renderExpandedContent()` — what the expanded detail view shows
 * - `buildCacheKey()` — extra cache key segments for change detection
 * - `getTotalCount()` — how many items to render (may be filtered)
 * - `getEntryByIndex()` — map flat index to BasesEntry (handles filtering/grouping)
 */
import {
  BasesView, BasesEntry,
  TFile,
} from "obsidian";
import type { QueryController } from "obsidian";
import { animate } from "motion";
import { safeGetValue } from "@/lib/bases-entry";
import { stripWikilink } from "@/lib/vault-utils";
import { imageResourcePathForFile } from "./content-detector";

/** Base config fields shared by all card views */
export interface BaseCardConfig {
  imagePropId: string;
  imageFit: string;
  imageRatio: number;
}

export abstract class BaseCardView extends BasesView {
  abstract type: string;

  // Public (not protected): subclasses are passed as a MarkdownRenderChild /
  // Gallery host, both of which expose `containerEl` publicly — a protected
  // member can't satisfy that.
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  protected hydrationObserver: IntersectionObserver | null = null;
  protected renderedKey: string = "";

  // Incremental loading state
  protected loadedCount = 0;
  protected totalCount = 0;
  protected estimatedHeight = 0;
  protected gridTarget: HTMLElement | null = null;
  protected sentinelObserver: IntersectionObserver | null = null;
  protected sentinel: HTMLElement | null = null;
  protected static BATCH = 60;

  /** When set, grid indices map through this array into data.data */
  protected filteredIndices: number[] | null = null;

  // Expand/collapse state
  protected expandedEl: HTMLElement | null = null;
  protected savedCardContent: DocumentFragment | null = null;

  /** When true, double-click opens the note in a new pane instead of expanding */
  protected openInNewPaneOnDoubleClick = false;
  private cardClickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCardClickPath = "";
  private lastCardClickTime = 0;
  private static readonly DOUBLE_CLICK_MS = 400;
  private static readonly EXPAND_CLICK_DELAY_MS = 300;

  constructor(controller: QueryController, scrollEl: HTMLElement) {
    super(controller);
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({ cls: "roost-bases-grid" });
    this.showInitialSkeletons();
  }

  // ─── Abstract methods for subclasses ─────────────────────────────

  /** Populate a card element with content for the given index */
  protected abstract hydrateCardContent(el: HTMLElement, index: number, entry: BasesEntry): void;

  /** Build the expanded detail view inside the card */
  protected abstract renderExpandedContent(cardEl: HTMLElement, entry: BasesEntry): void;

  /** Return extra cache key segments for change detection (e.g., filter state) */
  protected buildCacheKey(): string { return ""; }

  /** Return the total number of items to render (may be filtered) */
  protected getTotalCount(entries: BasesEntry[]): number {
    if (this.filteredIndices) return this.filteredIndices.length;
    if (this.data.groupedData?.length > 0) {
      return this.data.groupedData.reduce((n, g) => n + g.entries.length, 0);
    }
    return entries.length;
  }

  /** Map a flat index to the correct BasesEntry (handles grouping) */
  protected getEntryByIndex(index: number): BasesEntry | null {
    if (this.filteredIndices) {
      const realIndex = this.filteredIndices[index];
      return realIndex != null ? (this.data.data[realIndex] ?? null) : null;
    }
    if (this.data.groupedData?.length > 0) {
      let offset = 0;
      for (const group of this.data.groupedData) {
        if (index < offset + group.entries.length) {
          return group.entries[index - offset];
        }
        offset += group.entries.length;
      }
      return null;
    }
    return this.data.data[index] ?? null;
  }

  // ─── Shared infrastructure ───────────────────────────────────────

  protected applyGridStyle(cardSize: number) {
    this.containerEl.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(${cardSize}px, 1fr));
      grid-auto-flow: dense;
      gap: 12px;
      padding: 12px;
    `;
  }

  protected showInitialSkeletons() {
    const cardSize = (this.config?.get?.("cardSize") as number) ?? 180;
    const imageRatio = ((this.config?.get?.("imageRatio") as number) ?? 75) / 100;
    const estimatedHeight = Math.round(cardSize * imageRatio + 50);

    this.applyGridStyle(cardSize);
    for (let i = 0; i < 30; i++) {
      const el = this.containerEl.createDiv({ cls: "roost-card roost-card-placeholder" });
      el.style.minHeight = `${estimatedHeight}px`;
      el.createDiv({ cls: "roost-shimmer" });
    }
  }

  onload() {
    // Config is now available — re-apply grid style to match actual card size
    if (this.renderedKey === "") {
      const cardSize = (this.config?.get?.("cardSize") as number) ?? 180;
      this.applyGridStyle(cardSize);
    }

    this.hydrationObserver = new IntersectionObserver(
      (ioEntries) => {
        for (const io of ioEntries) {
          if (!io.isIntersecting) continue;
          const el = io.target as HTMLElement;
          const idx = el.dataset.idx;
          if (idx == null || el.dataset.hydrated) continue;
          el.dataset.hydrated = "1";
          this.hydrationObserver?.unobserve(el);
          this.hydrateCard(el, parseInt(idx, 10));
        }
      },
      { rootMargin: "400px" }
    );
  }

  onunload() {
    this.hydrationObserver?.disconnect();
    this.hydrationObserver = null;
    this.sentinelObserver?.disconnect();
    this.sentinelObserver = null;
  }

  onDataUpdated(): void {
    const entries = this.data.data;
    const configKey = JSON.stringify([
      this.config.get("cardSize"), this.config.get("imageRatio"), this.config.get("imageFit"),
    ]);
    const newKey = `${entries.length}|${entries[0]?.file.path}|${entries[entries.length - 1]?.file.path}|${configKey}|${this.buildCacheKey()}`;
    if (newKey === this.renderedKey) return;
    this.renderedKey = newKey;

    this.hydrationObserver?.disconnect();
    this.containerEl.empty();

    const cardSize = (this.config.get("cardSize") as number) ?? 220;
    const imageRatio = ((this.config.get("imageRatio") as number) ?? 75) / 100;

    const estimatedHeight = Math.round(cardSize * imageRatio + 50);
    this.applyGridStyle(cardSize);

    this.totalCount = this.getTotalCount(entries);
    this.estimatedHeight = estimatedHeight;
    this.gridTarget = this.containerEl;
    this.loadedCount = 0;

    this.sentinelObserver?.disconnect();
    this.loadMorePlaceholders();
  }

  protected loadMorePlaceholders() {
    if (!this.gridTarget || this.loadedCount >= this.totalCount) return;

    const batchSize = (this.constructor as typeof BaseCardView).BATCH;
    const end = Math.min(this.loadedCount + batchSize, this.totalCount);
    for (let i = this.loadedCount; i < end; i++) {
      this.createPlaceholder(this.gridTarget, i, this.estimatedHeight);
    }
    this.loadedCount = end;

    if (this.loadedCount < this.totalCount) {
      if (!this.sentinel) {
        this.sentinel = document.createElement("div");
        this.sentinel.className = "roost-load-sentinel";
        this.sentinel.style.cssText = "grid-column: 1 / -1; height: 1px;";
      }
      this.gridTarget.appendChild(this.sentinel);

      if (!this.sentinelObserver) {
        this.sentinelObserver = new IntersectionObserver(
          (entries) => {
            if (entries[0]?.isIntersecting) this.loadMorePlaceholders();
          },
          { rootMargin: "600px" }
        );
      }
      this.sentinelObserver.observe(this.sentinel);
    } else {
      this.sentinel?.remove();
    }
  }

  protected createPlaceholder(parent: HTMLElement, index: number, height: number) {
    const el = parent.createDiv({ cls: "roost-card roost-card-placeholder" });
    el.dataset.idx = String(index);
    el.style.minHeight = `${height}px`;
    el.createDiv({ cls: "roost-shimmer" });
    this.hydrationObserver?.observe(el);
  }

  /** Hydrate a placeholder into a full card — shared shell, delegates to subclass */
  protected hydrateCard(el: HTMLElement, index: number) {
    const entry = this.getEntryByIndex(index);
    if (!entry) return;

    // Remove skeleton, crossfade to real content
    el.classList.add("roost-card-ready");
    el.style.minHeight = "";
    const shimmer = el.querySelector(".roost-shimmer");
    if (shimmer) shimmer.remove();
    el.addEventListener("animationend", () => {
      el.classList.remove("roost-card-placeholder");
    }, { once: true });
    el.dataset.path = entry.file.path;

    // Click → expand (delayed); double-click → new pane when enabled
    el.addEventListener("click", (e) => {
      if (this.expandedEl === el) return;
      e.stopPropagation();

      const now = Date.now();
      const isDouble = this.lastCardClickPath === entry.file.path
        && now - this.lastCardClickTime < BaseCardView.DOUBLE_CLICK_MS;
      this.lastCardClickPath = entry.file.path;
      this.lastCardClickTime = now;

      if (isDouble && this.openInNewPaneOnDoubleClick) {
        if (this.cardClickTimer) {
          clearTimeout(this.cardClickTimer);
          this.cardClickTimer = null;
        }
        this.closeExpanded();
        this.app.workspace.openLinkText(entry.file.path, "", true);
        return;
      }

      if (this.cardClickTimer) clearTimeout(this.cardClickTimer);
      this.cardClickTimer = setTimeout(() => {
        this.cardClickTimer = null;
        this.toggleExpanded(el, entry);
      }, BaseCardView.EXPAND_CLICK_DELAY_MS);
    });

    // Delegate content rendering to subclass
    this.hydrateCardContent(el, index, entry);
  }

  // ─── Expand / Collapse (FLIP animation) ──────────────────────────

  protected closeExpanded() {
    if (!this.expandedEl || !this.savedCardContent) return;
    const el = this.expandedEl;
    const first = el.getBoundingClientRect();

    el.empty();
    el.appendChild(this.savedCardContent);
    el.classList.remove("roost-expanded");

    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sw = last.width > 0 ? first.width / last.width : 1;
    const sh = last.height > 0 ? first.height / last.height : 1;

    if (isFinite(dx) && isFinite(dy) && isFinite(sw) && isFinite(sh)) {
      animate(el, {
        x: [dx, 0], y: [dy, 0],
        scaleX: [sw, 1], scaleY: [sh, 1],
        opacity: [0.7, 1],
      }, { type: "spring", stiffness: 300, damping: 30 });
    }

    this.expandedEl = null;
    this.savedCardContent = null;
  }

  protected toggleExpanded(cardEl: HTMLElement, entry: BasesEntry) {
    if (this.expandedEl === cardEl) {
      this.closeExpanded();
      return;
    }
    const first = cardEl.getBoundingClientRect();
    this.closeExpanded();

    // Save current card content
    this.savedCardContent = document.createDocumentFragment();
    while (cardEl.firstChild) {
      this.savedCardContent.appendChild(cardEl.firstChild);
    }

    cardEl.classList.add("roost-expanded");
    this.expandedEl = cardEl;

    // Delegate expanded content to subclass
    this.renderExpandedContent(cardEl, entry);

    // FLIP animate from old to new
    cardEl.offsetHeight; // force layout
    const last = cardEl.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sw = last.width > 0 ? first.width / last.width : 1;
    const sh = last.height > 0 ? first.height / last.height : 1;

    if (isFinite(dx) && isFinite(dy) && isFinite(sw) && isFinite(sh)) {
      animate(cardEl, {
        x: [dx, 0], y: [dy, 0],
        scaleX: [sw, 1], scaleY: [sh, 1],
        opacity: [0.7, 1],
      }, { type: "spring", stiffness: 300, damping: 30 });
    }

    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ─── Shared utilities ────────────────────────────────────────────

  protected resolveImageUrl(entry: BasesEntry, propId: string): string | null {
    const value = safeGetValue(entry, propId as any);
    if (!value) return null;

    let pathStr = value.toString();
    if (!pathStr) return null;

    pathStr = stripWikilink(pathStr);

    const file = this.app.vault.getAbstractFileByPath(pathStr);
    if (file instanceof TFile) {
      return this.app.vault.getResourcePath(file);
    }

    if (pathStr.startsWith("http")) return pathStr;

    return null;
  }

  /** Frontmatter image property, or vault resource path when the file is an image */
  protected resolveEntryImageUrl(entry: BasesEntry, propId: string): string | null {
    return this.resolveImageUrl(entry, propId) ?? imageResourcePathForFile(this.app, entry.file);
  }
}
