import { Modal, App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { Button } from "@/ui/components/ui/button";

export type ConfirmScopeKind = "resort" | "subcategorize";

export interface ConfirmScopeOpts {
  app: App;
  kind: ConfirmScopeKind;
  categoryName: string;
  itemCount: number;
  onConfirm: () => void;
}

interface ConfirmScopeOverlayProps {
  kind: ConfirmScopeKind;
  categoryName: string;
  itemCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmScopeOverlay({ kind, categoryName, itemCount, onConfirm, onCancel }: ConfirmScopeOverlayProps) {
  const title = kind === "resort"
    ? `Resort "${categoryName}"?`
    : `Sort "${categoryName}" into subcategories?`;
  const confirmLabel = kind === "resort" ? "Resort" : "Sort";
  const plural = itemCount === 1 ? "item" : "items";

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="text-base font-semibold">{title}</div>
      <div>
        {itemCount} {plural}. This will run Smart Assign and may take several minutes.
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="suggested" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  );
}

export class ConfirmScopeModal extends Modal {
  private root: Root | null = null;
  private opts: ConfirmScopeOpts;

  constructor(opts: ConfirmScopeOpts) {
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
      createElement(ConfirmScopeOverlay, {
        kind: this.opts.kind,
        categoryName: this.opts.categoryName,
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
