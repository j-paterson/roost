/**
 * Weekly digest command palette entries.
 */
import { Notice } from "obsidian";
import { runWeeklyDigest } from "@/pipeline/digest-pipeline";
import { currentWeekStart, weekIdFromStart, formatWeekHeading, weekEndFor } from "@/lib/week-boundary";
import { confirm } from "@/lib/confirm-modal";
import type { RoostCommandHost } from "@/plugin/roost-command-host";

export function registerDigestCommands(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "generate-weekly-digest",
    name: "Generate weekly digest",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      const today = new Date();
      const weekStart = currentWeekStart(today);
      const weekStartId = weekIdFromStart(weekStart);
      const headingLabel = formatWeekHeading(weekStart, weekEndFor(weekStart, today));
      const outPath = `Pipelines/Digest/Weekly/${weekStartId}.md`;

      const existing = plugin.app.vault.getAbstractFileByPath(outPath);
      if (existing) {
        const proceed = await confirm({
          app: plugin.app,
          title: "Regenerate weekly digest?",
          message: `A digest for ${headingLabel} already exists.\n\nRegenerate it now? Existing cluster summaries will be reused where item groupings haven't changed.`,
          confirmLabel: "Regenerate",
          cta: true,
        });
        if (!proceed) {
          log("Weekly digest cancelled (existing file kept).");
          return;
        }
      }

      log(`Starting weekly digest for ${headingLabel}`);
      try {
        const result = await runWeeklyDigest(plugin.app, plugin.settings.syncFolder, weekStart, log, plugin.settings);
        if (result.itemCount === 0) {
          new Notice(`No items in tracked buckets for ${headingLabel}.`);
          return;
        }
        new Notice(
          `Weekly digest: ${result.itemCount} items in ${result.clusterCount} cluster(s), ${result.cachedClusterCount} reused from cache.`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`Weekly digest failed: ${msg}`);
        new Notice(`Weekly digest failed: ${msg}`);
      }
    },
  });

  plugin.addCommand({
    id: "backfill-recent-weekly-digests",
    name: "Backfill last 4 weekly digests",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      const RECENT_WEEKS = 4;
      const today = new Date();
      const thisWeekStart = currentWeekStart(today);

      let generated = 0;
      let skipped = 0;
      let totalItems = 0;
      const failures: string[] = [];

      for (let i = 0; i < RECENT_WEEKS; i++) {
        const ws = new Date(
          thisWeekStart.getFullYear(),
          thisWeekStart.getMonth(),
          thisWeekStart.getDate() - 7 * i,
        );
        const wsId = weekIdFromStart(ws);
        const heading = formatWeekHeading(ws, weekEndFor(ws, today));
        const outPath = `Pipelines/Digest/Weekly/${wsId}.md`;

        if (plugin.app.vault.getAbstractFileByPath(outPath)) {
          log(`Skipping ${heading} — digest already exists.`);
          skipped++;
          continue;
        }

        log(`Generating ${heading}...`);
        try {
          const result = await runWeeklyDigest(plugin.app, plugin.settings.syncFolder, ws, log, plugin.settings);
          generated++;
          totalItems += result.itemCount;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`Failed ${heading}: ${msg}`);
          failures.push(`${heading} (${msg})`);
        }
      }

      const summary = failures.length > 0
        ? `Weekly digest backfill: ${generated} generated, ${skipped} skipped, ${failures.length} failed.`
        : `Weekly digest backfill: ${generated} generated, ${skipped} skipped (${totalItems} total items).`;
      log(summary);
      new Notice(summary);
    },
  });
}
