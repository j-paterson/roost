/**
 * Playback-URL enrichment — surfaces music items that need
 * `media_spotify_id` resolution as a backfill
 * row in the setup health panel.
 *
 * Detection (handled by VaultWriter.scanIncompleteIds): a music item
 * with neither field present in its frontmatter at all. Pipeline-
 * resolved items always have BOTH keys (one may be YAML null when
 * that platform didn't match), so "neither key present" is the clean
 * "never tried" signal.
 *
 * Backfill: runs the Media pipeline scoped to Music. The pipeline's
 * own cache + version field handle idempotency; this entry just
 * surfaces the entry point.
 */
import { Notice } from "obsidian";
import type { EnrichmentDef } from "@/lib/enrichments";
import type { IRoostPlugin } from "@/types/plugin";
import { runMediaPipeline } from "./media-pipeline";

async function runPlaybackBackfill(plugin: IRoostPlugin): Promise<void> {
  // Pipe through plugin.fireLog so progress lands in the sidebar log
  // panel — the same place sync logs appear. Otherwise the user sees
  // nothing but the final Notice.
  const log = (msg: string): void => { plugin.fireLog(msg); };
  log("Starting playback URL backfill (Media → Music)");
  const result = await runMediaPipeline(
    plugin.app,
    plugin.settings.syncFolder,
    log,
    { category: "Media", subcategory: "Music" },
  );
  const matched = result.playbackResolved ?? 0;
  log(`Playback backfill complete — ${matched} items resolved.`);
  // Force the Media list to re-read frontmatter and re-render. Obsidian's
  // Bases query doesn't auto-emit on frontmatter-content changes — only
  // the result-set shape — so without this poke the substitute view
  // keeps showing TT badges until the user navigates away+back.
  plugin.fireDataRefresh();
  new Notice(`Playback backfill complete — ${matched} music items resolved.`);
}

export const PLAYBACK_ENRICHMENT: EnrichmentDef = {
  id: "playback",
  displayName: "Music playback URLs",
  schemaVersion: 1,
  commandId: "backfill-music-playback",
  commandName: "Backfill music playback URLs (Spotify)",
  runBackfill: runPlaybackBackfill,
  panelDetail:
    "Music items with no Spotify track ID yet. Pulls IDs from " +
    "TikTok's DSP metadata (free, no API). Items without DSP data " +
    "fall back to playing the cached source video.",
};
