/**
 * Gallery multi-select mode — bar UI, bulk move accept, fly-to-sidebar animation.
 */
import { animate } from "motion";
import type { RoostFilter } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";

export interface GallerySelectionHost {
  getGalleryContainer(): HTMLElement;
  getGalleryScrollEl(): HTMLElement;
  getGallerySelectionBar(): HTMLElement | null;
  getRoostPlugin(): IRoostPlugin | null;
  getCurrentFilter(): RoostFilter;
}

export class GallerySelectionController {
  private mode = false;
  private selectedIds = new Set<string>();
  private target: string | null = null;
  private onAccept: ((ids: string[]) => void) | null = null;
  anchor: string | null = null;
  private preFilter: RoostFilter = null;
  private preScroll = 0;

  constructor(private readonly host: GallerySelectionHost) {}

  isActive(): boolean {
    return this.mode;
  }

  isSelected(roostId: string): boolean {
    return this.selectedIds.has(roostId);
  }

  enter(itemIds: string[], targetName: string, onAccept: (ids: string[]) => void): void {
    this.mode = true;
    this.selectedIds = new Set(itemIds);
    this.target = targetName;
    this.onAccept = onAccept;
    this.preFilter = this.host.getCurrentFilter();
    this.preScroll = this.host.getGalleryScrollEl().scrollTop;

    const plugin = this.host.getRoostPlugin();
    if (plugin) plugin.setFilter({ itemIds });

    this.updateBar();
    this.applyVisuals();
  }

  exit(): void {
    const restoreFilter = this.preFilter;
    const restoreScroll = this.preScroll;
    this.mode = false;
    this.anchor = null;
    this.selectedIds.clear();
    this.target = null;
    this.onAccept = null;
    this.preFilter = null;
    this.preScroll = 0;
    const bar = this.host.getGallerySelectionBar();
    if (bar) bar.style.display = "none";
    this.host.getGalleryContainer().querySelectorAll(".roost-card-selected").forEach(el =>
      el.classList.remove("roost-card-selected"),
    );
    const plugin = this.host.getRoostPlugin();
    if (plugin) {
      plugin.setFilter(restoreFilter);
      requestAnimationFrame(() => {
        this.host.getGalleryScrollEl().scrollTop = restoreScroll;
      });
    }
  }

  toggle(roostId: string, cardEl: HTMLElement): void {
    if (this.selectedIds.has(roostId)) {
      this.selectedIds.delete(roostId);
      cardEl.classList.remove("roost-card-selected");
    } else {
      this.selectedIds.add(roostId);
      cardEl.classList.add("roost-card-selected");
    }
    this.updateBar();
  }

  applyVisuals(): void {
    this.host.getGalleryContainer().querySelectorAll("[data-roost-id]").forEach(el => {
      const id = (el as HTMLElement).dataset.roostId;
      if (id && this.selectedIds.has(id)) {
        el.classList.add("roost-card-selected");
      } else {
        el.classList.remove("roost-card-selected");
      }
    });
  }

  /** Finder single-click: replace entire selection with this id. */
  selectSingle(id: string): void {
    this.selectedIds.clear();
    this.selectedIds.add(id);
    this.anchor = id;
    this.updateBar();
    this.applyVisuals();
  }

