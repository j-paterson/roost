import { App, Modal, Setting } from "obsidian";

interface ConfirmOpts {
  app: App;
  /** Heading shown at the top of the modal. */
  title: string;
  /** Body text. May include newlines. */
  message: string;
  /** Label on the affirmative button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** When true, the confirm button gets the cta visual treatment.
   *  Default false — most uses are neutral. */
  cta?: boolean;
}

/**
 * Promise-based confirm dialog. Resolves true if the user clicked
 * Confirm, false on Cancel or Esc (modal close).
 *
 *   const ok = await confirm({ app, title: "...", message: "..." });
 *   if (!ok) return;
 */
export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new (class extends Modal {
      private decided = false;

      onOpen(): void {
        const { titleEl, contentEl } = this;
        titleEl.setText(opts.title);

        const body = contentEl.createDiv();
        // Preserve line breaks in the message without parsing markdown.
        for (const line of opts.message.split("\n")) {
          const p = body.createEl("p");
          p.setText(line);
        }

        new Setting(contentEl)
          .addButton((btn) => {
            btn.setButtonText("Cancel").onClick(() => {
              this.decided = true;
              resolve(false);
              this.close();
            });
          })
          .addButton((btn) => {
            btn.setButtonText(opts.confirmLabel ?? "Confirm");
            if (opts.cta) btn.setCta();
            btn.onClick(() => {
              this.decided = true;
              resolve(true);
              this.close();
            });
          });
      }

      onClose(): void {
        // Esc / overlay-click without choosing a button → treat as Cancel.
        if (!this.decided) resolve(false);
        this.contentEl.empty();
      }
    })(opts.app);

    modal.open();
  });
}
