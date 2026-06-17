import { App, Notice, TFile } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";
import { getSyncFiles } from "@/lib/vault-utils";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import twitterProbeSource from "@/probes/twitter-probe.probe";

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

let folderBackfillRunning = false;

/** Driver: live folder scan -> write rule over existing notes. */
export async function runFolderBackfill(plugin: IRoostPlugin): Promise<void> {
  if (folderBackfillRunning) { new Notice("Folder backfill already running."); return; }
  folderBackfillRunning = true;
  const log = (m: string) => plugin.fireLog("[folder-backfill] " + m);
  try {
    const app = plugin.app;
    const syncFolder = plugin.settings.syncFolder;

    // 1. Webview bootstrap — VERBATIM from thread-backfill.ts.
    const wm = plugin.getWebviewManager();
    let wcReady = wm.getWebContents("twitter");
    if (!wcReady) {
      const deadline = Date.now() + 8000;
      while (!wcReady && Date.now() < deadline) { await new Promise(r => setTimeout(r, 300)); wcReady = wm.getWebContents("twitter"); }
    }
    if (!wcReady) { new Notice("Folder backfill failed: X webview not ready (open Roost + log in to X)."); return; }
    const wc = wcReady;
    const webviewEl = wm.getElement("twitter");
    if (!webviewEl) { new Notice("Folder backfill failed: X webview element missing."); return; }
    const reinject = (): void => {
      wc.executeJavaScript(`try{delete window.__TWITTER_BOOKMARK_SPIKE__;}catch(e){} try{${twitterProbeSource}}catch(e){} void 0;`).catch(() => {});
    };
    // The dom-ready listener re-injects the probe on EVERY navigation (each full
    // page load clears the JS context). This is the only reinjection mechanism —
    // a manual reinject() would `delete` the store and wipe what was just captured.
    webviewEl.addEventListener("dom-ready", reinject);
    const readTweetCache = () =>
      wc.executeJavaScript(`(function(){try{return JSON.stringify(window.__TWITTER_BOOKMARK_SPIKE__.tweetCache||{});}catch(e){return '{}';}})();`).catch(() => "{}");
    try {
      // 1. Load bookmarks home; dom-ready injects the probe before the
      //    BookmarkFoldersSlice op fires, so the folder list is captured.
      await new Promise<void>((res) => { const h = () => res(); webviewEl.addEventListener("did-finish-load", h, { once: true }); webviewEl.loadURL("https://x.com/i/bookmarks"); });
      await new Promise(r => setTimeout(r, 3000)); // let BookmarkFoldersSlice fire + be captured

      // 2. Folder list from the probe store (no reinject here — it would wipe it).
      const rawFolders = await wc.executeJavaScript(`(function(){try{var s=window.__TWITTER_BOOKMARK_SPIKE__;return JSON.stringify(Object.entries(s.bookmarkFolders||{}).map(function(e){return {id:e[0],name:e[1]};}));}catch(e){return '[]';}})();`).catch(() => "[]");
      const folders: { id: string; name: string }[] = JSON.parse(rawFolders);
      log(`Found ${folders.length} bookmark folders`);

      // 3. Navigate each folder; read its tweets IMMEDIATELY — the next
      //    navigation clears the context and the dom-ready reinject resets the
      //    store, so a single read at the end would only see the last folder.
      const folderByTweet = new Map<string, string>();
      for (const folder of folders) {
        log(`Loading folder: ${folder.name}...`);
        const loaded = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 15000); const h = () => { clearTimeout(t); res(true); }; webviewEl.addEventListener("did-finish-load", h, { once: true }); webviewEl.loadURL(`https://x.com/i/bookmarks/${folder.id}`); });
        if (!loaded) { log(`[WARN] Folder "${folder.name}" failed to load — skipping`); continue; }
        await new Promise(r => setTimeout(r, 3000)); // BookmarkFolderTimeline fires; probe tags tweets
        const thisFolder = parseFolderTweetMap(await readTweetCache());
        for (const [id, name] of thisFolder) folderByTweet.set(id, name);
        log(`  "${folder.name}": ${thisFolder.size} tweets`);
      }
      log(`${folderByTweet.size} tweets are in folders`);

      // 4. Apply to existing notes.
      const r = await applyFolderMapToNotes(app, syncFolder, folderByTweet, log);
      new Notice(`Folder backfill: ${r.tagged} tagged, ${r.clearedAuto} auto-categories cleared, ${r.stampedOnly} marked checked.`);
    } finally {
      webviewEl.removeEventListener("dom-ready", reinject);
    }
  } catch (e) {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    new Notice("Folder backfill failed — see console.");
  } finally {
    folderBackfillRunning = false;
  }
}

/** Apply the folder map to every existing Twitter note, stamping each (folder or not). */
async function applyFolderMapToNotes(
  app: App,
  syncFolder: string,
  folderByTweet: Map<string, string>,
  log: (m: string) => void,
): Promise<{ tagged: number; clearedAuto: number; stampedOnly: number }> {
  let tagged = 0, clearedAuto = 0, stampedOnly = 0;
  const files = getSyncFiles(app.vault, syncFolder).filter((f): f is TFile => f instanceof TFile);
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.platform !== "twitter") continue;
    const id = fm.roost_id as string | undefined;
    if (!id) continue;
    if (fm[FOLDER_STAMP] === FOLDER_SCHEMA_VERSION) continue; // idempotent
    const inFolder = folderByTweet.has(id);
    const patch = folderFrontmatterPatch(inFolder, folderByTweet.get(id) ?? null, fm, FOLDER_SCHEMA_VERSION);
    await app.fileManager.processFrontMatter(file, (front) => {
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete front[k]; else front[k] = v; }
    });
    if (inFolder) { tagged++; if ("roost_category" in patch) clearedAuto++; } else { stampedOnly++; }
  }
  log(`applied: ${tagged} tagged, ${clearedAuto} cleared-auto, ${stampedOnly} stamped-only`);
  return { tagged, clearedAuto, stampedOnly };
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
