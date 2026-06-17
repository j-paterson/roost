/**
 * Command palette entry for reconciling cross-source collection mappings.
 */
import { Notice } from "obsidian";
import type { RoostCommandHost } from "@/plugin/roost-command-host";
import { buildRemapInputs } from "@/lib/collection-remap-inputs";
import { suggestCollectionMappings, applyResolvedMappings } from "@/lib/collection-remap";
import { loadCollectionAliases, saveCollectionAliases } from "@/lib/collection-aliases";
import { RemapConfirmModal } from "@/views/remap-confirm-modal";

/** Similarity at/above which we suggest mapping onto an existing category. */
const REMAP_THRESHOLD = 0.6;

export function registerRemapCommands(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "reconcile-collection-mappings",
    name: "Reconcile collection mappings",
    callback: () => {
      const app = plugin.app;
      const syncFolder = plugin.settings.syncFolder;
      // NOTE: the alias map is shared with the rename-category side effect in
      // use-roost-category-tree.ts (handleRenameCategory). We merge, never overwrite.
      const existing = loadCollectionAliases(app.vault);
      const { collections, categories } = buildRemapInputs(app, syncFolder);
      const suggestions = suggestCollectionMappings(collections, categories, existing, REMAP_THRESHOLD);
      const actionable = suggestions.filter((s) => s.action !== "skip");
      if (actionable.length === 0) {
        new Notice("Roost: no new collections to map.");
        return;
      }
      new RemapConfirmModal({
        app,
        suggestions,
        categoryNames: categories.map((c) => c.name),
        onConfirm: (resolved) => {
          const next = applyResolvedMappings(existing, resolved);
          saveCollectionAliases(app.vault, next);
          new Notice(`Roost: saved ${resolved.length} collection mapping(s).`);
        },
      }).open();
    },
  });
}
