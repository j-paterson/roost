/**
 * One-time seed of human-"Other" bookmark collections as belongs-to-nothing.
 *
 * Items with a human-assigned `collection: "Other"` are explicitly saying
 * "fits nothing." This command seeds them with the BELONGS_NOTHING sentinel
 * so they become the initial gold OOD set and hard-negatives for training.
 * Idempotent — already-stamped items are skipped.
 */
import type { TFile } from "obsidian";
import { Notice } from "obsidian";
import { isBelongsNothingFm } from "@/lib/vault-utils";
import { markBelongsNothingItem } from "@/pipeline/training-actions";
import type { RoostCommandHost } from "@/plugin/roost-command-host";

export interface OtherItem {
  id: string;
  collection?: string | null;
  assignedBy?: string | null;
  belongsNothing?: boolean;
}

/**
 * Pure selector: returns ids that should be seeded as belongs-to-nothing.
 *
 * An item qualifies when:
 *  - `collection` is present and lowercases to "other"
 *  - `assignedBy !== "auto"` (human label, not a Roost auto-assignment)
 *  - `belongsNothing` is not already true (idempotent skip)
 */
export function humanOtherIds(items: OtherItem[]): string[] {
  return items
    .filter(
      (item) =>
        typeof item.collection === "string" &&
        item.collection.toLowerCase() === "other" &&
        item.assignedBy !== "auto" &&
        !item.belongsNothing,
    )
    .map((item) => item.id);
}

/**
 * Orchestrator: iterates sync-folder Bookmarks notes, seeds human-"Other" items
 * as belongs-to-nothing. Idempotent — the belongsNothing filter + isBelongsNothingFm
 * check means already-stamped notes are silently skipped.
 */
export async function seedHumanOtherAsBelongsNothing(
  plugin: RoostCommandHost,
): Promise<{ seeded: number }> {
  const { app, settings } = plugin;
  const { vault, fileManager, metadataCache } = app;
  const now = Date.now();

  const files = vault
    .getMarkdownFiles()
    .filter((f: TFile) => f.path.startsWith(settings.syncFolder + "/"));

  type ItemWithFile = OtherItem & { file: TFile };
  const items: ItemWithFile[] = [];

  for (const file of files) {
    const fm = metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const id = typeof fm.roost_id === "string" ? fm.roost_id : null;
    if (!id) continue;
    items.push({
      id,
      collection: (fm.collection as string | undefined) ?? null,
      assignedBy: (fm.roost_assigned_by as string | undefined) ?? null,
      belongsNothing: isBelongsNothingFm(fm),
      file,
    });
  }

  const selectedIds = new Set(humanOtherIds(items));
  let seeded = 0;

  for (const item of items) {
    if (!selectedIds.has(item.id)) continue;
    await markBelongsNothingItem({
      vault,
      fileManager,
      file: item.file,
      id: item.id,
      now,
    });
    seeded++;
  }

  return { seeded };
}

/**
 * Register the "Roost: Seed human-'Other' as belongs-to-nothing" command.
 * Mirrors the pattern used by registerSeedCommands in seed-commands.ts.
 */
export function registerSeedBelongsNothingCommand(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "seed-belongs-nothing",
    name: "Seed human-'Other' as belongs-to-nothing",
    callback: () => {
      void seedHumanOtherAsBelongsNothing(plugin).then(({ seeded }) => {
        const msg = `Seeded ${seeded} human-'Other' bookmark(s) as belongs-to-nothing.`;
        plugin.fireLog(msg);
        new Notice(msg);
      }).catch((e: unknown) => {
        const msg = `Seed belongs-nothing failed: ${e instanceof Error ? e.message : String(e)}`;
        plugin.fireLog(msg);
        new Notice(msg);
      });
    },
  });
}
