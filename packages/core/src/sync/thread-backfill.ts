/**
 * One-shot backfill: walk all X bookmark raw.json files, fetch self-thread
 * segments for items that haven't been probed yet, write back the enriched
 * raw.json + thread.json sidecar, and re-render note bodies with the thread
 * inlined.
 *
 * Resumable via .roost/thread-fetch-cache.json — successful fetches and
 * classified failures are persisted so a re-run skips them. The bookmark's
 * `_thread_probed` flag in raw.json is the source of truth for "already
 * processed"; the cache is a fast index that avoids reading every raw.json
 * twice on re-runs.
 *
 * Mirrors the article-backfill structure: same probe-injection bootstrap,
 * same per-item write resilience, same fire-and-forget note-body refresh.
 *
 * Triggered from the Obsidian command palette: "Backfill X thread context".
 */
import * as fs from "fs";
import * as path from "path";
import { Notice } from "obsidian";
import { ThreadFetcher } from "@/sync/thread-fetcher";
import { VaultWriter } from "@/sync/vault-writer";
import { roostUnwrapTweet, type NormalizedRecord } from "@/lib/normalize";
import { getTweetAuthorId, getConversationId } from "@/lib/extract";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import { walkDir } from "@/lib/fs-walk";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef } from "@/lib/enrichments";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import twitterProbeSource from "@/probes/twitter-probe.probe";

interface ThreadCacheEntry {
  ok: boolean;
  reason?: string;
  fetchedAt: number;     // unix seconds
  segmentCount?: number; // 0 = single-tweet "non-thread"; >=2 = real thread
}
type ThreadCache = Record<string, ThreadCacheEntry>;

let backfillRunning = false;

