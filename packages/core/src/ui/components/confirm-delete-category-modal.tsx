import { Modal, App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { Button } from "@/ui/components/ui/button";

export type ConfirmDeleteKind = "category" | "subcategory";

export interface ConfirmDeleteOpts {
  app: App;
  kind: ConfirmDeleteKind;
  categoryName: string;
  subcategoryName?: string;
  itemCount: number;
  onConfirm: () => void;
}

interface OverlayProps {
  kind: ConfirmDeleteKind;
  categoryName: string;
  subcategoryName?: string;
  itemCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDeleteOverlay({ kind, categoryName, subcategoryName, itemCount, onConfirm, onCancel }: OverlayProps) {
  const isCategory = kind === "category";
  const targetName = isCategory ? categoryName : subcategoryName;
  const title = isCategory
    ? `Remove category "${categoryName}"?`
    : `Remove subcategory "${subcategoryName}" from "${categoryName}"?`;
  const plural = itemCount === 1 ? "item" : "items";
  const detail = isCategory
    ? `${itemCount} ${plural} will lose their roost_category and roost_subcategory frontmatter. The notes themselves are not deleted.`
    : `${itemCount} ${plural} will lose their roost_subcategory frontmatter and stay in "${categoryName}".`;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="text-base font-semibold">{title}</div>
      <div>{detail}</div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          {isCategory ? "Remove category" : "Remove subcategory"}
        </Button>
      </div>
    </div>
  );
}

export class ConfirmDeleteCategoryModal extends Modal {
  private root: Root | null = null;
  private opts: ConfirmDeleteOpts;

  constructor(opts: ConfirmDeleteOpts) {
    super(opts.app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("roost-modal-content");

    const mountEl = contentEl.createDiv();
    this.root = createRoot(mountEl);
    this.root.render(
      createElement(ConfirmDeleteOverlay, {
        kind: this.opts.kind,
        categoryName: this.opts.categoryName,
        subcategoryName: this.opts.subcategoryName,
        itemCount: this.opts.itemCount,
        onConfirm: () => {
          this.opts.onConfirm();
          this.close();
        },
        onCancel: () => this.close(),
      }),
    );
  }

  onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
