/**
 * X/Twitter sync orchestrator.
 */
import { roostUnwrapTweet } from "@/lib/normalize-helpers";
import { roostNormalize, type NormalizedRecord } from "../lib/normalize";
import type { StopSignal, SyncPhaseProgress, ElectronWebview } from "@/types/sync";
import { SYNC_BATCH_SIZE, EARLY_OUT_THRESHOLD } from "@/config";
import { ThreadFetcher } from "./thread-fetcher";
import { ArticleFetcher } from "./article-fetcher";
import { getTweetAuthorId, getConversationId } from "@/lib/extract";
import {
  getArticleResultFromRaw,
  articleHostTweetId,
  mergeArticleContentInto,
} from "@/lib/article-utils";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import twitterProbeSource from "../probes/twitter-probe.probe";

const pendingHandlers = new WeakMap<HTMLElement, { domReady: EventListener; finish: EventListener }>();

interface SyncResult {
  totalFetched: number;
  folders: { name: string; itemCount: number }[];
}

export async function syncTwitter(
  wc: ElectronWebview,
  webviewEl: ElectronWebview,
  opts: {
    maxScrollTime?: number;
    stopSignal?: StopSignal;
    /**
     * Called before the enrich loop for each scrolled record. If it returns
     * true (and has already copied the cached _thread fields onto record.rawData),
     * the enrich loop will skip re-probing that record's TweetDetail.
     */
    hydrateCachedThread?: (record: NormalizedRecord) => Promise<boolean>;
    /** Optional cap on items collected. Used by the first-sync sample path. */
    maxItems?: number;
    /** When true, skip Step 5 (TweetDetail probe / thread enrichment) and
     *  Step 6 (article body fetch). Items still flow through scroll + flush;
     *  thread / article enrichment is left for the standalone backfill
     *  commands. Drops a multi-minute enrich loop on every incremental sync. */
    fastSyncMode?: boolean;
  } = {},
  onProgress?: (p: SyncPhaseProgress) => void,
  onRecords?: (records: NormalizedRecord[]) => Promise<void>,
  onLog?: (msg: string) => void,
): Promise<SyncResult> {
  const maxScrollTime = opts.maxScrollTime || 5 * 60 * 1000;
  const isStopped = () => opts.stopSignal?.stopped === true;
  const cap = opts.maxItems && opts.maxItems > 0 ? opts.maxItems : null;

  // Step 1: Inject probe on dom-ready + reload
  onProgress?.({ phase: "inject", count: 0, total: 0, done: false });

  const reloadDone = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 30000);
    let loadCount = 0;

    const domReadyHandler = async () => {
      loadCount++;
      await wc.executeJavaScript(`
        try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
        try { ${twitterProbeSource}; } catch(e) {}
        void 0;
      `).catch(() => {});

      if (loadCount === 1) webviewEl.reload();
    };

    const finishHandler = () => {
      if (loadCount >= 2) { clearTimeout(timeout); resolve(true); }
    };

    webviewEl.addEventListener("dom-ready", domReadyHandler);
    webviewEl.addEventListener("did-finish-load", finishHandler);
    pendingHandlers.set(webviewEl, { domReady: domReadyHandler, finish: finishHandler });
  });

  webviewEl.loadURL("https://x.com/i/bookmarks");
  const ready = await reloadDone;

  // Clean up event listeners
  const handlers = pendingHandlers.get(webviewEl);
  if (handlers) {
    webviewEl.removeEventListener("dom-ready", handlers.domReady);
    webviewEl.removeEventListener("did-finish-load", handlers.finish);
    pendingHandlers.delete(webviewEl);
  }
  if (!ready) throw new Error("Twitter page load timed out");

  // Every Twitter bookmark gets a TweetDetail probe in Step 5 — raw-data signals
  // only catch self-thread tails, missing thread roots (rest_id === conversation_id).
  // Stream during scroll so notes appear progressively, and keep the record list
  // for post-scroll probing + re-flush (resyncRecord handles thread upgrades and
  // persists the _thread_probed flag to raw.json).
  const pendingAll: NormalizedRecord[] = [];
  const collectBatch = async (batch: NormalizedRecord[]) => {
    if (batch.length === 0) return;
    pendingAll.push(...batch);
    if (onRecords && !isStopped()) await onRecords(batch);
  };

  // Step 2: Wait for initial bookmarks
  onProgress?.({ phase: "loading", count: 0, total: 0, done: false });
  await new Promise(r => setTimeout(r, 5000));

  const initial = await getStoreCount(wc);
  onProgress?.({ phase: "loading", count: initial, total: 0, done: false });

  // Step 3: Start auto-scroll
  onProgress?.({ phase: "scroll", count: initial, total: 0, done: false });
  await wc.executeJavaScript(`
    window.postMessage({ type: "ROOST_TWITTER_START_SCROLL" }, "*");
    void 0;
  `).catch(() => {});

  // Step 4: Poll and stream records
  // Timeout is based on inactivity (no new items), not wall clock
  let lastCollected = 0;
  let totalFetched = initial;
  let lastNewItemTime = Date.now();
  const BATCH_SIZE = SYNC_BATCH_SIZE;

  // Early-out: if previous sync was complete, stop after consecutive all-known batches
  const prevSyncComplete = await wc.executeJavaScript(`!!window.__ROOST_PREV_SYNC_COMPLETE__`).catch(() => false);
  let consecutiveKnownBatches = 0;

  while (!isStopped()) {
    await new Promise(r => setTimeout(r, 2000));

    const status = await checkStore(wc);
    if (status.bookmarks > totalFetched) {
      lastNewItemTime = Date.now();
    }
    totalFetched = status.bookmarks;
    onProgress?.({ phase: "scroll", count: totalFetched, total: 0, done: false });

    // Sample-cap: bail out of the outer poll loop once we've collected
    // enough. Probe keeps scrolling silently — that's harmless; we just
    // stop reading its output.
    if (cap != null && totalFetched >= cap) {
      onLog?.(`[sample-sync] reached ${cap}-item cap; stopping scroll`);
      break;
    }

    while (totalFetched - lastCollected >= BATCH_SIZE && !isStopped()) {
      const batch = await collectChunk(wc, lastCollected, BATCH_SIZE);
      await collectBatch(batch);
      lastCollected += BATCH_SIZE;

      if (prevSyncComplete && batch.length > 0) {
        const allKnown = await wc.executeJavaScript(`
          (function() {
            var known = window.__ROOST_KNOWN_IDS__;
            if (!known) return false;
            var ids = ${JSON.stringify(batch.map(r => r.id))};
            return ids.every(function(id) { return known.has(id); });
          })();
        `).catch(() => false);

        if (allKnown) {
          consecutiveKnownBatches++;
          onLog?.(`Batch: all ${batch.length} already synced (${consecutiveKnownBatches}/${EARLY_OUT_THRESHOLD})`);
          if (consecutiveKnownBatches >= EARLY_OUT_THRESHOLD) {
            onLog?.("Previous sync was complete — stopping scroll early");
            break;
          }
        } else {
          consecutiveKnownBatches = 0;
        }
      }
    }

    // Break out of outer loop too if early-out triggered
    if (prevSyncComplete && consecutiveKnownBatches >= EARLY_OUT_THRESHOLD) break;
    if (!status.scrollActive && status.bookmarks > 0) break;
    if (Date.now() - lastNewItemTime > maxScrollTime) break;
  }

  // Stop scroll immediately
  await wc.executeJavaScript(`
    window.postMessage({ type: "ROOST_TWITTER_STOP_SCROLL" }, "*"); void 0;
  `).catch(() => {});

  // Only collect remaining if not stopped
  let finalCount = totalFetched;
  if (!isStopped()) {
    finalCount = await getStoreCount(wc);
    if (finalCount > lastCollected) {
      const batch = await collectChunk(wc, lastCollected, finalCount - lastCollected);
      await collectBatch(batch);
    }
  }

  // Step 4.5: Navigate bookmark folders — tag tweets with _bookmark_folder
  // The probe's folder GraphQL parsing (op names, response shapes, folder-id
  // variable key) is now matched to X's real contract — see twitter-probe.js.
  // The remaining unconfirmed-from-docs detail is BEHAVIOURAL and verified by
  // tests/e2e/87-x-bookmark-folders.live.spec.ts against real x.com:
  //   - the folder navigation URL (assumed x.com/i/bookmarks/<folder_id>)
  //   - whether BookmarkFolderTimeline fires reliably on that navigation
  //   - whether tweets-in-folders also appear in the main Bookmarks timeline
  const folderResults: { name: string; itemCount: number }[] = [];
  if (!isStopped() && !opts.fastSyncMode) {
    onLog?.("Scanning bookmark folders...");
    const rawFolders = await wc.executeJavaScript(`
      (function() {
        try {
          var s = window.__TWITTER_BOOKMARK_SPIKE__;
          return JSON.stringify(Object.entries(s.bookmarkFolders || {}).map(function(e) {
            return { id: e[0], name: e[1] };
          }));
        } catch(e) { return '[]'; }
      })();
    `).catch(() => "[]");

    const folders: { id: string; name: string }[] = JSON.parse(rawFolders);
    onLog?.(`Found ${folders.length} bookmark folders`);

    for (const folder of folders) {
      if (isStopped()) break;
      onLog?.(`Loading folder: ${folder.name}...`);

      // Folder page URL (verified end-to-end by the live spec). If a future X
      // change moves this, spec 87 fails on guess #5 and the capture file shows
      // where navigation actually landed.
      const folderUrl = `https://x.com/i/bookmarks/${folder.id}`;

      const folderLoaded = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 15000);
        const handler = () => { clearTimeout(timeout); resolve(true); };
        webviewEl.addEventListener("did-finish-load", handler, { once: true });
        webviewEl.loadURL(folderUrl);
      });

      if (!folderLoaded) {
        onLog?.(`[WARN] Folder "${folder.name}" failed to load — skipping`);
        continue;
      }

      // Re-inject probe (navigation clears the page context)
      await wc.executeJavaScript(`
        try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
        try { ${twitterProbeSource}; } catch(e) {}
        void 0;
      `).catch(() => {});

      // Wait for folder timeline GraphQL to fire and probe to tag tweets
      await new Promise(r => setTimeout(r, 3000));

      const taggedCount = await wc.executeJavaScript(`
        (function() {
          var s = window.__TWITTER_BOOKMARK_SPIKE__;
          if (!s) return 0;
          var count = 0;
          for (var id in s.tweetCache) {
            if (s.tweetCache[id]._bookmark_folder === ${JSON.stringify(folder.name)}) count++;
          }
          return count;
        })();
      `).catch(() => 0);

      onLog?.(`Folder "${folder.name}": ${taggedCount} tweets tagged`);
      folderResults.push({ name: folder.name, itemCount: taggedCount });
    }

    // Return to bookmarks page before enrichment (Steps 5+6 need the probe active)
    if (folders.length > 0 && !isStopped()) {
      webviewEl.loadURL("https://x.com/i/bookmarks");
      await new Promise(r => setTimeout(r, 2000));
      await wc.executeJavaScript(`
        try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
        try { ${twitterProbeSource}; } catch(e) {}
        void 0;
      `).catch(() => {});
    }
  }

  // Steps 5 + 6: TweetDetail probe (thread enrichment) + article body fetch.
  // segments.length >= 2 → real thread; segments.length < 2 → standalone (mark probed);
  // null → fetch failed (mark probe_failed so vault-writer leaves it flagged for retry).
  // When opts.fastSyncMode is true, both steps are skipped — the standalone
  // "Backfill X thread context" and "Backfill X article bodies" commands
  // handle these gaps separately. The flush below still runs so newly-
  // discovered items reach disk regardless.
  if (pendingAll.length > 0 && opts.fastSyncMode) {
    onLog?.(`Fast-sync: skipping enrichment of ${pendingAll.length} items (run backfill commands separately)`);
  } else if (pendingAll.length > 0) {
    // Keep probe re-injected across the bootstrap navigation. Without this the
    // probe is lost when loadURL() replaces the document.
    const reinjectProbe = async () => {
      await wc.executeJavaScript(`
        try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
        try { ${twitterProbeSource}; } catch(e) {}
        void 0;
      `).catch(() => {});
    };
    webviewEl.addEventListener("dom-ready", reinjectProbe);

    try {
      // Pre-filter: drop records whose thread was already probed in a prior
      // sync (callback copies cached flags onto record.rawData so the subsequent
      // flush preserves them). Saves one TweetDetail fetch per already-enriched
      // item — on a full rescroll of 2k+ bookmarks this avoids thousands of
      // redundant requests and the rate-limiting that follows.
      let toEnrich: NormalizedRecord[] = pendingAll;
      if (opts.hydrateCachedThread && pendingAll.length > 0 && !isStopped()) {
        const cached = await Promise.all(
          pendingAll.map(r => opts.hydrateCachedThread!(r).catch(() => false))
        );
        toEnrich = pendingAll.filter((_, i) => !cached[i]);
        const hydrated = pendingAll.length - toEnrich.length;
        if (hydrated > 0) {
          onLog?.(`Enrich: hydrated ${hydrated} from cached probes, probing ${toEnrich.length} new`);
        }
      }

      if (!isStopped() && toEnrich.length > 0) {
        onProgress?.({ phase: "enrich", count: 0, total: toEnrich.length, done: false });
        onLog?.(`Enrich: probing ${toEnrich.length} bookmarks for threads`);

        const fetcher = new ThreadFetcher(wc, webviewEl, onLog || (() => {}));
        let bootstrapped = false;
        const MAX_SEED_ATTEMPTS = 3;
        const seedIds: string[] = [];
        for (const r of toEnrich) {
          const rid = typeof r.rawData?.rest_id === "string" ? r.rawData.rest_id : null;
          if (rid) seedIds.push(rid);
          if (seedIds.length >= MAX_SEED_ATTEMPTS) break;
        }
        for (let i = 0; i < seedIds.length; i++) {
          if (isStopped()) break;
          if (await fetcher.ensureReplayReady(seedIds[i])) {
            bootstrapped = true;
            break;
          }
          onLog?.(`Enrich: seed ${i + 1}/${seedIds.length} failed — trying next`);
        }

        if (bootstrapped) {
          for (let i = 0; i < toEnrich.length; i++) {
            if (isStopped()) break;
            if (fetcher.shouldAbort()) {
              onLog?.(`Enrich: aborted after sustained rate limiting — remaining ${toEnrich.length - i} items stay flagged for next sync`);
              break;
            }
            const record = toEnrich[i];

            const tweet = roostUnwrapTweet(record.rawData) || record.rawData;
            const focalTweetId = typeof tweet?.rest_id === "string" ? tweet.rest_id : null;
            const authorId = getTweetAuthorId(tweet);
            const conversationId = getConversationId(tweet);

            if (focalTweetId && authorId && conversationId) {
              const segments = await fetcher.fetchThread(focalTweetId, authorId, conversationId, opts.stopSignal);
              if (segments === null) {
                record.rawData._thread_probe_failed = true;
              } else {
                record.rawData._thread_probed = true;
                if (segments.length >= 2) {
                  record.rawData._thread = segments;
                  onLog?.(`Enriched ${focalTweetId}: ${segments.length} segments`);
                }
              }
              await new Promise(r => setTimeout(r, 500));
            }

            const quoted = record.rawData?.quoted_status_result?.result;
            if (quoted && !isStopped()) {
              const qTweet = roostUnwrapTweet(quoted) || quoted;
              const qFocal = typeof qTweet?.rest_id === "string" ? qTweet.rest_id : null;
              const qAuthor = getTweetAuthorId(qTweet);
              const qConv = getConversationId(qTweet);
              if (qFocal && qAuthor && qConv) {
                const segments = await fetcher.fetchThread(qFocal, qAuthor, qConv, opts.stopSignal);
                if (segments && segments.length >= 2) {
                  record.rawData._quoted_thread = segments;
                  onLog?.(`Enriched quoted ${qFocal}: ${segments.length} segments`);
                }
                await new Promise(r => setTimeout(r, 500));
              }
            }

            onProgress?.({ phase: "enrich", count: i + 1, total: toEnrich.length, done: false });
          }
        } else {
          onLog?.(`Enrich: bootstrap failed on ${seedIds.length} seeds — items stay flagged for next sync`);
        }
      }

      // Step 6: Article body fetch.
      // For each record with article_results stub but no content_state, pull the
      // full body via ArticleFetcher (replay-fetch over TweetResultByRestId).
      const articleQueue: { record: NormalizedRecord; tweetId: string }[] = [];
      for (const r of pendingAll) {
        const ar = getArticleResultFromRaw(r.rawData);
        if (ar && !ar.content_state) {
          const tweetId = articleHostTweetId(r.rawData);
          if (tweetId) articleQueue.push({ record: r, tweetId });
        }
      }

      if (articleQueue.length > 0 && !isStopped()) {
        onProgress?.({ phase: "articles", count: 0, total: articleQueue.length, done: false });
        const articleFetcher = new ArticleFetcher(wc, webviewEl, onLog || (() => {}));
        const articleResults = await articleFetcher.fetchMany(
          articleQueue.map(q => q.tweetId),
          (done, total, last) => {
            onProgress?.({ phase: "articles", count: done, total, done: false });
            if (last && !last.ok && onLog) {
              onLog(`Article fetch: ${last.tweetId} failed (${last.reason})`);
            }
          },
        );

        // Merge content_state into each record's rawData.
        for (let i = 0; i < articleResults.length; i++) {
          const res = articleResults[i];
          if (!res.ok || !res.rawTweet) continue;
          mergeArticleContentInto(articleQueue[i].record, res.rawTweet);
        }
      }

    } finally {
      webviewEl.removeEventListener("dom-ready", reinjectProbe);
    }
  }

  // Flush all records (enriched or not — consumer handles fallback). Always
  // runs regardless of fastSyncMode so newly-discovered items reach disk
  // even when Step 5/6 are skipped.
  if (onRecords && !isStopped() && pendingAll.length > 0) {
    await onRecords(pendingAll);
  }

  onProgress?.({ phase: "done", count: finalCount, total: finalCount, done: true });
  return { totalFetched: finalCount, folders: folderResults };
}

