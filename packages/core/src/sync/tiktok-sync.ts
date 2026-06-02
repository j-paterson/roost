import { roostNormalize, type NormalizedRecord } from "../lib/normalize";
import type { StopSignal, SyncPhaseProgress, ElectronWebview } from "@/types/sync";
import { SYNC_BATCH_SIZE } from "@/config";
// @ts-ignore — raw probe loaded as string by esbuild plugin
import tiktokProbeSource from "../probes/tiktok-probe.probe";

interface SyncResult {
  totalFetched: number;
  collections: { name: string; itemCount: number }[];
}

export async function syncTikTok(
  wc: ElectronWebview,
  webviewEl: ElectronWebview,
  opts: { stopSignal?: StopSignal; maxItems?: number } = {},
  onProgress?: (p: SyncPhaseProgress) => void,
  onRecords?: (records: NormalizedRecord[]) => Promise<void>,
  onLog?: (msg: string) => void,
): Promise<SyncResult> {
  const isStopped = () => opts.stopSignal?.stopped === true;
  // Optional cap on items fetched. Used by the first-sync sample path —
  // bound the initial run so users see results in ~2 min instead of hours.
  const cap = opts.maxItems && opts.maxItems > 0 ? opts.maxItems : null;

  // Step 1: Inject probe
  onProgress?.({ phase: "inject", count: 0, total: 0, done: false });

  const injected = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 20000);
    const handler = async () => {
      try {
        await wc.executeJavaScript(`try { delete window.__TIKTOK_FAVORITES__; } catch(e) {} void 0;`);
        await wc.executeJavaScript(`try { ${tiktokProbeSource}; 'ok'; } catch(e) { 'error: ' + e.message; }`);
        clearTimeout(timeout);
        resolve(true);
      } catch { clearTimeout(timeout); resolve(false); }
    };
    webviewEl.addEventListener("dom-ready", handler, { once: true });
    webviewEl.loadURL("https://www.tiktok.com/");
  });

  if (!injected) throw new Error("Failed to inject TikTok probe");
  await new Promise(r => setTimeout(r, 3000));

  // Step 2: Check app context
  onProgress?.({ phase: "context", count: 0, total: 0, done: false });
  const ctxCheck = await wc.executeJavaScript(`
    (async () => {
      try {
        var store = window.__TIKTOK_FAVORITES__;
        if (!store) return 'no_store';
        var ud = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
        if ((!ud || Object.keys(ud).length === 0)) {
          var el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          if (el && el.textContent) ud = JSON.parse(el.textContent);
        }
        if (!ud) return 'no_rehydration_data';
        return 'ok';
      } catch(e) { return 'error: ' + e.message; }
    })();
  `);
  if (ctxCheck !== "ok") throw new Error(`TikTok context: ${ctxCheck}`);

  // Step 3: Navigate to user profile collections tab so the probe can scrape them
  onProgress?.({ phase: "collections", count: 0, total: 0, done: false });

  // Get the username — try multiple sources
  const username = await wc.executeJavaScript(`
    (function() {
      try {
        // From probe's app context
        var store = window.__TIKTOK_FAVORITES__;
        if (store?.appContext?.$user?.uniqueId) return store.appContext.$user.uniqueId;

        // From rehydration data
        var ud = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
        if (!ud || Object.keys(ud).length === 0) {
          var el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          if (el && el.textContent) ud = JSON.parse(el.textContent);
        }
        if (ud) {
          var ds = ud.__DEFAULT_SCOPE__ || ud;
          var appCtx = ds["webapp.app-context"] || {};
          if (appCtx.user?.uniqueId) return appCtx.user.uniqueId;
          if (appCtx.$user?.uniqueId) return appCtx.$user.uniqueId;
        }

        // From cookie
        var match = document.cookie.match(/(?:^|;\\s*)uniqueId=([^;]+)/);
        if (match) return decodeURIComponent(match[1]);

        return null;
      } catch(e) { return null; }
    })();
  `).catch(() => null);

  if (username) {
    onLog?.(`Found username: @${username}, navigating to profile...`);
    webviewEl.loadURL(`https://www.tiktok.com/@${username}`);

    // Wait for profile page to load
    await new Promise<void>((resolve) => {
      const handler = () => resolve();
      webviewEl.addEventListener("dom-ready", handler, { once: true });
      setTimeout(() => resolve(), 10000);
    });
    await new Promise(r => setTimeout(r, 2000));
    onLog?.("Profile loaded, re-injecting probe...");

    // Re-inject probe (navigation destroyed the previous one)
    await wc.executeJavaScript(`try { ${tiktokProbeSource}; 'ok'; } catch(e) { 'error: ' + e.message; }`);
    await new Promise(r => setTimeout(r, 1000));

    // Click the Favorites tab — try multiple selectors, validate result
    const clickResult = await wc.executeJavaScript(`
      (function() {
        try {
          // Already visible?
          if (document.querySelectorAll('a[href*="/collection/"]').length > 0)
            return 'already_visible';

          // Strategy 1: data-e2e attributes (TikTok's test IDs)
          var tabs = document.querySelectorAll('[data-e2e*="collect"], [data-e2e*="favorite"], [data-e2e*="bookmark"]');
          if (tabs.length > 0) { tabs[0].click(); return 'clicked_e2e'; }

          // Strategy 2: role=tab with matching text (language-dependent)
          var allTabs = document.querySelectorAll('[role="tab"]');
          for (var i = 0; i < allTabs.length; i++) {
            var text = (allTabs[i].textContent || '').toLowerCase();
            if (text.includes('collect') || text.includes('favorite') || text.includes('bookmark')) {
              allTabs[i].click(); return 'clicked_tab';
            }
          }

          // Diagnostic: report what we see so failures are debuggable
          var found = {
            tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(t => t.textContent?.trim()),
            e2e: Array.from(document.querySelectorAll('[data-e2e]')).map(e => e.getAttribute('data-e2e')).filter(a => a && a.includes('tab')),
          };
          return 'not_found:' + JSON.stringify(found);
        } catch(e) { return 'error:' + e.message; }
      })();
    `);

    if (clickResult?.startsWith("not_found") || clickResult?.startsWith("error")) {
      onLog?.(`[WARN] Could not find Favorites tab: ${clickResult}`);
      onLog?.("Continuing without collections — items will sync but won't have collection tags");
    } else {
      onLog?.(`Favorites tab: ${clickResult}`);
      await new Promise(r => setTimeout(r, 2000));

      // Click Collections sub-button via sendInputEvent (React needs Chromium-level click)
      // Try multiple selectors for the button
      const coords = await wc.executeJavaScript(`
        (function() {
          // Strategy 1: ID
          var btn = document.getElementById('collections');
          // Strategy 2: button text
          if (!btn) {
            var buttons = document.querySelectorAll('button, [role="tab"]');
            for (var i = 0; i < buttons.length; i++) {
              var t = (buttons[i].textContent || '').trim().toLowerCase();
              if (t === 'collections' || t.startsWith('collections')) { btn = buttons[i]; break; }
            }
          }
          // Strategy 3: data-e2e
          if (!btn) btn = document.querySelector('[data-e2e*="collection-tab"], [data-e2e*="collections"]');
          if (!btn) return null;
          var rect = btn.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
        })();
      `).catch(() => null);

      if (coords) {
        const { x, y } = JSON.parse(coords);
        onLog?.(`Collections button at ${x},${y} — clicking`);
        webviewEl.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));
        webviewEl.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      } else {
        onLog?.("[WARN] Collections sub-button not found — trying to scrape from current view");
      }

      // Scroll to load all collections
      let collCount = 0;
      let stableChecks = 0;
      const MAX_SCROLL_ATTEMPTS = 50;

      // Diagnose which scroll container we're using
      const scrollDiag = await wc.executeJavaScript(`
        (function() {
          var e2e = document.querySelector('[data-e2e*="collection-list"], [data-e2e*="favorites-collection"]');
          // Walk up from the first collection link to find the scrollable ancestor
          var link = document.querySelector('a[href*="/collection/"]');
          var scrollParent = null;
          if (link) {
            var el = link.parentElement;
            while (el && el !== document.body) {
              var style = window.getComputedStyle(el);
              if (style.overflow === 'auto' || style.overflow === 'scroll' ||
                  style.overflowY === 'auto' || style.overflowY === 'scroll') {
                scrollParent = { tag: el.tagName, class: (el.className || '').slice(0, 80),
                  scrollH: el.scrollHeight, clientH: el.clientHeight };
                break;
              }
              el = el.parentElement;
            }
          }
          return JSON.stringify({ e2e: !!e2e, scrollParent: scrollParent, links: document.querySelectorAll('a[href*="/collection/"]').length });
        })();
      `).catch(() => "{}");
      onLog?.(`Scroll diag: ${scrollDiag}`);

      for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
        if (isStopped()) break;
        await new Promise(r => setTimeout(r, 1500));

        const newCount = await wc.executeJavaScript(`
          (function() {
            // Scroll the last collection link into view — this triggers TikTok's
            // lazy loading regardless of which ancestor is the scroll container.
            var links = document.querySelectorAll('a[href*="/collection/"]');
            if (links.length > 0) {
              links[links.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
            // Also try page-level scroll as backup
            window.scrollTo(0, document.body.scrollHeight);
            return links.length;
          })();
        `).catch(() => 0);

        if (newCount > collCount) {
          onLog?.(`Collections: ${newCount} found (scrolling...)`);
          collCount = newCount;
          stableChecks = 0;
        } else {
          stableChecks++;
          if (stableChecks >= 3) break;
        }
      }

      if (collCount > 0) {
        onLog?.(`Found ${collCount} collection links`);
      } else {
        onLog?.("[WARN] No collection links found after scrolling — proceeding without collections");
      }
    }
  } else {
    onLog?.("Could not find username — skipping collections scan");
  }

  // Set up log relay — probe posts ROOST_TIKTOK_LOG messages
  await wc.executeJavaScript(`
    if (!window.__roostLogQueue) {
      window.__roostLogQueue = [];
      window.addEventListener('message', function(e) {
        if (e.data?.type === 'ROOST_TIKTOK_LOG') window.__roostLogQueue.push(e.data.msg);
      });
    }
    void 0;
  `).catch(() => {});

  // Step 4: Trigger fetch (probe will scan current DOM for collections)
  onProgress?.({ phase: "fetch", count: 0, total: 0, done: false });
  await wc.executeJavaScript(`
    window.__tiktokFetchAllFavorites(false, null);
    void 0;
  `);

  // Step 5: Poll store and stream records in batches
  let lastCollected = 0;
  let totalFetched = 0;
  const BATCH_SIZE = SYNC_BATCH_SIZE;

  while (!isStopped()) {
    await new Promise(r => setTimeout(r, 1000));
    if (isStopped()) break;

    // Drain log queue from probe
    const probeLogs = await wc.executeJavaScript(`
      (function() {
        var q = window.__roostLogQueue || [];
        window.__roostLogQueue = [];
        return JSON.stringify(q);
      })();
    `).catch(() => "[]");
    for (const msg of JSON.parse(probeLogs)) {
      onLog?.(msg);
    }

    const poll = await wc.executeJavaScript(`
      (function() {
        try {
          var s = window.__TIKTOK_FAVORITES__;
          if (!s) return JSON.stringify({ count: 0, done: true });
          return JSON.stringify({
            count: s.favoriteOrder.length,
            done: !s.hasMore || !!window.__tiktokStopFetch,
            error: s.lastError ? s.lastError.message : null,
          });
        } catch(e) { return JSON.stringify({ count: 0, done: true, error: e.message }); }
      })();
    `).catch(() => '{"count":0,"done":true}');

    if (isStopped()) break;

    const status = JSON.parse(poll);
    totalFetched = status.count;
    onProgress?.({ phase: "fetch", count: totalFetched, total: 0, done: false });

    // Sample-cap: tell the probe to stop fetching, then cut off after the
    // current batch drains. The poll loop's done-check picks this up next pass.
    if (cap != null && totalFetched >= cap) {
      await wc.executeJavaScript(`window.__tiktokStopFetch=true;void 0;`).catch(() => {});
      onLog?.(`[sample-sync] reached ${cap}-item cap; stopping fetch`);
    }

    while (totalFetched - lastCollected >= BATCH_SIZE && !isStopped()) {
      // Check how many items in this batch are already known — skip if all known
      const knownCount = await wc.executeJavaScript(`
        (function() {
          var s = window.__TIKTOK_FAVORITES__;
          var known = window.__ROOST_KNOWN_IDS__;
          if (!s || !known) return 0;
          var ids = s.favoriteOrder.slice(${lastCollected}, ${lastCollected + BATCH_SIZE});
          var count = 0;
          for (var i = 0; i < ids.length; i++) {
            if (known.has('tiktok:' + ids[i])) count++;
          }
          return count;
        })();
      `).catch(() => 0);

      if (knownCount === BATCH_SIZE) {
        // Entire batch is known — skip collection entirely
        onLog?.(`Skipped batch at ${lastCollected} — all ${BATCH_SIZE} items known`);
        lastCollected += BATCH_SIZE;
        continue;
      }

      // Batch has new or incomplete items — collect non-known ones
      const batch = await collectChunkFiltered(wc, lastCollected, BATCH_SIZE);
      if (batch.length > 0 && onRecords && !isStopped()) await onRecords(batch);
      lastCollected += BATCH_SIZE;
    }

    if (status.done || status.error) break;
  }

  // Stop the probe's internal fetch immediately
  await wc.executeJavaScript(`window.__tiktokStopFetch = true; void 0;`).catch(() => {});

  // Only collect remaining if not stopped
  if (!isStopped() && totalFetched > lastCollected) {
    const batch = await collectChunkFiltered(wc, lastCollected, totalFetched - lastCollected);
    if (batch.length > 0 && onRecords) await onRecords(batch);
  }

  // Get collections info
  const collectionsJson = await wc.executeJavaScript(`
    (function() {
      try { return JSON.stringify(window.__TIKTOK_FAVORITES__._collections || []); }
      catch(e) { return '[]'; }
    })();
  `).catch(() => "[]");

  onProgress?.({ phase: "done", count: totalFetched, total: totalFetched, done: true });
  return { totalFetched, collections: JSON.parse(collectionsJson) };
}

