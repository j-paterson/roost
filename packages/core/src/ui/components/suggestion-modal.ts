/**
 * Suggestion modal — shown after an item move when similar items are found.
 * Renders a React checklist so users can select/deselect items before bulk moving.
 */
import { Modal, App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { SuggestionReview, type SuggestionItem } from "./suggestion-review";

interface SuggestionModalOpts {
  app: App;
  suggestions: {
    count: number;
    targetName: string;
    itemIds: string[];
    items?: SuggestionItem[];
  };
  onAccept: (itemIds: string[]) => void;
  onDismiss: () => void;
  onReview: (itemIds: string[]) => void;
}

export class SuggestionModal extends Modal {
  private opts: SuggestionModalOpts;
  private root: Root | null = null;

  constructor(opts: SuggestionModalOpts) {
    super(opts.app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    const { suggestions } = this.opts;
    contentEl.empty();
    contentEl.addClass("roost-suggestion-modal");

    // If we have rich item data, render the React checklist
    if (suggestions.items && suggestions.items.length > 0) {
      const mountEl = contentEl.createDiv();
      this.root = createRoot(mountEl);
      this.root.render(
        createElement(SuggestionReview, {
          targetName: suggestions.targetName,
          items: suggestions.items,
          onMoveSelected: (ids: string[]) => {
            this.opts.onAccept(ids);
            this.close();
          },
          onDismiss: () => {
            this.opts.onDismiss();
            this.close();
          },
        }),
      );
      return;
    }

    // Fallback: simple vanilla DOM (staging mode, no item metadata)
    contentEl.createEl("h3", {
      text: `${suggestions.count} similar item${suggestions.count !== 1 ? "s" : ""} found`,
    });

    contentEl.createEl("p", {
      text: `These items may also belong in "${suggestions.targetName}". Would you like to move them too?`,
      cls: "roost-suggestion-desc",
    });

    const actions = contentEl.createDiv({ cls: "roost-suggestion-modal-actions" });

    const reviewBtn = actions.createEl("button", { text: "Review items", cls: "mod-cta" });
    reviewBtn.addEventListener("click", () => {
      this.opts.onReview(suggestions.itemIds);
      this.close();
    });

    const moveAllBtn = actions.createEl("button", { text: `Move all ${suggestions.count}` });
    moveAllBtn.addEventListener("click", () => {
      this.opts.onAccept(suggestions.itemIds);
      this.close();
    });

    const dismissBtn = actions.createEl("button", { text: "No thanks" });
    dismissBtn.addEventListener("click", () => {
      this.opts.onDismiss();
      this.close();
    });
  }

  onClose() {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}
