/**
 * TikTok favorites probe.
 *
 * Runs in the MAIN world so it has access to TikTok's page state and cookies.
 * Unlike the previous version, this does NOT monkey-patch fetch — that breaks
 * TikTok's app initialization. Instead, it reads app context from the page and
 * makes its own direct API calls (same approach as myfaveTT).
 */
(function () {
  const store = window.__TIKTOK_FAVORITES__ = window.__TIKTOK_FAVORITES__ || {
    startedAt: new Date().toISOString(),
    host: window.location.host,
    ready: false,
    appContext: null,
    videoCache: {},
    favoriteOrder: [],
    seenIds: {},
    cursor: "0",
    hasMore: true,
    events: [],
    lastError: null,
    collections: [],
  };

  if (store.installed) return;
  store.installed = true;

  // ── App context extraction ────────────────────────────────

  function getAppContext() {
    if (store.appContext) return store.appContext;
    try {
      if (window.__NEXT_DATA__?.props?.initialProps) {
        console.log("[Roost TikTok] Found app context via __NEXT_DATA__");
        store.appContext = window.__NEXT_DATA__.props.initialProps;
        return store.appContext;
      }
    } catch {}
    try {
      if (window.SIGI_STATE?.AppContext?.appContext) {
        console.log("[Roost TikTok] Found app context via SIGI_STATE");
        store.appContext = window.SIGI_STATE.AppContext.appContext;
        return store.appContext;
      }
    } catch {}
    // Newer TikTok pages store data in a <script> tag, not on window
    try {
      let ud = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
      // If the window global is empty, read from the script tag
      if (!ud || Object.keys(ud).length === 0) {
        const scriptEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
        if (scriptEl?.textContent) {
          ud = JSON.parse(scriptEl.textContent);
        }
      }
      if (ud) {
        const defaultScope = ud.__DEFAULT_SCOPE__ || ud;
        const appCtx = defaultScope?.["webapp.app-context"];
        const bizCtx = defaultScope?.["webapp.biz-context"];
        if (appCtx || bizCtx) {
          console.log("[Roost TikTok] Found app context via __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag");
          // Normalize keys: TikTok uses "user"/"wid"/"region" not "$user"/"$wid"/"$region"
          const raw = appCtx || {};
          store.appContext = {
            $user: raw.user || raw.$user || {},
            $wid: raw.wid || raw.$wid || "",
            $region: raw.region || raw.$region || "",
            $language: raw.language || raw.$language || "",
            $os: raw.os || raw.$os || "",
            $domains: bizCtx?.domains || raw.domains || {},
          };
          console.log("[Roost TikTok] User secUid:", store.appContext.$user?.secUid);
          if (store.appContext.$user?.secUid) return store.appContext;
        }
      }
    } catch (err) {
      console.warn("[Roost TikTok] Error parsing rehydration data:", err);
    }
    return null;
  }

  // Diagnostic: log what globals ARE available
  function logAvailableGlobals() {
    const globals = [
      "__NEXT_DATA__", "SIGI_STATE", "__UNIVERSAL_DATA_FOR_REHYDRATION__",
      "__INITIAL_PROPS__", "__DATA__", "INITIAL_STATE", "__remixContext",
    ];
    for (const g of globals) {
      if (window[g]) {
        console.log(`[Roost TikTok] Found global: ${g}`, typeof window[g], Object.keys(window[g]).slice(0, 10));
      }
    }
    // Check for script tags with JSON data
    const scripts = document.querySelectorAll('script[id*="DATA"], script[id*="REHYDRATION"], script[id*="UNIVERSAL"], script[type="application/json"]');
    for (const s of scripts) {
      console.log(`[Roost TikTok] Found data script: id=${s.id} type=${s.type} len=${s.textContent?.length}`);
    }
  }

  async function fetchAppContext() {
    try {
      const res = await fetch("/node-webapp/api/app-context", { credentials: "include" });
      const data = await res.json();
      if (data.statusCode === 0) {
        console.log("[Roost TikTok] Found app context via /node-webapp/api/app-context");
        store.appContext = data;
        return store.appContext;
      }
    } catch (err) {
      console.warn("[Roost TikTok] /node-webapp/api/app-context failed:", err);
    }
    return null;
  }

  // Poll until app context is available (TikTok hydrates it after load)
  async function waitForAppContext(timeoutMs = 15000) {
    // Try synchronous sources first
    const immediate = getAppContext();
    if (immediate) return immediate;

    console.log("[Roost TikTok] Waiting for app context...");
    logAvailableGlobals();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ctx = getAppContext();
      if (ctx) return ctx;
      await new Promise(r => setTimeout(r, 500));
    }

    // Last resort: fetch from API
    console.log("[Roost TikTok] Polling timed out — re-checking globals:");
    logAvailableGlobals();
    console.log("[Roost TikTok] Trying /node-webapp/api/app-context");
    return await fetchAppContext();
  }

  // ── API URL builder ───────────────────────────────────────

  function getDeviceParams() {
    const verifyFp = document.cookie.match(/s_v_web_id=([^;]+)/)?.[1] || "";
    return {
      aid: "1988",
      app_name: "tiktok_web",
      channel: "tiktok_web",
      device_platform: "web_pc",
      referer: document.referrer,
      cookie_enabled: String(navigator.cookieEnabled),
      screen_width: String(screen.width),
      screen_height: String(screen.height),
      browser_language: navigator.language,
      browser_platform: navigator.platform,
      browser_name: navigator.appCodeName,
      browser_version: navigator.appVersion,
      browser_online: String(navigator.onLine),
      verifyFp,
    };
  }

  function getContextParams() {
    const ctx = getAppContext() || {};
    // Try to get device_id from cookies if not in context
    let deviceId = ctx.$wid || "";
    if (!deviceId) {
      try {
        const match = document.cookie.match(/(?:^|;\s*)tt_webid=([^;]+)/);
        if (match) deviceId = match[1];
      } catch {}
    }
    const lang = ctx.$language || navigator.language?.split("-")[0] || "en";
    return {
      device_id: deviceId,
      region: ctx.$region || "",
      priority_region: ctx.$user?.region || "",
      os: ctx.$os || "",
      app_language: lang,
      webcast_language: lang,
    };
  }

  function getUserParams() {
    const ctx = getAppContext();
    let secUid = ctx?.$user?.secUid;

    // Fallback: try to find secUid in the rehydration data
    if (!secUid) {
      try {
        const scriptEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
        if (scriptEl?.textContent) {
          // Quick regex search for secUid in the JSON
          const match = scriptEl.textContent.match(/"secUid"\s*:\s*"([^"]+)"/);
          if (match) secUid = match[1];
        }
      } catch {}
    }

    // Fallback: try cookies
    if (!secUid) {
      try {
        const match = document.cookie.match(/(?:^|;\s*)secUid=([^;]+)/);
        if (match) secUid = decodeURIComponent(match[1]);
      } catch {}
    }

    if (!secUid) return {};
    return {
      from_page: "user",
      secUid,
      language: ctx?.$language || navigator.language?.split("-")[0] || "en",
    };
  }

  function getApiDomain() {
    const ctx = getAppContext();
    let d = ctx?.$domains?.mTApi;
    if (!d) {
      try {
        const el = document.getElementById("api-domains");
        if (el?.textContent) {
          const domains = JSON.parse(el.textContent);
          d = domains.mTApi || domains.m;
        }
      } catch {}
    }
    return d?.startsWith("https://") ? d : "https://www.tiktok.com";
  }

  function buildApiUrl(path, extra = {}) {
    const url = new URL(`${getApiDomain()}${path}`);
    const params = { ...getDeviceParams(), ...getContextParams(), ...getUserParams(), ...extra };
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v ?? "");
    }
    return url.toString();
  }

  function buildFavoritesUrl(cursor, count = 30) {
    return buildApiUrl("/api/favorite/item_list/", { cursor: String(cursor), count: String(count) });
  }

  // ── Item extraction ───────────────────────────────────────

  function extractItemId(item) {
    if (!item || typeof item !== "object") return null;
    return item.id || item.video?.id || null;
  }

  function cacheItem(item) {
    const id = extractItemId(item);
    if (!id) return;
    const existing = store.videoCache[id];
    if (!existing) {
      store.videoCache[id] = item;
    } else if (!existing.author && item.author) {
      store.videoCache[id] = item;
    } else if (!existing.video?.playAddr && item.video?.playAddr) {
      store.videoCache[id] = { ...existing, ...item };
    }
  }

  // ── Fetch favorites directly ──────────────────────────────

  async function fetchFavoritesPage(cursor) {
    const url = buildFavoritesUrl(cursor);
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`TikTok API ${res.status}`);
    return await res.json();
  }

  function processResponse(data) {
    const list = data.itemList || data.items || data.item_list || [];
    const added = [];
    for (const item of list) {
      const id = extractItemId(item);
      if (!id) continue;
      cacheItem(item);
      if (item.diversificationLabels?.length > 0) {
        item._collection = item.diversificationLabels[0];
      }
      if (!store.seenIds[id]) {
        store.seenIds[id] = true;
        store.favoriteOrder.push(id);
        added.push(item);
      }
    }
    if (data.cursor !== undefined) store.cursor = String(data.cursor);
    if (data.hasMore !== undefined) store.hasMore = !!data.hasMore;

    // Stream items directly to the panel — no buffering
    if (added.length > 0) {
      window.postMessage({
        type: "ROOST_TIKTOK_ITEMS",
        items: added,
        total: store.favoriteOrder.length,
      }, "*");
    }

    return added;
  }

  // ── Fetch collections ───────────────────────────────────────

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`TikTok API ${res.status}`);
    return await res.json();
  }

  /**
   * Scrape collection names and IDs from the DOM.
   * Works when on the profile collections tab.
   * URL pattern: /@user/collection/Name-CollectionID
   */
  function scrapeCollectionsFromDOM() {
    const collections = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/collection/"]');
    for (const a of links) {
      const match = a.href.match(/\/collection\/(.+)-(\d+)$/);
      if (!match) continue;
      const id = match[2];
      if (seen.has(id)) continue;
      seen.add(id);
      const name = decodeURIComponent(match[1]);
      collections.push({ collectionId: id, name });
    }
    return collections;
  }

  async function fetchCollectionItems(collectionId, collectionName) {
    let count = 0;
    let cursor = "0";
    let hasMore = true;
    let collectionRetries = 0;
    while (hasMore) {
      if (window.__tiktokStopFetch) break;
      const url = buildApiUrl("/api/collection/item_list/", { collectionId, cursor, count: "30", sourceType: "113" });
      const data = await fetchJson(url);

      // Rate limit check
      const sc = data.statusCode || data.status_code || 0;
      if (sc !== 0) {
        if (!collectionRetries) collectionRetries = 0;
        collectionRetries++;
        if (collectionRetries <= 3) {
          const backoffs = [1000, 2000, 5000];
          const wait = backoffs[collectionRetries - 1] || 5000;
          console.log(`[Roost TikTok] Collection "${collectionName}" rate limited (attempt ${collectionRetries}/3), waiting ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.warn(`[Roost TikTok] Collection "${collectionName}" failed after 3 retries`);
        break;
      }
      collectionRetries = 0;

      const list = data.itemList || data.items || [];
      const added = [];
      for (const item of list) {
        const id = extractItemId(item);
        if (!id) continue;
        cacheItem(item);
        item._collection = collectionName;
        if (!store.seenIds[id]) {
          store.seenIds[id] = true;
          store.favoriteOrder.push(id);
          added.push(item);
        } else {
          const existing = store.videoCache[id];
          if (existing) existing._collection = collectionName;
        }
        count++;
      }

      // Stream collection items to panel
      if (added.length > 0) {
        window.postMessage({
          type: "ROOST_TIKTOK_ITEMS",
          items: added,
          total: store.favoriteOrder.length,
        }, "*");
      }

      cursor = String(data.cursor || "0");
      hasMore = !!data.hasMore && list.length > 0;
    }
    return count;
  }

  // ── Exported: fetch all favorites with pagination ─────────

  window.__tiktokFetchAllFavorites = async function (resume = false, knownCollections = null) {
    console.log("[Roost TikTok] fetchAllFavorites called", resume ? "(resuming)" : "(fresh)");
    const ctx = await waitForAppContext();
    if (!ctx) {
      console.error("[Roost TikTok] No app context found after timeout");
      store.lastError = { message: "Could not read TikTok app context. Try refreshing the page." };
      return { error: store.lastError.message, items: [] };
    }
    console.log("[Roost TikTok] App context found, user secUid:", ctx.$user?.secUid);
    window.__tiktokStopFetch = false;

    const collections = [];

    if (!resume) {
      // Reset store for a fresh fetch
      store.videoCache = {};
      store.favoriteOrder = [];
      store.seenIds = {};
      store.cursor = "0";
      store.hasMore = true;
      store.events = [];
      store.lastError = null;
      store.ready = false;

      // ── Phase 1: Fetch collections first (so items get tagged as they stream) ──

      try {
        console.log("[Roost TikTok] Phase 1: Scanning for collections in DOM...");
        const scraped = scrapeCollectionsFromDOM();
        console.log(`[Roost TikTok] Found ${scraped.length} collections:`, scraped.map(c => c.name));
        window.postMessage({ type: "ROOST_TIKTOK_LOG", msg: `Found ${scraped.length} collections` }, "*");

        for (let ci = 0; ci < scraped.length; ci++) {
          const col = scraped[ci];
          if (window.__tiktokStopFetch) break;
          window.postMessage({ type: "ROOST_TIKTOK_LOG", msg: `Collection ${ci + 1}/${scraped.length}: ${col.name}...` }, "*");

          if (knownCollections && knownCollections[col.name] !== undefined) {
            const checkUrl = buildApiUrl("/api/collection/item_list/", { collectionId: col.collectionId, cursor: "0", count: "1", sourceType: "113" });
            try {
              const checkData = await fetchJson(checkUrl);
              const total = checkData.total || checkData.totalCount || checkData.total_number || null;
              if (total !== null && total === knownCollections[col.name]) {
                console.log(`[Roost TikTok] Collection "${col.name}": unchanged (${total} items), skipping`);
                window.postMessage({ type: "ROOST_TIKTOK_LOG", msg: `  ${col.name}: unchanged (${total} items), skipped` }, "*");
                collections.push({ name: col.name, collectionId: col.collectionId, itemCount: total, skipped: true });
                continue;
              }
            } catch {}
          }
          const count = await fetchCollectionItems(col.collectionId, col.name);
          collections.push({ name: col.name, collectionId: col.collectionId, itemCount: count });
          console.log(`[Roost TikTok] Collection "${col.name}": ${count} items`);
          window.postMessage({ type: "ROOST_TIKTOK_LOG", msg: `  ${col.name}: ${count} items` }, "*");
        }
      } catch (err) {
        console.warn("[Roost TikTok] Collection fetch failed:", err);
      }

      // Reset cursor for flat favorites phase
      store.cursor = "0";
      store.hasMore = true;
    } else {
      console.log(`[Roost TikTok] Resuming from cursor=${store.cursor}, ${store.favoriteOrder.length} items already fetched`);
      store.lastError = null;
    }

    // ── Phase 2: Fetch flat favorites (items already in collections will be deduped) ──

    let pages = 0;

    let consecutiveKnownPages = 0;
    const knownIds = window.__ROOST_KNOWN_IDS__;
    // If previous sync completed, we can stop early when hitting known territory
    const prevSyncComplete = window.__ROOST_PREV_SYNC_COMPLETE__ || false;

    while (store.hasMore) {
      if (window.__tiktokStopFetch) { console.log("[Roost TikTok] Fetch stopped by user"); break; }
      try {
        const data = await fetchFavoritesPage(store.cursor);
        const statusCode = data.statusCode || data.status_code || 0;

        if (statusCode !== 0) {
          if (data.code === "10000" || data.type === "verify") {
            store.lastError = { message: "TikTok requires captcha verification. Please solve it and try again." };
            break;
          }
          if (!store._retryCount) store._retryCount = 0;
          store._retryCount++;
          if (store._retryCount <= 3) {
            const backoffs = [1000, 2000, 5000];
            const backoffMs = backoffs[store._retryCount - 1] || 5000;
            console.log(`[Roost TikTok] Rate limited (attempt ${store._retryCount}/3), waiting ${backoffMs / 1000}s...`);
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          }
          store.lastError = { message: `TikTok API error after 3 retries: code=${data.code} type=${data.type}` };
          break;
        }
        store._retryCount = 0;

        // Check if this page is all known items BEFORE processing
        const list = data.itemList || data.items || data.item_list || [];
        if (knownIds && list.length > 0) {
          const allKnown = list.every(item => {
            const id = extractItemId(item);
            return id && knownIds.has('tiktok:' + id);
          });
          if (allKnown) {
            consecutiveKnownPages++;
            console.log(`[Roost TikTok] Page ${pages + 1}: all ${list.length} items known (${consecutiveKnownPages} consecutive)`);
            // Update cursor to keep pagination moving
            if (data.cursor !== undefined) store.cursor = String(data.cursor);
            if (data.hasMore !== undefined) store.hasMore = !!data.hasMore;
            pages++;

            // If previous sync was complete, stop after 3 consecutive known pages
            if (prevSyncComplete && consecutiveKnownPages >= 3) {
              console.log("[Roost TikTok] Previous sync complete + 3 known pages — stopping early");
              store.hasMore = false;
              break;
            }
            continue; // skip processing, jump to next page
          }
          consecutiveKnownPages = 0;
        }

        const added = processResponse(data);
        pages++;
        store.ready = true;
        store.lastError = null;

        if (!store.hasMore || added.length === 0) break;
      } catch (err) {
        store.lastError = { message: err?.message || String(err) };
        break;
      }
    }

    window.postMessage({
      type: "ROOST_TIKTOK_DONE",
      captured: store.favoriteOrder.length,
      reason: store.hasMore ? "error" : "complete",
      error: store.lastError?.message || null,
    }, "*");

    store.collections = collections;

    return {
      items: [],
      collections,
      diagnostics: {
        interceptReady: store.ready,
        cachedVideos: store.favoriteOrder.length,
        collectionsFound: collections.length,
        pages,
        lastError: store.lastError,
      },
    };
  };

  window.__tiktokStopFetch = false;

  // ── Video download helper ─────────────────────────────────

  window.__tiktokDownloadVideoAsBase64 = async function (playAddr) {
    if (!playAddr) return null;
    try {
      const res = await fetch(playAddr, {
        credentials: "include",
        headers: { referer: "https://www.tiktok.com/" },
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  // ── Extract a single frame from a video as base64 PNG ──────

  window.__tiktokExtractFrame = function (videoBase64) {
    return new Promise((resolve) => {
      try {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;

        video.onloadedmetadata = () => {
          // Seek to the middle of the video
          video.currentTime = video.duration / 2;
        };

        video.onseeked = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.min(video.videoWidth, 512);
            canvas.height = Math.min(video.videoHeight, 512);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = canvas.toDataURL("image/jpeg", 0.8);
            video.src = ""; // free memory
            resolve(frame);
          } catch {
            resolve(null);
          }
        };

        video.onerror = () => resolve(null);

        // Timeout after 10s
        setTimeout(() => { video.src = ""; resolve(null); }, 10000);

        video.src = videoBase64;
      } catch {
        resolve(null);
      }
    });
  };
})();