export async function runThreadBackfill(plugin: IRoostPlugin): Promise<void> {
  if (backfillRunning) {
    new Notice("Thread backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
  const log = (msg: string) => { plugin.fireLog("[thread-backfill] " + msg); };

  const vaultRoot = vaultBasePath(plugin.app.vault);
  if (!vaultRoot) { new Notice("Thread backfill failed: cannot locate vault path."); return; }
  const roostDir = cacheDir(vaultRoot);
  fs.mkdirSync(roostDir, { recursive: true });
  const cachePath = path.join(roostDir, "thread-fetch-cache.json");

  const cache: ThreadCache = (() => {
    try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
  })();
  const now = Math.floor(Date.now() / 1000);

  // Scan from disk rather than calling scanIncompleteIds — we need the
  // raw.json paths and parsed contents, not just the roost_id set.
  const xRoot = path.join(vaultRoot, plugin.settings.syncFolder, "X");
  if (!fs.existsSync(xRoot)) {
    new Notice(`Thread backfill: no ${plugin.settings.syncFolder}/X folder. Sync first.`);
    return;
  }

  interface QueueItem {
    rawPath: string;
    outerItemId: string;
    raw: Record<string, unknown>;
    focalTweetId: string;
    authorId: string;
    conversationId: string;
    /** When the host tweet's author/conversation differ from the bookmark's
     *  embedded quoted tweet, also probe the quote thread. */
    quoted?: { focalTweetId: string; authorId: string; conversationId: string };
  }

  const queue: QueueItem[] = [];
  let alreadyProbed = 0;
  let cacheHits = 0;

  walkDir(xRoot, (filePath) => {
    if (!filePath.endsWith("raw.json")) return;
    // Cheap path-derived cache check first — avoids JSON.parse on items the
    // cache already knows the answer for. Big win on re-runs of mostly-
    // probed vaults.
    const outerDirName = path.basename(path.dirname(filePath));
    const outerItemId = outerDirName.replace(/^twitter-/, "");
    if (cache[outerItemId]) { cacheHits++; return; }

    let raw: Record<string, unknown>;
    try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }

    if (raw._thread_probed === true) { alreadyProbed++; return; }

    const tweet = roostUnwrapTweet(raw) || raw;
    const focalTweetId = typeof (tweet as { rest_id?: string }).rest_id === "string"
      ? (tweet as { rest_id: string }).rest_id : null;
    const authorId = getTweetAuthorId(tweet);
    const conversationId = getConversationId(tweet);

    // Detection mirrors scanIncompleteIds — only enqueue items that look like
    // a thread root or tail. Single-tweet bookmarks never enter the queue.
    const reply = (tweet as { legacy?: { reply_count?: number } }).legacy?.reply_count || 0;
    const isRootCandidate = !!(focalTweetId && conversationId && focalTweetId === conversationId && reply > 0);
    const hasTail = !!(focalTweetId && conversationId && focalTweetId !== conversationId);
    if (!isRootCandidate && !hasTail) return;
    if (!focalTweetId || !authorId || !conversationId) return;

    const item: QueueItem = { rawPath: filePath, outerItemId, raw, focalTweetId, authorId, conversationId };

    // Optional quoted-thread probe. Mirrors syncTwitter's behavior.
    const quotedRaw = (raw as { quoted_status_result?: { result?: unknown } }).quoted_status_result?.result;
    if (quotedRaw) {
      const qTweet = roostUnwrapTweet(quotedRaw as Record<string, unknown>) || quotedRaw;
      const qFocal = typeof (qTweet as { rest_id?: string }).rest_id === "string"
        ? (qTweet as { rest_id: string }).rest_id : null;
      const qAuthor = getTweetAuthorId(qTweet as Record<string, unknown>);
      const qConv = getConversationId(qTweet as Record<string, unknown>);
      if (qFocal && qAuthor && qConv) item.quoted = { focalTweetId: qFocal, authorId: qAuthor, conversationId: qConv };
    }
    queue.push(item);
  });

  if (queue.length === 0) {
    const noun = alreadyProbed > 0 || cacheHits > 0
      ? `(${alreadyProbed} already probed, ${cacheHits} cached)`
      : "";
    new Notice(`No thread-context items to backfill ${noun}`.trim());
    return;
  }

  log(`Queue: ${queue.length} items (skipped ${alreadyProbed} already probed, ${cacheHits} cache hits)`);
  new Notice(`Backfilling ${queue.length} thread items…`);

  // 3. Set up VaultWriter so we can resyncRecord per item.
  const writer = new VaultWriter({
    vault: plugin.app.vault,
    syncFolder: plugin.settings.syncFolder,
    metadataCache: plugin.app.metadataCache,
    onLog: log,
  });
  await writer.scanIncompleteIds().catch(() => {});

  // 4. Set up the X webview + probe — mirrors article-backfill.
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
    new Notice("Thread backfill failed: X webview not ready.");
    return;
  }

  const webviewEl = wm.getElement("twitter");
  if (!webviewEl) { new Notice("Thread backfill failed: X webview element missing."); return; }

  log("Injecting probe + loading bookmarks to capture auth headers...");
  const reinject = (): void => {
    wcReady!.executeJavaScript(`
      try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
      try { ${twitterProbeSource}; } catch(e) {}
      void 0;
    `).catch(() => {});
  };
  webviewEl.addEventListener("dom-ready", reinject);
  let probeListenerActive = true;
  const removeProbeListener = (): void => {
    if (!probeListenerActive) return;
    webviewEl.removeEventListener("dom-ready", reinject);
    probeListenerActive = false;
  };

  try {
    reinject();
    webviewEl.loadURL("https://x.com/i/bookmarks");

    // 5. Bootstrap TweetDetail replay using the first few queue items as seeds.
    const fetcher = new ThreadFetcher(wcReady, webviewEl, log);
    let bootstrapped = false;
    const MAX_SEED_ATTEMPTS = 3;
    for (let i = 0; i < Math.min(queue.length, MAX_SEED_ATTEMPTS); i++) {
      if (await fetcher.ensureReplayReady(queue[i].focalTweetId)) {
        bootstrapped = true;
        break;
      }
      log(`Seed ${i + 1}/${MAX_SEED_ATTEMPTS} failed — trying next`);
    }
    if (!bootstrapped) {
      log("Bootstrap failed: TweetDetail replay never recorded.");
      new Notice("Thread backfill failed: couldn't capture an authenticated TweetDetail. Open the X webview and confirm you're logged in.");
      return;
    }
    log("TweetDetail replay captured — proceeding to thread fetch");

    // 6. Fetch loop. Per-item write resilience.
    let succeeded = 0, failed = 0, threadsWithSegments = 0;
    for (let i = 0; i < queue.length; i++) {
      if (fetcher.shouldAbort()) {
        log(`Aborted after sustained rate-limiting — ${queue.length - i} items remain for next run`);
        break;
      }
      const q = queue[i];

      const segments = await fetcher.fetchThread(q.focalTweetId, q.authorId, q.conversationId);
      let recordRaw = q.raw;

      if (segments === null) {
        // Classified failure (network error, bad cache, rate limit etc).
        recordRaw._thread_probe_failed = true;
        cache[q.outerItemId] = { ok: false, reason: "fetch_failed", fetchedAt: now };
        failed++;
      } else {
        recordRaw._thread_probed = true;
        if (segments.length >= 2) {
          recordRaw._thread = segments;
          threadsWithSegments++;
        }
        cache[q.outerItemId] = { ok: true, fetchedAt: now, segmentCount: segments.length };
        succeeded++;
      }

      if (q.quoted) {
        await new Promise(r => setTimeout(r, 250));
        const qSegments = await fetcher.fetchThread(q.quoted.focalTweetId, q.quoted.authorId, q.quoted.conversationId);
        if (qSegments && qSegments.length >= 2) recordRaw._quoted_thread = qSegments;
      }

      // Persist raw.json immediately (per-item resilience).
      try {
        fs.writeFileSync(q.rawPath, JSON.stringify(recordRaw, null, 2));
      } catch (e: unknown) {
        log(`Failed to write ${q.rawPath}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Re-render the note via resyncRecord. Twitter media on disk is reused
      // (downloadAndSave skips existing files); the heavy work is renderThreadPages
      // which writes thread.json + per-segment carousel pages + the note body.
      const record: NormalizedRecord = {
        id: `twitter:${q.outerItemId}`,
        platform: "twitter",
        itemId: q.outerItemId,
        rawData: recordRaw,
        saved_at: new Date().toISOString(),
        published_at: null,
        captured_via: "backfill",
      };
      try {
        await writer.resyncRecord(record);
        if (segments !== null) {
          await writer.stampEnrichmentVersion(record.id, "thread", THREAD_ENRICHMENT.schemaVersion);
        }
      } catch (e: unknown) {
        log(`resyncRecord failed for ${q.outerItemId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Brief pause between items to let TweetDetail rate-limiting cool.
      await new Promise(r => setTimeout(r, 500));

      // Periodic cache flush + log.
      if ((i + 1) % 10 === 0 || i + 1 === queue.length) {
        log(`Progress: ${i + 1}/${queue.length} (${threadsWithSegments} with segments, ${failed} failed)`);
        try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); }
        catch { /* best-effort */ }
      }
    }

    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    const summary = `Thread backfill: ${succeeded} probed (${threadsWithSegments} with thread segments), ${failed} failed`;
    log(summary);
    new Notice(summary);
  } finally {
    removeProbeListener();
  }
  } finally {
    backfillRunning = false;
  }
}

export const THREAD_ENRICHMENT: EnrichmentDef = {
  id: "thread",
  displayName: "Thread context",
  schemaVersion: 1,
  commandId: "backfill-x-threads",
  commandName: "Backfill X thread context",
  runBackfill: runThreadBackfill,
  panelDetail: "Self-thread roots and tails not yet probed. Backfill fetches missing thread segments.",
};

