/**
 * Command-palette entry to seed the training set from existing human labels.
 */
import { Notice } from "obsidian";
import { seedTrainingSetFromVault } from "@/pipeline/training-set-seed";
import type { RoostCommandHost } from "@/plugin/roost-command-host";

export function registerSeedCommands(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "seed-training-set",
    name: "Seed training set from existing labels",
    callback: () => {
      try {
        const { seeded, byClass } = seedTrainingSetFromVault(plugin.app, plugin.settings.syncFolder);
        const classes = Object.keys(byClass).length;
        const msg = `Seeded ${seeded} human labels across ${classes} categories into the training set.`;
        plugin.fireLog(msg);
        new Notice(msg);
      } catch (e) {
        const msg = `Seed training set failed: ${e instanceof Error ? e.message : String(e)}`;
        plugin.fireLog(msg);
        new Notice(msg);
      }
    },
  });
}
