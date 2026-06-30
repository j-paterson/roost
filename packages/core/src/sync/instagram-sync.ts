/**
 * Instagram sync orchestrator. Drives the validated REST endpoints page-by-page
 * from TypeScript (pagination, pacing, early-out, backoff all live here — the
 * probe only exposes page-context fetch helpers). See the design spec §4.
 */
import { roostNormalize, type NormalizedRecord } from "../lib/normalize";
import type { StopSignal, SyncPhaseProgress, ElectronWebview } from "@/types/sync";
import { SYNC_BATCH_SIZE, EARLY_OUT_THRESHOLD } from "@/config";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import instagramProbeSource from "../probes/instagram-probe.probe";

const SAVED_PAGE_SIZE = 50;
const JITTER_MIN_MS = 1000;
const JITTER_MAX_MS = 3000;
const MAX_BACKOFF_RETRIES = 4;

export interface IgFetchResult { status: number; body?: string; error?: string; }
export type IgFetch = (path: string) => Promise<IgFetchResult>;

interface PaginateArgs {
  igFetch: IgFetch;
  sleep: (ms: number) => Promise<void>;
  onRecords: (records: NormalizedRecord[]) => Promise<void>;
  collMap: Map<string, { name: string; count: number }>;
  knownIds: Set<string>;
  prevComplete: boolean;
  batchSize: number;
  earlyOutThreshold: number;
  maxItems: number | null;
  isStopped: () => boolean;
  onLog: (msg: string) => void;
  onProgress: (p: SyncPhaseProgress) => void;
  maxBackoffRetries?: number;
}

interface PaginateResult {
  totalFetched: number;
  earlyOut: boolean;
  abortedRateLimited: boolean;
}

function isFeedbackRequired(body: string | undefined): boolean {
  if (!body) return false;
  return /feedback_required|checkpoint_required|"spam"/i.test(body);
}

/** Core saved-feed pagination loop. Pure w.r.t. injected igFetch/sleep so it is
 *  fully unit-testable without a webview. */
export async function paginateSaved(args: PaginateArgs): Promise<PaginateResult> {
  const maxRetries = args.maxBackoffRetries ?? MAX_BACKOFF_RETRIES;
  let cursor: string | null = null;
  let totalFetched = 0;
  let consecutiveKnownPages = 0;
  let pending: NormalizedRecord[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    await args.onRecords(pending);
    pending = [];
  };

  while (!args.isStopped()) {
    const qs = `count=${SAVED_PAGE_SIZE}${cursor ? `&max_id=${encodeURIComponent(cursor)}` : ""}`;
    const path = `/api/v1/feed/saved/posts/?${qs}`;

    // Fetch with bounded backoff on rate limiting.
    let res: IgFetchResult | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      res = await args.igFetch(path);
      if (res.status === 429 || isFeedbackRequired(res.body)) {
        if (attempt === maxRetries) {
          args.onLog(`[instagram] rate-limited — aborting after ${attempt} retries (partial sync saved)`);
          await flush();
          return { totalFetched, earlyOut: false, abortedRateLimited: true };
        }
        const backoff = Math.min(30000, 2000 * 2 ** attempt);
        args.onLog(`[instagram] 429/feedback — backing off ${backoff}ms`);
        await args.sleep(backoff);
        continue;
      }
      break;
    }
    if (!res || res.status !== 200 || !res.body) {
      args.onLog(`[instagram] page fetch failed (status ${res?.status}) — stopping`);
      await flush();
      return { totalFetched, earlyOut: false, abortedRateLimited: false };
    }

    let parsed: { items?: { media?: Record<string, unknown> }[]; more_available?: boolean; next_max_id?: string };
    try { parsed = JSON.parse(res.body); } catch { args.onLog("[instagram] unparseable page body — stopping"); break; }

    const items = parsed.items || [];
    let pageAllKnown = items.length > 0;
    for (const it of items) {
      const media = it.media as Record<string, any> | undefined;
      if (!media || !media.code) continue;
      const cids: string[] = Array.isArray(media.saved_collection_ids) ? media.saved_collection_ids : [];
      media._roost_collections = cids.map((id) => args.collMap.get(String(id))?.name).filter(Boolean);
      const record = roostNormalize("instagram", media, {
        savedAt: new Date(Date.now() - totalFetched).toISOString(),
        capturedVia: "sync",
      });
      if (!record) continue;
      totalFetched++;
      if (!args.knownIds.has(record.id)) pageAllKnown = false;
      pending.push(record);
      if (pending.length >= args.batchSize) await flush();
      if (args.maxItems != null && totalFetched >= args.maxItems) {
        args.onLog(`[instagram] reached ${args.maxItems}-item cap`);
        await flush();
        return { totalFetched, earlyOut: false, abortedRateLimited: false };
      }
    }
    args.onProgress({ phase: "fetch", count: totalFetched, total: 0, done: false });

    // Early-out: reverse-chron feed, so consecutive all-known pages mean we've
    // caught up to a prior complete sync.
    if (args.prevComplete && pageAllKnown) {
      consecutiveKnownPages++;
      args.onLog(`[instagram] all-known page (${consecutiveKnownPages}/${args.earlyOutThreshold})`);
      if (consecutiveKnownPages >= args.earlyOutThreshold) {
        args.onLog("[instagram] previous sync complete — early out");
        await flush();
        return { totalFetched, earlyOut: true, abortedRateLimited: false };
      }
    } else {
      consecutiveKnownPages = 0;
    }

    if (!parsed.more_available || !parsed.next_max_id) break;
    cursor = parsed.next_max_id;
    // Pacing jitter between page requests.
    await args.sleep(JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS)));
  }

  await flush();
  return { totalFetched, earlyOut: false, abortedRateLimited: false };
}

