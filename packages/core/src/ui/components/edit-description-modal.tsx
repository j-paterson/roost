/**
 * EditDescriptionModal — opens from the ✎ icon on a newly-discovered category
 * folder in the Smart Assign staging tree. Lets the user edit the category's
 * description and NOT description. Edits persist to disk on Save.
 *
 * Modal pattern follows item-modal.ts / suggestion-modal.ts: an Obsidian
 * Modal subclass that mounts a React tree via createRoot in onOpen and
 * unmounts in onClose.
 */
import * as React from "react";
import { App, Modal } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "@/ui/components/ui/button";

export interface EditDescriptionFormProps {
  categoryName: string;
  initialDescription: string;
  initialNotDescription: string;
  onSave: (description: string, notDescription: string) => void;
  onCancel: () => void;
}

export function EditDescriptionForm({
  categoryName,
  initialDescription,
  initialNotDescription,
  onSave,
  onCancel,
}: EditDescriptionFormProps) {
  const [description, setDescription] = React.useState(initialDescription);
  const [notDescription, setNotDescription] = React.useState(initialNotDescription);

  return (
    <div className="flex flex-col gap-3" style={{ minWidth: 360 }}>
      <div>
        <h2 className="text-sm font-medium">Edit description: {categoryName}</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          These descriptions guide future Smart Assign runs and Vault Health
          checks. Edits affect this category from now on, not the current
          proposal.
        </p>
      </div>

      <label className="block text-xs" style={{ color: "var(--text-muted)" }}>
        Description
      </label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        style={{
          width: "100%",
          fontSize: 12,
          padding: "6px 8px",
          background: "var(--background-primary)",
          color: "var(--text-normal)",
          border: "1px solid var(--background-modifier-border)",
          borderRadius: 4,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />

      <label className="block text-xs" style={{ color: "var(--text-muted)" }}>
        NOT (items that should <em>not</em> be in this category)
      </label>
      <textarea
        value={notDescription}
        onChange={(e) => setNotDescription(e.target.value)}
        rows={2}
        style={{
          width: "100%",
          fontSize: 12,
          padding: "6px 8px",
          background: "var(--background-primary)",
          color: "var(--text-normal)",
          border: "1px solid var(--background-modifier-border)",
          borderRadius: 4,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />

      <div className="flex justify-end gap-2 mt-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="suggested" size="sm" onClick={() => onSave(description, notDescription)}>Save</Button>
      </div>
    </div>
  );
}

export class EditDescriptionModal extends Modal {
  private root: Root | null = null;

  constructor(
    app: App,
    private opts: {
      categoryName: string;
      initialDescription: string;
      initialNotDescription: string;
      onSave: (description: string, notDescription: string) => Promise<void> | void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.root = createRoot(this.contentEl);
    this.root.render(
      <EditDescriptionForm
        categoryName={this.opts.categoryName}
        initialDescription={this.opts.initialDescription}
        initialNotDescription={this.opts.initialNotDescription}
        onSave={async (desc, notDesc) => {
          await this.opts.onSave(desc, notDesc);
          this.close();
        }}
        onCancel={() => this.close()}
      />
    );
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}