async function getStoreCount(wc: ElectronWebview): Promise<number> {
  const raw = await wc.executeJavaScript(`
    try { var s = window.__TWITTER_BOOKMARK_SPIKE__; (s && s.bookmarkOrder || []).length; }
    catch(e) { 0; }
  `).catch(() => 0);
  return raw || 0;
}

async function checkStore(wc: ElectronWebview): Promise<{ bookmarks: number; scrollActive: boolean }> {
  const raw = await wc.executeJavaScript(`
    try {
      var s = window.__TWITTER_BOOKMARK_SPIKE__;
      if (!s) JSON.stringify({ bookmarks: 0, scrollActive: false });
      else JSON.stringify({
        bookmarks: (s.bookmarkOrder || []).length,
        scrollActive: !!(s._autoScroll && s._autoScroll.active),
      });
    } catch(e) { JSON.stringify({ bookmarks: 0, scrollActive: false }); }
  `).catch(() => '{"bookmarks":0,"scrollActive":false}');
  return JSON.parse(raw);
}

async function collectChunk(wc: ElectronWebview, offset: number, count: number): Promise<NormalizedRecord[]> {
  const CHUNK = 50;
  const records: NormalizedRecord[] = [];
  for (let i = offset; i < offset + count; i += CHUNK) {
    const limit = Math.min(CHUNK, offset + count - i);
    const chunk = await wc.executeJavaScript(`
      (function() {
        var s = window.__TWITTER_BOOKMARK_SPIKE__;
        var ids = s.bookmarkOrder.slice(${i}, ${i + limit});
        return JSON.stringify(ids.map(function(id) {
          return { id: id, raw: s.tweetCache[id] || null };
        }));
      })();
    `).catch(() => "[]");

    const parsed = JSON.parse(chunk);
    const baseTime = Date.now();
    for (let j = 0; j < parsed.length; j++) {
      const { raw } = parsed[j];
      if (!raw) continue;
      const record = roostNormalize("twitter", raw, {
        savedAt: new Date(baseTime - (i - offset + j)).toISOString(),
        capturedVia: "sync",
      });
      if (record) records.push(record);
    }
  }
  return records;
}
