import { Modal, App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import * as React from "react";
import { Button } from "@/ui/components/ui/button";

interface ConfirmMergeOpts {
  app: App;
  sourceName: string;
  targetName: string;
  previewTitles: string[];
  itemCount: number;
  title?: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}

interface ConfirmMergeOverlayProps {
  sourceName: string;
  targetName: string;
  previewTitles: string[];
  itemCount: number;
  /** Optional custom header. Defaults to "Merge collection?" for the
   *  merge flow; renest flows pass their own copy. */
  title?: string;
  /** Optional custom body sentence. When provided, replaces the default
   *  "Move all N items from X into Y?" copy. */
  body?: React.ReactNode;
  /** Optional confirm-button label. Defaults to "Merge {count}". */
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

function ConfirmMergeOverlay({ sourceName, targetName, previewTitles, itemCount, title, body, confirmLabel, onConfirm, onCancel }: ConfirmMergeOverlayProps) {
  const [busy, setBusy] = React.useState(false);
  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="text-base font-semibold">{title ?? "Merge collection?"}</div>
      <div>
        {body ?? (
          <>
            <strong>{itemCount}</strong> items: <strong>{sourceName}</strong> → <strong>{targetName}</strong>
          </>
        )}
      </div>
      {previewTitles.length > 0 && (
        <div
          className="border border-border rounded px-2 py-1"
          style={{ background: "var(--background-secondary)" }}
        >
          {previewTitles.map((t, i) => (
            <div
              key={i}
              style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={t}
            >
              {t}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="suggested" size="sm" onClick={handleConfirm} loading={busy}>
          {busy ? "Working" : (confirmLabel ?? `Merge ${itemCount}`)}
        </Button>
      </div>
    </div>
  );
}

export class ConfirmMergeModal extends Modal {
  private root: Root | null = null;
  private opts: ConfirmMergeOpts;

  constructor(opts: ConfirmMergeOpts) {
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
      createElement(ConfirmMergeOverlay, {
        sourceName: this.opts.sourceName,
        targetName: this.opts.targetName,
        previewTitles: this.opts.previewTitles,
        itemCount: this.opts.itemCount,
        title: this.opts.title,
        body: this.opts.body,
        confirmLabel: this.opts.confirmLabel,
        onConfirm: async () => {
          await this.opts.onConfirm();
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