  /** Finder ⌘/Ctrl-click: toggle id in/out of selection. */
  toggleId(id: string): void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.anchor = id;
    this.updateBar();
    this.applyVisuals();
  }

  /** Finder shift-click: select contiguous anchor→id span. */
  selectRange(id: string, orderedIds: string[]): void {
    if (!this.anchor) { this.selectSingle(id); return; }
    const anchorIdx = orderedIds.indexOf(this.anchor);
    if (anchorIdx === -1) { this.selectSingle(id); return; }
    const clickIdx = orderedIds.indexOf(id);
    if (clickIdx === -1) { this.selectSingle(id); return; }
    const [start, end] = anchorIdx <= clickIdx
      ? [anchorIdx, clickIdx]
      : [clickIdx, anchorIdx];
    this.selectedIds.clear();
    for (let i = start; i <= end; i++) {
      this.selectedIds.add(orderedIds[i]);
    }
    // Anchor stays fixed (Finder behavior: anchor is first click, not most-recent)
    this.updateBar();
    this.applyVisuals();
  }

  /** Select all visible ids (⌘A). */
  selectAll(orderedIds: string[]): void {
    this.selectedIds.clear();
    for (const id of orderedIds) this.selectedIds.add(id);
    this.updateBar();
    this.applyVisuals();
  }

  /** Clear the selection (Esc or click-on-empty). */
  clear(): void {
    this.selectedIds.clear();
    this.anchor = null;
    this.updateBar();
    this.applyVisuals();
  }

  /** Return current selected ids as an array. */
  getSelected(): string[] {
    return [...this.selectedIds];
  }

  /** True if the given id is in the current selection. */
  has(id: string): boolean {
    return this.selectedIds.has(id);
  }

  private updateBar(): void {
    const bar = this.host.getGallerySelectionBar();
    if (!bar) return;
    const count = this.selectedIds.size;
    const showBar = this.mode || count > 0;
    bar.style.display = showBar ? "flex" : "none";
    if (!showBar) return;

    bar.empty();

    if (this.mode) {
      // Enter-mode (neighbor-move staging): full bar with Move/Select-all/Cancel.
      const label = bar.createSpan({ cls: "roost-selection-label" });
      label.textContent = `${count} item${count !== 1 ? "s" : ""} selected`;

      const actions = bar.createDiv({ cls: "roost-selection-actions" });

      const selectAllBtn = actions.createEl("button", { cls: "roost-nav-btn", text: "Select all" });
      selectAllBtn.addEventListener("click", () => {
        this.host.getGalleryContainer().querySelectorAll("[data-roost-id]").forEach(el => {
          const id = (el as HTMLElement).dataset.roostId;
          if (id) { this.selectedIds.add(id); el.classList.add("roost-card-selected"); }
        });
        this.updateBar();
      });

      const deselectAllBtn = actions.createEl("button", { cls: "roost-nav-btn", text: "Deselect all" });
      deselectAllBtn.addEventListener("click", () => {
        this.selectedIds.clear();
        this.host.getGalleryContainer().querySelectorAll(".roost-card-selected").forEach(el =>
          el.classList.remove("roost-card-selected"),
        );
        this.updateBar();
      });

      const moveBtn = actions.createEl("button", {
        cls: "roost-nav-btn roost-selection-move-btn",
        text: `Move ${count} to "${this.target}"`,
      });
      moveBtn.disabled = count === 0;
      moveBtn.addEventListener("click", () => {
        const target = this.target;
        const movedIds = new Set(this.selectedIds);
        if (this.onAccept && movedIds.size > 0) this.onAccept([...movedIds]);
        this.animateToSidebar(target, movedIds);
      });

      const cancelBtn = actions.createEl("button", { cls: "roost-nav-btn", text: "Cancel" });
      cancelBtn.addEventListener("click", () => this.exit());

    } else {
      // Free multiselect mode: subtle indicator + Clear.
      const label = bar.createSpan({ cls: "roost-selection-label" });
      label.textContent = `${count} selected`;
      const actions = bar.createDiv({ cls: "roost-selection-actions" });
      const clearBtn = actions.createEl("button", { cls: "roost-nav-btn", text: "Clear" });
      clearBtn.addEventListener("click", () => this.clear());
    }
  }

  private animateToSidebar(target: string | null, movedIds: Set<string>): void {
    const sidebarRow = target
      ? document.querySelector(`[data-category="${CSS.escape(target)}"]`) as HTMLElement | null
      : null;
    const sidebarRect = sidebarRow?.getBoundingClientRect();

    const cards = Array.from(this.host.getGalleryContainer().querySelectorAll("[data-roost-id]"))
      .filter(el => movedIds.has((el as HTMLElement).dataset.roostId!)) as HTMLElement[];

    if (!sidebarRect || cards.length === 0) {
      this.exit();
      return;
    }

    if (sidebarRow) sidebarRow.classList.add("roost-sidebar-receive");

    let completed = 0;
    const total = cards.length;
    const STAGGER = 30;

    cards.forEach((card, i) => {
      const cardRect = card.getBoundingClientRect();
      const clone = document.createElement("div");
      clone.className = "roost-fly-clone";
      const img = card.querySelector("img");
      if (img) {
        const cloneImg = document.createElement("img");
        cloneImg.src = img.src;
        cloneImg.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:6px;";
        clone.appendChild(cloneImg);
      } else {
        clone.style.background = "var(--background-modifier-border)";
      }

      clone.style.cssText += `
        position: fixed;
        left: ${cardRect.left}px;
        top: ${cardRect.top}px;
        width: ${cardRect.width}px;
        height: ${cardRect.height}px;
        z-index: 9999;
        border-radius: 6px;
        overflow: hidden;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      `;
      document.body.appendChild(clone);
      card.style.opacity = "0";

      setTimeout(() => {
        const targetX = sidebarRect.left + sidebarRect.width / 2;
        const targetY = sidebarRect.top + sidebarRect.height / 2;
        (animate as any)(clone, {
          left: `${targetX - 16}px`,
          top: `${targetY - 8}px`,
          width: "32px",
          height: "16px",
          opacity: 0,
          borderRadius: "4px",
        }, {
          duration: 0.4,
          easing: [0.4, 0, 0.2, 1],
        }).then(() => {
          clone.remove();
          completed++;
          if (completed === total) {
            if (sidebarRow) {
              setTimeout(() => sidebarRow.classList.remove("roost-sidebar-receive"), 300);
            }
            this.exit();
          }
        });
      }, i * STAGGER);
    });
  }
}
