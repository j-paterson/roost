/**
 * General-purpose file explorer Bases view — content-type-aware card grid.
 */
import { BasesEntry } from "obsidian";
import type { QueryController } from "obsidian";
import { BaseCardView } from "./base-card-view";
import { getRoostPlugin } from "@/lib/roost-plugin";
import { attachExplorerFilterSubscription, type ExplorerFolderFilterHost } from "@/views/explorer-folder-filter";
import {
  hydrateExplorerCard,
  type ExplorerCardConfig,
  type ExplorerHydrateHost,
} from "@/views/explorer-hydrate-card";
import {
  renderExplorerExpandedPanel,
  type ExplorerExpandedHost,
} from "@/views/explorer-expanded-panel";

export const EXPLORER_VIEW_ID = "roost-explorer";

export class ExplorerBasesView extends BaseCardView {
  type = EXPLORER_VIEW_ID;
  protected openInNewPaneOnDoubleClick = true;

  private cfg: ExplorerCardConfig = {
    imagePropId: "note.cover", imageFit: "cover", imageRatio: 0.75,
    showPath: false,
  };

  private folderFilter: string | null = null;
  private unsubFilter: (() => void) | null = null;

  constructor(controller: QueryController, scrollEl: HTMLElement) {
    super(controller, scrollEl);
  }

  onload() {
    super.onload();
    this.unsubFilter = attachExplorerFilterSubscription(this.folderFilterHost());
  }

  onunload() {
    this.unsubFilter?.();
    this.unsubFilter = null;
    super.onunload();
  }

  private folderFilterHost(): ExplorerFolderFilterHost {
    const view = this;
    return {
      getRoostPlugin: () => getRoostPlugin(view.app),
      getEntries: () => view.data?.data,
      getFolderFilter: () => view.folderFilter,
      setFolderFilter: (folder) => {
        view.folderFilter = folder;
      },
      setFilteredIndices: (indices) => {
        view.filteredIndices = indices;
      },
      clearRenderedKey: () => {
        view.renderedKey = "";
      },
      onDataUpdated: () => view.onDataUpdated(),
    };
  }

  private hydrateHost(): ExplorerHydrateHost {
    const view = this;
    return {
      app: view.app,
      cfg: view.cfg,
      resolveEntryImageUrl: (entry, propId) => view.resolveEntryImageUrl(entry, propId),
      resolveImageUrl: (entry, propId) => view.resolveImageUrl(entry, propId),
    };
  }

  private expandedHost(): ExplorerExpandedHost {
    const view = this;
    return {
      app: view.app,
      cfg: view.cfg,
      resolveEntryImageUrl: (entry, propId) => view.resolveEntryImageUrl(entry, propId),
      resolveImageUrl: (entry, propId) => view.resolveImageUrl(entry, propId),
      getPropertyIds: () => view.data?.properties as string[] | undefined,
      getDisplayName: (propId) => view.config.getDisplayName(propId as never),
      closeExpanded: () => view.closeExpanded(),
      markdownRenderChild: view,
    };
  }

  protected buildCacheKey(): string {
    return `${this.folderFilter ?? "all"}|` + JSON.stringify([this.config.get("showPath")]);
  }

  onDataUpdated(): void {
    const imagePropId = this.config.getAsPropertyId("imageProperty") ?? "note.cover";
    const imageFit = (this.config.get("imageFit") as string) ?? "cover";
    const imageRatio = ((this.config.get("imageRatio") as number) ?? 75) / 100;
    const showPath = (this.config.get("showPath") as boolean) ?? false;
    this.cfg = { imagePropId, imageFit, imageRatio, showPath };

    const plugin = getRoostPlugin(this.app);
    if (plugin && this.data?.data) {
      plugin.setExplorerPaths(this.data.data.map(e => e.file.path));
    }

    super.onDataUpdated();
  }

  protected hydrateCardContent(el: HTMLElement, _index: number, entry: BasesEntry): void {
    hydrateExplorerCard(el, entry, this.hydrateHost());
  }

  protected renderExpandedContent(cardEl: HTMLElement, entry: BasesEntry): void {
    renderExplorerExpandedPanel(cardEl, entry, this.expandedHost());
  }
}
