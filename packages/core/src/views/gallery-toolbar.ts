/**
 * Gallery toolbar — nav, title, platform pills, feed-mode toggle.
 */
import { setIcon } from "obsidian";
import { PLATFORM_DISPLAY } from "@/config";
import type { RoostFilter } from "@/types/roost";

export interface GalleryToolbarState {
  filter: RoostFilter;
  filterHistoryIndex: number;
  filterHistoryLength: number;
  knownPlatforms: string[];
  activePlatformFilter: string | null;
  viewMode: "grid" | "feed";
}

export interface GalleryToolbarHandlers {
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onPlatformFilterChange: (platform: string | null) => void;
  onViewModeToggle: () => void;
}

function filterToolbarTitle(filter: RoostFilter): string {
  if (!filter) return "All Bookmarks";
  if (filter.category !== undefined) {
    const cat = filter.category;
    const subcat = filter.subcategory;
    return cat === null ? "Unsorted" : subcat ? `${cat} › ${subcat}` : cat;
  }
  if (filter.itemIds) return `${filter.itemIds.length} items`;
  if (filter.folders) return "Categories";
  return "All Bookmarks";
}

/** Rebuild toolbar DOM. Caller owns toolbarEl lifecycle. */
export function renderGalleryToolbar(
  toolbarEl: HTMLElement,
  state: GalleryToolbarState,
  handlers: GalleryToolbarHandlers,
): void {
  toolbarEl.empty();

  const navGroup = toolbarEl.createDiv({ cls: "roost-toolbar-nav" });
  const backBtn = navGroup.createEl("button", { cls: "roost-nav-btn", text: "‹" });
  const fwdBtn = navGroup.createEl("button", { cls: "roost-nav-btn", text: "›" });
  backBtn.disabled = state.filterHistoryIndex <= 0;
  fwdBtn.disabled = state.filterHistoryIndex >= state.filterHistoryLength - 1;
  backBtn.addEventListener("click", handlers.onNavigateBack);
  fwdBtn.addEventListener("click", handlers.onNavigateForward);

  toolbarEl.createDiv({
    cls: "roost-toolbar-title",
    text: filterToolbarTitle(state.filter),
  });

  const pillGroup = toolbarEl.createDiv({ cls: "roost-toolbar-pills" });
  if (state.knownPlatforms.length > 0) {
    const allBtn = pillGroup.createEl("button", {
      cls: `roost-platform-pill${state.activePlatformFilter === null ? " is-active" : ""}`,
      text: "All",
    });
    allBtn.addEventListener("click", () => {
      if (state.activePlatformFilter === null) return;
      handlers.onPlatformFilterChange(null);
    });
    for (const p of state.knownPlatforms) {
      const btn = pillGroup.createEl("button", {
        cls: `roost-platform-pill${state.activePlatformFilter === p ? " is-active" : ""}`,
        text: PLATFORM_DISPLAY[p] || p,
      });
      btn.addEventListener("click", () => {
        if (state.activePlatformFilter === p) return;
        handlers.onPlatformFilterChange(p);
      });
    }
  }

  const isMediaFilter = state.filter?.category === "Media";
  if (!isMediaFilter) {
    const modeGroup = toolbarEl.createDiv({ cls: "roost-toolbar-mode" });
    const modeBtn = modeGroup.createEl("button", {
      cls: `roost-mode-btn${state.viewMode === "feed" ? " is-active" : ""}`,
      attr: {
        title: state.viewMode === "feed" ? "Hide feed pane" : "Show feed pane",
      },
    });
    setIcon(modeBtn, state.viewMode === "feed" ? "panel-right-close" : "panel-right");
    modeBtn.addEventListener("click", handlers.onViewModeToggle);
  }

  toolbarEl.style.display = "flex";
}
