/**
 * Reddit sync orchestrator. Drives the saved-listing REST endpoint page-by-page
 * from TypeScript (pagination, pacing, early-out, hard-cap, backoff all live here
 * — the probe only exposes a page-context fetch helper). See design spec §4.
 */
import { roostNormalize, type NormalizedRecord } from "../lib/normalize";
import type { StopSignal, SyncPhaseProgress, ElectronWebview } from "@/types/sync";
import { SYNC_BATCH_SIZE } from "@/config";
import type { SyncMode } from "@/sync/sync-mode";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import redditProbeSource from "../probes/reddit-probe.probe";

const SAVED_PAGE_SIZE = 100;
const JITTER_MIN_MS = 8000;
const JITTER_MAX_MS = 12000;
const MAX_BACKOFF_RETRIES = 4;
const MAX_SAVED_ITEMS = 1000;

export interface RedditFetchResult { status: number; body?: string; error?: string; }
export type RedditFetch = (path: string) => Promise<RedditFetchResult>;

interface PaginateArgs {
  fetch: RedditFetch;
  sleep: (ms: number) => Promise<void>;
  onRecords: (records: NormalizedRecord[]) => Promise<void>;
  knownIds: Set<string>;
  mode: SyncMode;
  batchSize: number;
  maxItems: number | null;
  /** Absolute cap on raw t3 items scanned (incl. cross-page dupes). Reddit hard-caps at 1000. */
  hardCap: number;
  isStopped: () => boolean;
  onLog: (msg: string) => void;
  onProgress: (p: SyncPhaseProgress) => void;
  maxBackoffRetries?: number;
  /** Resolved Reddit username — defaults to "me" (the OAuth alias). */
  me?: string;
}

interface PaginateResult {
  totalFetched: number;
  earlyOut: boolean;
  abortedRateLimited: boolean;
  hitHardCap: boolean;
}

/**
 * Core saved-listing pagination loop. Pure w.r.t. injected fetch/sleep so it is
 * fully unit-testable without a webview.
 *
 * hardCap note: `rawCount` tracks every valid t3 item encountered (including
 * cross-page duplicates). When rawCount reaches hardCap the function returns
 * {hitHardCap:true, totalFetched:<unique items actually emitted>}. `totalFetched`
 * counts only unique items emitted — these two counters diverge whenever pages
 * repeat ids (Reddit can return the same post on multiple listing pages).
 */
