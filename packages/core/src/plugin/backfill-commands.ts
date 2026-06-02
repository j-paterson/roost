/**
 * One-off backfill command palette entries (media IDs, X authors).
 */
import { Notice } from "obsidian";
import { runMediaPipeline } from "@/pipeline/media-pipeline";
import { backfillXAuthors } from "@/sync/x-author-backfill";
import type { RoostCommandHost } from "@/plugin/roost-command-host";

export function registerBackfillCommands(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "backfill-letterboxd-ids",
    name: "Backfill Letterboxd IDs (Films/Series/Documentaries)",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      log("Starting Letterboxd ID backfill");
      let total = 0;
      let failed = 0;
      for (const subcategory of ["Films", "Series", "Documentaries"]) {
        log(`Backfilling ${subcategory}...`);
        try {
          const result = await runMediaPipeline(
            plugin.app,
            plugin.settings.syncFolder,
            log,
            { category: "Media", subcategory },
            plugin.settings.tmdbApiKey,
          );
          total += result.letterboxdResolved ?? 0;
        } catch (e) {
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          log(`Letterboxd backfill failed for ${subcategory}: ${msg}`);
        }
      }
      const summary = failed > 0
        ? `Letterboxd backfill: ${total} resolved, ${failed} subcategory error(s).`
        : `Letterboxd backfill complete — ${total} items resolved.`;
      log(summary);
      new Notice(summary);
    },
  });

  plugin.addCommand({
    id: "backfill-anilist-ids",
    name: "Backfill AniList IDs (Anime)",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      log("Starting AniList ID backfill");
      try {
        const result = await runMediaPipeline(
          plugin.app,
          plugin.settings.syncFolder,
          log,
          { category: "Media", subcategory: "Anime" },
          "",
        );
        const matched = result.anilistResolved ?? 0;
        log(`AniList backfill complete — ${matched} items resolved.`);
        new Notice(`AniList backfill complete — ${matched} items resolved.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`AniList backfill failed: ${msg}`);
        new Notice(`AniList backfill failed: ${msg}`);
      }
    },
  });

  plugin.addCommand({
    id: "backfill-x-authors",
    name: "Backfill X authors (re-extract from raw.json)",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      log("Starting X author backfill…");
      try {
        const r = await backfillXAuthors(plugin.app, plugin.settings.syncFolder, log);
        const summary = `X author backfill complete — scanned ${r.scanned}, unknown ${r.matchedUnknown}, updated ${r.updated}, still unknown ${r.stillUnknown}, raw.json missing ${r.rawJsonMissing}, failed ${r.failed}.`;
        log(summary);
        new Notice(summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`X author backfill failed: ${msg}`);
        new Notice(`X author backfill failed: ${msg}`);
      }
    },
  });
}
