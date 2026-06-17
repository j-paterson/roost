import { Notice } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";

// Inlined to match the sibling backfills (they import only the EnrichmentDef *type*
// from enrichments.ts and inline their stamp string — importing the value here would
// create a runtime cycle: enrichments.ts → this file → enrichments.ts).
// Mirrors enrichmentVersionField("folder").
const FOLDER_STAMP = "enrichment_v_folder";

/** Frontmatter patch (passed to processFrontMatter) for one note, given whether the
 * live folder scan found it in a folder. `null` values delete the key. Pure. */
export function folderFrontmatterPatch(
  inFolder: boolean,
  folderName: string | null,
  fm: Record<string, unknown>,
  schemaVersion: number,
): Record<string, unknown> {
  const stamp = FOLDER_STAMP;
  if (!inFolder) {
    // Mark checked so it doesn't re-scan forever; change nothing else.
    return { [stamp]: schemaVersion };
  }
  const patch: Record<string, unknown> = {
    collection: folderName,
    roost_assigned_by: "human", // a human-curated grouping, not a roost guess
    [stamp]: schemaVersion,
  };
  // The human folder supersedes a stale AUTO category; never clobber a HUMAN one.
  if (fm.roost_category != null && fm.roost_assigned_by === "auto") {
    patch.roost_category = null; // null => processFrontMatter deletes the key
  }
  return patch;
}

/** Parse the probe's tweetCache JSON into tweetId -> folderName, keeping only
 * entries that carry a non-empty `_bookmark_folder`. Returns empty on bad input. */
export function parseFolderTweetMap(tweetCacheJson: string): Map<string, string> {
  const map = new Map<string, string>();
  let obj: unknown;
  try {
    obj = JSON.parse(tweetCacheJson);
  } catch {
    return map;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return map;
  for (const [id, entry] of Object.entries(obj as Record<string, unknown>)) {
    const folder = (entry as { _bookmark_folder?: unknown })?._bookmark_folder;
    if (typeof folder === "string" && folder.length > 0) map.set(id, folder);
  }
  return map;
}

export const FOLDER_SCHEMA_VERSION = 1;

/** Driver: live folder scan -> write rule over existing notes. Implemented in Task 4. */
export async function runFolderBackfill(plugin: IRoostPlugin): Promise<void> {
  void plugin;
  new Notice("Folder backfill not yet implemented.");
}

export const FOLDER_ENRICHMENT: EnrichmentDef = {
  id: "folder",
  displayName: "Bookmark folder",
  schemaVersion: FOLDER_SCHEMA_VERSION,
  commandId: "backfill-x-folders",
  commandName: "Backfill X bookmark folders",
  fieldsWritten: ["collection"],
  runBackfill: (plugin) => runFolderBackfill(plugin),
  panelDetail: "Already-synced X bookmarks with no folder tag yet. Backfill navigates your bookmark folders and records each tweet's folder in `collection` (human-assigned), superseding stale auto categories.",
};
