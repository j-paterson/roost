import { App, Modal } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { RemapReview } from "@/ui/components/remap-review";
import type { MappingSuggestion, ResolvedMapping } from "@/lib/collection-remap";

export interface RemapConfirmModalOpts {
  app: App;
  suggestions: MappingSuggestion[];
  categoryNames: string[];
  onConfirm: (resolved: ResolvedMapping[]) => void;
}

export class RemapConfirmModal extends Modal {
  private opts: RemapConfirmModalOpts;
  private root: Root | null = null;

  constructor(opts: RemapConfirmModalOpts) {
    super(opts.app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("roost-remap-modal");
    const mount = contentEl.createDiv();
    this.root = createRoot(mount);
    this.root.render(
      createElement(RemapReview, {
        suggestions: this.opts.suggestions,
        categoryNames: this.opts.categoryNames,
        onConfirm: (resolved) => { this.opts.onConfirm(resolved); this.close(); },
        onCancel: () => this.close(),
      }),
    );
  }

  onClose() {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}