/** Build a production IgFetch backed by the injected probe in the webview. */
function makeWebviewIgFetch(wc: ElectronWebview): IgFetch {
  return async (path: string) => {
    const raw = await wc.executeJavaScript(`window.__roostIgFetch(${JSON.stringify(path)})`).catch((e: unknown) => JSON.stringify({ status: -1, error: String(e) }));
    try { return JSON.parse(raw as string); } catch { return { status: -1 }; }
  };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function syncInstagram(
  wc: ElectronWebview,
  webviewEl: ElectronWebview,
  opts: { stopSignal?: StopSignal; maxItems?: number } = {},
  onProgress?: (p: SyncPhaseProgress) => void,
  onRecords?: (records: NormalizedRecord[]) => Promise<void>,
  onLog?: (msg: string) => void,
): Promise<{ totalFetched: number; collections: { name: string; itemCount: number }[] }> {
  const log = onLog || (() => {});
  const progress = onProgress || (() => {});
  const isStopped = () => opts.stopSignal?.stopped === true;

  // Step 1: inject probe on dom-ready, navigate, settle so the SPA fires its own
  // calls (the probe harvests x-asbd-id + x-ig-www-claim).
  progress({ phase: "inject", count: 0, total: 0, done: false });
  const reinject = async () => {
    await wc.executeJavaScript(`try { delete window.__roostIgProbeInstalled; } catch(e) {}\ntry { ${instagramProbeSource} } catch(e) {}\nvoid 0;`).catch(() => {});
  };
  webviewEl.addEventListener("dom-ready", reinject);
  webviewEl.loadURL("https://www.instagram.com/");
  await new Promise<void>((resolve) => {
    webviewEl.addEventListener("dom-ready", () => resolve(), { once: true });
    setTimeout(resolve, 20000);
  });
  await reinject();
  await realSleep(5000); // settle: SPA traffic harvests headers

  const igFetch = makeWebviewIgFetch(wc);

  // Step 2: collections/list → id→{name,count} map.
  progress({ phase: "collections", count: 0, total: 0, done: false });
  const collMap = new Map<string, { name: string; count: number }>();
  const collRes = await igFetch('/api/v1/collections/list/?collection_types=["ALL_MEDIA_AUTO_COLLECTION","PRODUCT_AUTO_COLLECTION","MEDIA"]');
  if (collRes.status === 200 && collRes.body) {
    try {
      const j = JSON.parse(collRes.body);
      for (const it of j.items || []) {
        const id = it.collection_id || it.collection_pk || it.id;
        if (id) collMap.set(String(id), { name: it.collection_name || String(id), count: it.collection_media_count || 0 });
      }
    } catch { /* best effort */ }
  }
  log(`[instagram] ${collMap.size} collections`);

  // Step 3: paginate saved feed.
  progress({ phase: "fetch", count: 0, total: 0, done: false });
  const knownIds: Set<string> = await wc.executeJavaScript(`(function(){ var s = window.__ROOST_KNOWN_IDS__; return s ? Array.from(s) : []; })()`)
    .then((arr: unknown) => new Set(Array.isArray(arr) ? (arr as string[]) : []))
    .catch(() => new Set<string>());
  const prevComplete = await wc.executeJavaScript(`!!window.__ROOST_PREV_SYNC_COMPLETE__`).catch(() => false);

  const result = await paginateSaved({
    igFetch, sleep: realSleep,
    onRecords: async (recs) => { if (onRecords && !isStopped()) await onRecords(recs); },
    collMap, knownIds, prevComplete: prevComplete === true,
    batchSize: SYNC_BATCH_SIZE, earlyOutThreshold: EARLY_OUT_THRESHOLD,
    maxItems: opts.maxItems && opts.maxItems > 0 ? opts.maxItems : null,
    isStopped, onLog: log, onProgress: progress,
  });

  webviewEl.removeEventListener("dom-ready", reinject);
  progress({ phase: "done", count: result.totalFetched, total: result.totalFetched, done: true });
  const collections = [...collMap.values()].map((c) => ({ name: c.name, itemCount: c.count }));
  return { totalFetched: result.totalFetched, collections };
}