export async function paginateSaved(args: PaginateArgs): Promise<PaginateResult> {
  const maxRetries = args.maxBackoffRetries ?? MAX_BACKOFF_RETRIES;
  const me = args.me ?? "me";
  const seen = new Set<string>();
  let cursor: string | null = null;
  let totalFetched = 0;   // unique items emitted
  let rawCount = 0;       // all t3 items scanned (including cross-page dupes)
  let pending: NormalizedRecord[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    await args.onRecords(pending);
    pending = [];
  };

  while (!args.isStopped()) {
    const path = `/user/${me}/saved.json?limit=${SAVED_PAGE_SIZE}&raw_json=1&type=links${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;

    // Fetch with bounded backoff on rate-limiting / transient 5xx.
    let res: RedditFetchResult | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      res = await args.fetch(path);
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxRetries) {
          args.onLog(`[reddit] throttled (status ${res.status}) — aborting after ${attempt} retries (partial sync saved)`);
          await flush();
          return { totalFetched, earlyOut: false, abortedRateLimited: true, hitHardCap: false };
        }
        const backoff = Math.min(30000, 2000 * 2 ** attempt);
        args.onLog(`[reddit] throttled (status ${res.status}) — backing off ${backoff}ms (retry ${attempt + 1}/${maxRetries})`);
        await args.sleep(backoff);
        continue;
      }
      break;
    }
    if (!res || res.status !== 200 || !res.body) {
      args.onLog(`[reddit] page fetch failed (status ${res?.status}) — stopping`);
      await flush();
      return { totalFetched, earlyOut: false, abortedRateLimited: false, hitHardCap: false };
    }

    let parsed: { kind: string; data: { after: string | null; children: Array<{ kind: string; data: Record<string, any> }> } };
    try { parsed = JSON.parse(res.body); } catch (e) {
      args.onLog(`[reddit] unparseable page body — stopping: ${String(e)}`);
      break;
    }

    const children = parsed.data?.children || [];
    let processedCount = 0;
    let lastFullname: string | null = null; // last item's own fullname (cursor fallback)

    for (const child of children) {
      if (child.data?.id) lastFullname = (child.kind || "") + "_" + child.data.id;
      if (child.kind !== "t3") continue;
      const d = child.data;
      if (!d?.id) continue;

      // Count every t3 item (including dupes) toward the hard cap.
      rawCount++;
      if (rawCount >= args.hardCap) {
        await flush();
        return { totalFetched, earlyOut: false, abortedRateLimited: false, hitHardCap: true };
      }

      // Cross-page dedup: seen tracks reddit:<id> keys for the lifetime of this call.
      const rid = "reddit:" + d.id;
      if (seen.has(rid)) continue;
      seen.add(rid);

      const record = roostNormalize("reddit", d, {
        savedAt: new Date(Date.now() - totalFetched).toISOString(),
        capturedVia: "sync",
      });
      if (!record) continue;

      if (args.mode === "quick" && args.knownIds.has(record.id)) {
        args.onLog("[reddit] reached a previously-synced item — quick sync stopping");
        await flush();
        return { totalFetched, earlyOut: true, abortedRateLimited: false, hitHardCap: false };
      }

      totalFetched++;
      processedCount++;
      pending.push(record);
      if (pending.length >= args.batchSize) await flush();

      if (args.maxItems != null && totalFetched >= args.maxItems) {
        args.onLog(`[reddit] reached ${args.maxItems}-item cap`);
        await flush();
        return { totalFetched, earlyOut: false, abortedRateLimited: false, hitHardCap: false };
      }
    }

    args.onProgress({ phase: "fetch", count: totalFetched, total: 0, done: false });

    // Termination. Reddit's saved.json?type=links reports data.after=null
    // PREMATURELY on short pages while more items still exist (confirmed live: a
    // 99-item page returned after=null, yet requesting after=<last item fullname>
    // yielded 100 more links). So do NOT treat after=null as end-of-list. Fall
    // back to the last item's own fullname as the cursor, and stop only on a
    // genuinely empty page, an all-duplicate page (loop guard), or the hard cap.
    if (children.length === 0) break;                    // genuine end of listing
    if (processedCount === 0) break;                     // whole page was cross-page dupes → looped/ended
    const nextCursor = (parsed.data?.after ?? null) || lastFullname;
    if (!nextCursor || nextCursor === cursor) break;     // cannot advance further
    cursor = nextCursor;
    // Pacing jitter between listing pages (8–12 s).
    await args.sleep(JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS)));
  }

  await flush();
  return { totalFetched, earlyOut: false, abortedRateLimited: false, hitHardCap: false };
}

/** Build a production RedditFetch backed by the injected probe in the webview. */
function makeWebviewRedditFetch(wc: ElectronWebview): RedditFetch {
  return async (path: string) => {
    const raw = await wc.executeJavaScript(`window.__roostRedditFetch(${JSON.stringify(path)})`).catch((e: unknown) => JSON.stringify({ status: -1, error: String(e) }));
    try { return JSON.parse(raw as string); } catch { return { status: -1 }; }
  };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function syncReddit(
  wc: ElectronWebview,
  webviewEl: ElectronWebview,
  opts: { stopSignal?: StopSignal; maxItems?: number; syncMode?: SyncMode } = {},
  onProgress?: (p: SyncPhaseProgress) => void,
  onRecords?: (records: NormalizedRecord[]) => Promise<void>,
  onLog?: (msg: string) => void,
): Promise<{ totalFetched: number }> {
  const log = onLog || (() => {});
  const progress = onProgress || (() => {});
  const isStopped = () => opts.stopSignal?.stopped === true;

  // Step 1: inject probe on dom-ready, navigate, settle so Reddit sets session cookies.
  progress({ phase: "inject", count: 0, total: 0, done: false });
  const reinject = async () => {
    await wc.executeJavaScript(
      `try { delete window.__roostRedditProbeInstalled; } catch(e) {}\ntry { ${redditProbeSource} } catch(e) {}\nvoid 0;`,
    ).catch(() => {});
  };
  webviewEl.addEventListener("dom-ready", reinject);
  webviewEl.loadURL("https://www.reddit.com/");
  await new Promise<void>((resolve) => {
    webviewEl.addEventListener("dom-ready", () => resolve(), { once: true });
    setTimeout(resolve, 20000);
  });
  await reinject();
  await realSleep(3000); // settle: allow Reddit session to initialize

  const redditFetch = makeWebviewRedditFetch(wc);

  // Step 2: resolve authenticated username via /api/me.json.
  let me = "me";
  const meRaw = await redditFetch("/api/me.json");
  if (meRaw.status === 200 && meRaw.body) {
    try { me = JSON.parse(meRaw.body).data.name || "me"; } catch { /* keep default */ }
  }
  log(`[reddit] username: ${me}`);

  // Step 3: paginate saved listing.
  progress({ phase: "fetch", count: 0, total: 0, done: false });
  const knownIds: Set<string> = await wc
    .executeJavaScript(`(function(){ var s = window.__ROOST_KNOWN_IDS__; return s ? Array.from(s) : []; })()`)
    .then((arr: unknown) => new Set(Array.isArray(arr) ? (arr as string[]) : []))
    .catch(() => new Set<string>());

  const result = await paginateSaved({
    fetch: redditFetch,
    sleep: realSleep,
    me,
    onRecords: async (recs) => { if (onRecords && !isStopped()) await onRecords(recs); },
    knownIds,
    mode: opts.syncMode ?? "full",
    batchSize: SYNC_BATCH_SIZE,
    maxItems: opts.maxItems && opts.maxItems > 0 ? opts.maxItems : null,
    hardCap: MAX_SAVED_ITEMS,
    isStopped,
    onLog: log,
    onProgress: progress,
  });

  webviewEl.removeEventListener("dom-ready", reinject);
  progress({ phase: "done", count: result.totalFetched, total: result.totalFetched, done: true });
  return { totalFetched: result.totalFetched };
}