/** Collect a chunk, filtering out known IDs inside the webview to avoid serializing large objects */
async function collectChunkFiltered(wc: ElectronWebview, offset: number, count: number): Promise<NormalizedRecord[]> {
  const CHUNK = 50;
  const records: NormalizedRecord[] = [];
  for (let i = offset; i < offset + count; i += CHUNK) {
    const limit = Math.min(CHUNK, offset + count - i);
    const chunk = await wc.executeJavaScript(`
      (function() {
        var s = window.__TIKTOK_FAVORITES__;
        var known = window.__ROOST_KNOWN_IDS__;
        var ids = s.favoriteOrder.slice(${i}, ${i + limit});
        var results = [];
        for (var j = 0; j < ids.length; j++) {
          if (known && known.has('tiktok:' + ids[j])) continue;
          results.push({ id: ids[j], raw: s.videoCache[ids[j]] || null });
        }
        return JSON.stringify(results);
      })();
    `).catch(() => "[]");

    const parsed = JSON.parse(chunk);
    const baseTime = Date.now();
    for (let j = 0; j < parsed.length; j++) {
      const { id, raw } = parsed[j];
      if (!raw) continue;
      const record = roostNormalize("tiktok", raw, {
        savedAt: new Date(baseTime - (i - offset + j)).toISOString(),
        capturedVia: "sync",
      });
      if (record) records.push(record);
    }
  }
  return records;
}
