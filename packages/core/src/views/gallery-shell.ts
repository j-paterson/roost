/**
 * Gallery view shell — toolbar + scroll column + grid container + selection bar.
 */
import { estimateGalleryCardHeight } from "@/views/gallery-cards";

export interface GalleryViewShell {
  toolbarEl: HTMLElement;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  selectionBar: HTMLElement;
}

export function applyGalleryGridStyle(container: HTMLElement, cardSize: number): void {
  container.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(${cardSize}px, 1fr));
      grid-auto-flow: dense;
      gap: 12px;
      padding: 12px;
    `;
}

export function mountGalleryViewShell(outerScrollEl: HTMLElement): GalleryViewShell {
  outerScrollEl.style.display = "flex";
  outerScrollEl.style.flexDirection = "column";
  outerScrollEl.style.overflow = "hidden";

  const toolbarEl = outerScrollEl.createDiv({ cls: "roost-gallery-toolbar" });
  toolbarEl.style.display = "none";

  const scrollEl = outerScrollEl.createDiv();
  scrollEl.style.cssText = "flex:1;min-height:0;overflow-y:auto;position:relative;";

  const containerEl = scrollEl.createDiv({ cls: "roost-bases-grid" });
  const selectionBar = scrollEl.createDiv({ cls: "roost-selection-bar" });
  selectionBar.style.display = "none";

  return { toolbarEl, scrollEl, containerEl, selectionBar };
}

export function showGalleryInitialSkeletons(
  containerEl: HTMLElement,
  cardSize: number,
  imageRatioPct: number,
  count = 30,
): void {
  const estimatedHeight = estimateGalleryCardHeight(cardSize, imageRatioPct);
  applyGalleryGridStyle(containerEl, cardSize);
  for (let i = 0; i < count; i++) {
    const el = containerEl.createDiv({ cls: "roost-card roost-card-placeholder" });
    el.style.minHeight = `${estimatedHeight}px`;
    el.createDiv({ cls: "roost-shimmer" });
  }
}
