/**
 * One-shot backfill: walk all X bookmark raw.json files, fetch article bodies
 * for those with stub-only article_results, write back the enriched raw.json
 * and re-render note bodies.
 *
 * Resumable via .roost/article-fetch-cache.json — successful fetches and
 * failed-with-404 fetches are persisted; failed-with-other reasons are retried.
 *
 * Triggered from the Obsidian command palette: "Backfill X Article bodies".
 */
import * as fs from "fs";
import * as path from "path";
import { Notice } from "obsidian";
import { ArticleFetcher } from "@/sync/article-fetcher";
import { VaultWriter } from "@/sync/vault-writer";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import { walkDir } from "@/lib/fs-walk";
import {
  getArticleResultFromRaw,
  articleHostTweetId,
  mergeArticleContentInto,
} from "@/lib/article-utils";
import { articleWordCount } from "@/lib/article-extract";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import twitterProbeSource from "@/probes/twitter-probe.probe";

interface BackfillCacheEntry {
  ok: boolean;
  reason?: string;
  fetchedAt: number;   // unix seconds
  wordCount?: number;
}
type BackfillCache = Record<string, BackfillCacheEntry>;

const CACHE_TTL_404_DAYS = 7;

let backfillRunning = false;

export async function runArticleBackfill(plugin: IRoostPlugin): Promise<void> {
  if (backfillRunning) {
    new Notice("Backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
  const log = (msg: string) => {
    plugin.fireLog("[backfill] " + msg);
  };

  const vaultRoot = vaultBasePath(plugin.app.vault);
  if (!vaultRoot) {
    new Notice("Backfill failed: cannot locate vault path.");
    return;
  }
  const roostDir = cacheDir(vaultRoot);
  fs.mkdirSync(roostDir, { recursive: true });
  const cachePath = path.join(roostDir, "article-fetch-cache.json");

  const cache: BackfillCache = (() => {
    try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
  })();
  const now = Math.floor(Date.now() / 1000);
  const cacheTtl = CACHE_TTL_404_DAYS * 24 * 3600;

  const xRoot = path.join(vaultRoot, plugin.settings.syncFolder, "X");
  if (!fs.existsSync(xRoot)) {
    new Notice(`Backfill: no ${plugin.settings.syncFolder}/X folder. Sync first.`);
    return;
  }

  // Queue is deduped by tweetId: an article can appear in multiple bookmarks
  // (e.g., re-quoted by different tweets), but we only need to fetch it once.
  // Keep the FIRST occurrence's rawPath; subsequent bookmarks pointing at the
  // same article will get the merged content_state on the next sync via the
  // sync-time article-fetch phase.
  // One pass: build the fetch queue AND count articles already on disk.
  // articlesOnDisk drives the post-fetch sweep that refreshes note bodies
  // for items whose raw.json has content_state but whose .md may not have
  // been re-rendered yet.
  const queue: { tweetId: string; rawPath: string }[] = [];
  const seenTweetIds = new Set<string>();
  let dupSkipped = 0;
  let articlesOnDisk = 0;
  walkDir(xRoot, (filePath) => {
    if (!filePath.endsWith("raw.json")) return;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
    const ar = getArticleResultFromRaw(raw);
    if (!ar) return;
    if (ar.content_state) { articlesOnDisk++; return; }
    const tweetId = articleHostTweetId(raw);
    if (!tweetId) return;

    const cached = cache[tweetId];
    if (cached?.ok) return;
    if (cached && !cached.ok && cached.reason === "404" && now - cached.fetchedAt < cacheTtl) return;

    if (seenTweetIds.has(tweetId)) { dupSkipped++; return; }
    seenTweetIds.add(tweetId);
    queue.push({ tweetId, rawPath: filePath });
  });

  if (queue.length === 0 && articlesOnDisk === 0) {
    new Notice("No articles need backfill.");
    return;
  }

  if (queue.length > 0) {
    log(`Queue size: ${queue.length}${dupSkipped > 0 ? ` (deduped ${dupSkipped} dupes)` : ""}`);
    if (articlesOnDisk > 0) log(`(${articlesOnDisk} articles already on disk — note bodies will be refreshed)`);
    new Notice(`Backfilling ${queue.length} articles…`);
  } else {
    log(`No new articles to fetch. Refreshing note bodies for ${articlesOnDisk} articles already on disk...`);
    new Notice(`Refreshing ${articlesOnDisk} article note bodies…`);
  }

  // 4. Set up VaultWriter — needed for both fetch path AND refresh-only path.
  const writer = new VaultWriter({
    vault: plugin.app.vault,
    syncFolder: plugin.settings.syncFolder,
    metadataCache: plugin.app.metadataCache,
    onLog: log,
  });
  // Populate the notePathMap so findNoteForId can resolve Eagle-imported notes.
  await writer.scanIncompleteIds().catch(() => {});

  // The probe-listener teardown helper is declared up-front so the fetch path
  // can register one and the sweep path doesn't need to (it doesn't touch the
  // webview). Set to a no-op when no fetch is needed.
  let removeProbeListener = (): void => {};

  // 5. If queue.length > 0, set up webview + probe + capture auth headers,
  //    then run the fetcher. Skip this whole block when queue is empty
  //    (refresh-only mode — no need to touch x.com at all).
  if (queue.length > 0) {
    const wm = plugin.getWebviewManager();
    let wcReady = wm.getWebContents("twitter");
    if (!wcReady) {
      const deadline = Date.now() + 8000;
      while (!wcReady && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300));
        wcReady = wm.getWebContents("twitter");
      }
    }
    if (!wcReady) {
      new Notice("Backfill failed: X webview not ready (dom-ready never fired).");
      return;
    }

    // 5a. Inject the probe + navigate to /i/bookmarks so the probe captures a
    //     real authenticated GraphQL request (Bookmarks fires reliably). The
    //     probe is normally injected by syncTwitter's dom-ready handler, but
    //     the backfill bypasses syncTwitter so we must inject ourselves.
    const webviewEl = wm.getElement("twitter");
    if (!webviewEl) {
      new Notice("Backfill failed: X webview element missing.");
      return;
    }
    log("Injecting probe + loading bookmarks to capture auth headers...");
    // Keep the listener alive for the WHOLE backfill so any unexpected
    // navigation (Twitter occasionally redirects) doesn't lose the probe.
    const reinject = (): void => {
      wcReady!.executeJavaScript(`
        try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
        try { ${twitterProbeSource}; } catch(e) {}
        void 0;
      `).catch(() => {});
    };
    webviewEl.addEventListener("dom-ready", reinject);

    let probeListenerActive = true;
    removeProbeListener = (): void => {
      if (!probeListenerActive) return;
      webviewEl.removeEventListener("dom-ready", reinject);
      probeListenerActive = false;
    };

    try {
      reinject();
      webviewEl.loadURL("https://x.com/i/bookmarks");

      const replayDeadline = Date.now() + 30_000;
      let captured = false;
      while (!captured && Date.now() < replayDeadline) {
        await new Promise(r => setTimeout(r, 1000));
        captured = await wcReady.executeJavaScript(
          "!!(window.__TWITTER_BOOKMARK_SPIKE__ && (window.__TWITTER_BOOKMARK_SPIKE__.anyAuthGraphqlReplay || window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay))"
        ).catch(() => false);
      }
      if (!captured) {
        log("Backfill: timed out waiting for auth'd GraphQL request — is the X webview logged in?");
        new Notice("Backfill failed: no authenticated X request observed. Open the X view and confirm you're logged in.");
        removeProbeListener();
        return;
      }
      log("Auth headers captured — proceeding to article fetch");
    } catch (e) {
      removeProbeListener();
      throw e;
    }
  }

  // 5b. Run the fetcher.
  //    Disk persistence happens INSIDE the onProgress callback (per-item) so
  //    that successful fetches survive a mid-run process exit. The previous
  //    architecture buffered all results and wrote them in a post-await loop —
  //    killing Obsidian mid-run lost everything. Now: each fetched article hits
  //    raw.json + cache + note body immediately as it completes.
  let succeeded = 0;
  let failed = 0;

  // 6. Fetch loop — only when there are items to fetch.
  if (queue.length > 0) {
  const wcReady = plugin.getWebviewManager().getWebContents("twitter");
  if (!wcReady) {
    log("Backfill: webview disappeared after capture phase — aborting fetch.");
    removeProbeListener();
    return;
  }
  const fetcher = new ArticleFetcher(wcReady, wcReady, log);
  await fetcher.fetchMany(
    queue.map(q => q.tweetId),
    (done, total, last) => {
      const q = queue[done - 1];
      if (last) {
        log(`Item ${done}/${total}: ${last.tweetId} ${last.ok ? "OK" : "FAIL(" + last.reason + ")"}`);
      }

      // Persist this item's result IMMEDIATELY (success or classified failure).
      if (last?.ok && last.rawTweet) {
        try {
          const existing = JSON.parse(fs.readFileSync(q.rawPath, "utf8"));
          // mergeArticleContentInto expects { rawData } — wrap the raw object.
          const wrapper = { rawData: existing };
          mergeArticleContentInto(wrapper, last.rawTweet as Record<string, unknown>);
          fs.writeFileSync(q.rawPath, JSON.stringify(existing, null, 2));
          const ar = getArticleResultFromRaw(existing);
          cache[last.tweetId] = {
            ok: true,
            fetchedAt: now,
            wordCount: ar?.content_state ? articleWordCount(ar) : 0,
          };
          // Fire-and-forget: refresh the note body in the vault. The note file
          // belongs to the OUTER bookmark (the tweet whose raw.json we read),
          // not to the article's own tweet ID. For quoted-article bookmarks the
          // article's tweet ID differs from the outer bookmark — we must use
          // the outer bookmark's ID to find its .md note. Derive that from the
          // raw.json's directory: `Bookmarks/X/twitter-{outerId}/raw.json`.
          const outerDirName = path.basename(path.dirname(q.rawPath));
          // outerDirName is like "twitter-1234567890". Strip the platform prefix.
          const outerItemId = outerDirName.replace(/^twitter-/, "");
          const record = {
            id: `twitter:${outerItemId}`,
            platform: "twitter" as const,
            itemId: outerItemId,
            rawData: existing as Record<string, unknown>,
            saved_at: new Date().toISOString(),
            published_at: null,
            captured_via: "backfill",
          };
          writer.rewriteNoteBody(record).catch((e: unknown) => {
            log(`rewriteNoteBody failed for ${last.tweetId} (note ${outerItemId}): ${e instanceof Error ? e.message : String(e)}`);
          });
          succeeded++;
        } catch (e: unknown) {
          log(`Failed to write ${q.rawPath}: ${e instanceof Error ? e.message : String(e)}`);
          failed++;
        }
      } else if (last && !last.ok) {
        failed++;
        if (last.reason !== "no-replay") {
          cache[last.tweetId] = { ok: false, reason: last.reason, fetchedAt: now };
        }
      }

      // Periodic cache flush. The per-item raw.json writes above are already
      // durable; this just persists the cache index every 10 items so the next
      // run's queue-construction filter ("skip if cached.ok") works correctly
      // even if the process is killed mid-run.
      if (done % 10 === 0 || done === total) {
        log(`Progress: ${done}/${total}`);
        try {
          fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
        } catch { /* periodic flush is best-effort */ }
      }
    },
  );

  // Final cache persist (catches the last <10 items not covered by periodic flushes).
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } // end if (queue.length > 0)

  // 7. Sweep: refresh note bodies for ALL article-bearing raw.json files,
  //    including ones already on disk from earlier runs that didn't get their
  //    .md bodies updated (e.g., due to the wrong-record-id bug). Idempotent —
  //    rewriteNoteBody is a no-op when the body already matches.
  log("Refreshing note bodies for all articles on disk...");
  let refreshed = 0;
  let refreshFailed = 0;
  walkDir(xRoot, (filePath) => {
    if (!filePath.endsWith("raw.json")) return;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
    const ar = getArticleResultFromRaw(raw);
    if (!ar?.content_state) return;
    const outerDirName = path.basename(path.dirname(filePath));
    const outerItemId = outerDirName.replace(/^twitter-/, "");
    const record = {
      id: `twitter:${outerItemId}`,
      platform: "twitter" as const,
      itemId: outerItemId,
      rawData: raw as Record<string, unknown>,
      saved_at: new Date().toISOString(),
      published_at: null,
      captured_via: "backfill",
    };
    writer.rewriteNoteBody(record)
      .then(() => { refreshed++; })
      .catch(() => { refreshFailed++; });
  });
  // Wait for the fire-and-forget chain to settle. Each rewriteNoteBody is a
  // single vault.modify; on a vault with 200 articles this is ~10s tops.
  await new Promise(r => setTimeout(r, 15_000));
  log(`Note body refresh: ${refreshed} updated, ${refreshFailed} failed`);

  const summary = `Article backfill: ${succeeded} succeeded, ${failed} failed (${refreshed} note bodies refreshed)`;
  log(summary);
  new Notice(summary);

  // 8. Tear down the probe re-injection listener.
  removeProbeListener();
  } finally {
    backfillRunning = false;
  }
}

/** Registry binding. main.ts iterates ENRICHMENTS to register Cmd+P entries
 *  and the health-panel iterates to render rows; both reach into this def
 *  rather than calling runArticleBackfill directly. */
export const ARTICLE_BODY_ENRICHMENT: EnrichmentDef = {
  id: "articleBody",
  displayName: "Article bodies",
  schemaVersion: 1,
  commandId: "backfill-x-articles",
  commandName: "Backfill X article bodies",
  runBackfill: runArticleBackfill,
  panelDetail: "X Articles imported with preview text only. Backfill fetches the full body.",
};

