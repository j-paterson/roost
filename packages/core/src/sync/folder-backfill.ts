import { App, Notice } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { getSyncFiles } from "@/lib/vault-utils";
import { folderListPageScript, folderTimelinePageScript } from "@/sync/folder-scan-script";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import twitterProbeSource from "@/probes/twitter-probe.probe";

/** Frontmatter patch (passed to processFrontMatter) for one note, given whether the
 * live folder scan found it in a folder. `null` values delete the key; an empty object
 * means "no change". Pure. */
export function folderFrontmatterPatch(
  inFolder: boolean,
  folderName: string | null,
  fm: Record<string, unknown>,
): Record<string, unknown> {
  if (!inFolder) return {}; // nothing to write
  const patch: Record<string, unknown> = {
    collection: folderName,
    roost_assigned_by: "human", // a human-curated grouping, not a roost guess
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
    // dom-ready re-injects the probe on every navigation (each full page load
    // clears the JS context). Combined with a reinject() BEFORE each loadURL, this
    // mirrors the proven e2e `injectProbeAndNavigate`. We must NOT reinject AFTER a
    // load: the slice/timeline ops fire during the load and a post-load reinject
    // would `delete` the store and wipe what was just captured (verified via the
    // live e2e — folder nav correctly tags tweets without a post-load reinject).
    webviewEl.addEventListener("dom-ready", reinject);
    const STORE = "window.__TWITTER_BOOKMARK_SPIKE__";
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const readObservedOps = (): Promise<number> =>
      wc.executeJavaScript(`(function(){try{return (${STORE}.observedOperations||[]).length;}catch(e){return 0;}})();`).then((n) => Number(n) || 0).catch(() => 0);
    /** Run an in-page page-fetcher and parse its JSON ({...} or {error}); null on hard failure. */
    const execPage = async (script: string): Promise<unknown> => {
      try { return JSON.parse((await wc.executeJavaScript(script)) as string); } catch { return null; }
    };
    /** execPage with up to 3 retries on error/null (transient 503s / rate limits). */
    const execPageR = async (script: string): Promise<unknown> => {
      let r = await execPage(script);
      for (let i = 0; (r === null || (r as { error?: string } | null)?.error) && i < 3; i++) {
        await sleep(3000);
        r = await execPage(script);
      }
      return r;
    };
    /** Mirrors the e2e injectProbeAndNavigate: reinject (seed) → loadURL → settle.
     *  The probe is (re)injected via dom-ready on the new page; we never reinject after. */
    const navigate = async (url: string): Promise<boolean> => {
      reinject();
      const ok = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 15000); const h = () => { clearTimeout(t); res(true); }; webviewEl.addEventListener("did-finish-load", h, { once: true }); webviewEl.loadURL(url); });
      await sleep(4000); // SPA boot + GraphQL (matches the live spec)
      return ok;
    };
    try {
      // 1. Load bookmarks; BookmarkFoldersSlice fires → probe captures the
      //    folder-LIST replay template. Confirm the probe is alive + logged in.
      await navigate("https://x.com/i/bookmarks");
      const ops = await readObservedOps();
      if (ops === 0) {
        log("probe observed 0 graphql ops — not logged into X, or the webview is blocked");
        new Notice("Folder backfill: the X webview saw no traffic — open Roost and confirm you're logged into X.");
        return;
      }
      log(`probe alive (${ops} ops observed); paging the folder list...`);

      // 2. Page the folder LIST via cursor replay (DOM scroll does NOT paginate it).
      const folders = new Map<string, string>(); // id -> name
      let lcursor: string | null = null;
      for (let page = 0; page < 40; page++) {
        const res = (await execPageR(folderListPageScript(lcursor))) as { folders?: Record<string, string>; nextCursor?: string | null; error?: string } | null;
        if (!res || res.error) { log(`folder-list page ${page + 1} error: ${res?.error ?? "no result"}`); break; }
        const before = folders.size;
        for (const [id, name] of Object.entries(res.folders ?? {})) folders.set(id, name);
        log(`folder list: +${folders.size - before} (total ${folders.size})`);
        lcursor = res.nextCursor ?? null;
        if (!lcursor || folders.size === before) break;
        await sleep(400);
      }
      if (folders.size === 0) {
        new Notice("Folder backfill: no bookmark folders found.");
        return;
      }
      log(`Found ${folders.size} bookmark folders`);

      // 3. Navigate ONE folder so the probe captures the folder-TIMELINE replay template.
      const firstId = folders.keys().next().value as string;
      await navigate(`https://x.com/i/bookmarks/${firstId}`);

      // 4. Page EACH folder's timeline via cursor replay; log per folder as we go.
      const folderByTweet = new Map<string, string>(); // tweetId -> folder name (first wins)
      let fi = 0;
      for (const [fid, fname] of folders) {
        fi++;
        let tcursor: string | null = null; let n = 0;
        for (let page = 0; page < 80; page++) {
          const res = (await execPageR(folderTimelinePageScript(fid, tcursor))) as { ids?: string[]; nextCursor?: string | null; error?: string } | null;
          if (!res || res.error) { log(`  [${fi}/${folders.size}] "${fname}" page ${page + 1} error: ${res?.error ?? "no result"}`); break; }
          const ids = res.ids ?? [];
          for (const tid of ids) { if (!folderByTweet.has(tid)) folderByTweet.set(tid, fname); n += 1; }
          tcursor = res.nextCursor ?? null;
          if (ids.length === 0 || !tcursor) break;
          await sleep(400);
        }
        log(`  [${fi}/${folders.size}] "${fname}": ${n} tweets`);
      }
      log(`${folderByTweet.size} tweets across ${folders.size} folders`);

      // 5. Apply to existing notes.
      const r = await applyFolderMapToNotes(app, syncFolder, folderByTweet, log);
      new Notice(`Folder backfill: ${r.tagged} tagged, ${r.clearedAuto} auto-categories cleared.`);
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

/** Apply the folder map to existing Twitter notes. Idempotent by data: a note whose
 *  `collection` already equals the intended value is skipped (covers already-tagged and
 *  not-in-a-folder), and an in-name-only change with nothing to write produces no I/O. */
export async function applyFolderMapToNotes(
  app: App,
  syncFolder: string,
  folderByTweet: Map<string, string>,
  log: (m: string) => void = () => {},
): Promise<{ tagged: number; clearedAuto: number }> {
  let tagged = 0, clearedAuto = 0, writes = 0;
  const files = getSyncFiles(app.vault, syncFolder);
  log(`writing folder tags to notes (cloud-synced vault writes can be slow)...`);
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.platform !== "twitter") continue;
    const id = fm.roost_id as string | undefined;
    if (!id) continue;
    // roost_id is platform-prefixed ("twitter:<rest_id>"); folderByTweet keys are the
    // bare rest_id from the GraphQL response — strip the prefix before lookup.
    const restId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
    const intended = folderByTweet.get(restId) ?? null;
    const current = (fm.collection as string | undefined) ?? null;
    if (intended === current) continue; // already correct, or not in a folder
    const inFolder = folderByTweet.has(restId);
    const patch = folderFrontmatterPatch(inFolder, intended, fm);
    if (Object.keys(patch).length === 0) continue; // nothing to write
    await app.fileManager.processFrontMatter(file, (front) => {
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete front[k]; else front[k] = v; }
    });
    if (inFolder) { tagged++; if ("roost_category" in patch) clearedAuto++; }
    if (++writes % 200 === 0) log(`  ...wrote ${writes} notes so far (tagged ${tagged})`);
  }
  log(`applied: ${tagged} tagged, ${clearedAuto} cleared-auto`);
  return { tagged, clearedAuto };
}

