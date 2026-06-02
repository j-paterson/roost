/**
 * Twitter/X MAIN world probe.
 *
 * Intercepts fetch and XHR to cache tweet objects from GraphQL responses,
 * detect bookmark mutations, and record bookmark timeline entries.
 * Also provides an auto-scroll controller for bulk capture.
 */
(function () {
  const store = window.__TWITTER_BOOKMARK_SPIKE__ = window.__TWITTER_BOOKMARK_SPIKE__ || {
    startedAt: new Date().toISOString(),
    host: location.host,
    ready: false,
    matchedUrls: 0,
    transports: { xhr: false, fetch: false },
    tweetCache: {},
    bookmarkOrder: [],
    seenTweetIds: {},
    pendingEnrichmentIds: {},
    lastTweetContext: null,
    events: [],
    // Ring-buffer of every graphql operation the probe has intercepted in this
    // page. Used by E2E tests / diagnostic logging to surface what Twitter's
    // own page actually fetched — e.g. whether TweetDetail is still the right
    // op name on status pages. Bounded to 50.
    observedOperations: [],
    // Diagnostic counters — let tests see whether the fetch/XHR patches are
    // actually catching anything, independent of graphql filtering.
    fetchCalls: 0,
    xhrCalls: 0,
    recentFetchUrls: [],
    lastError: null,
  };

  if (store.installed) return;
  store.installed = true;

  // ── URL helpers ───────────────────────────────────────────

  const GRAPHQL_RE = /\/i\/api\/graphql\//;
  const BOOKMARK_TIMELINE_RE = /\/i\/api\/graphql\/.+\/Bookmarks(?:\?|$)/;
  const TWEET_DETAIL_RE = /\/i\/api\/graphql\/.+\/TweetDetail(?:\?|$)/;
  const TWEET_RESULT_BY_REST_ID_RE = /\/i\/api\/graphql\/.+\/TweetResultByRestId(?:\?|$)/;
  const REPLAY_TTL_MS = 30 * 60 * 1000;

  function operationName(url) {
    // Try absolute parse first — safe even when location.origin is "null"
    // (about:blank, data:, sandboxed contexts).  Fall back to base-relative
    // for root-relative paths like "/i/api/graphql/.../TweetDetail".
    try { return new URL(url).pathname.split("/").filter(Boolean).pop() || null; }
    catch {}
    try { return new URL(url, location.origin).pathname.split("/").filter(Boolean).pop() || null; }
    catch { return null; }
  }

  function isBookmarkOp(url, method) {
    return GRAPHQL_RE.test(url) && method !== "GET" && (operationName(url) || "").toLowerCase().includes("bookmark");
  }

  function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const out = {};
      headers.forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (Array.isArray(headers)) {
      const out = {};
      for (const [k, v] of headers) out[k] = v;
      return out;
    }
    return { ...headers };
  }

  function recordTweetDetail(url, headers) {
    const prev = store.tweetDetailReplay;
    if (prev && Date.now() - prev.recordedAt < REPLAY_TTL_MS) return;
    store.tweetDetailReplay = {
      url,
      headers: headersToObject(headers),
      recordedAt: Date.now(),
    };
  }

  function recordArticleReplay(url, headers) {
    const prev = store.articleResultReplay;
    if (prev && Date.now() - prev.recordedAt < REPLAY_TTL_MS) return;
    store.articleResultReplay = {
      url,
      headers: headersToObject(headers),
      recordedAt: Date.now(),
    };
  }

  /** Capture URL+headers from ANY successful authenticated GraphQL request as
   *  a fallback header source. Used by the article-fetcher's queryId-extraction
   *  bootstrap when neither articleResultReplay nor tweetDetailReplay are
   *  available — the Bookmarks op fires reliably during every sync, so this
   *  almost always has a value to source headers from.
   *
   *  Authenticated bearer is required: we only record requests carrying an
   *  authorization header (skips any oauth-anonymous requests). */
  function recordAnyAuthGraphqlReplay(url, headers) {
    const prev = store.anyAuthGraphqlReplay;
    if (prev && Date.now() - prev.recordedAt < REPLAY_TTL_MS) return;
    const obj = headersToObject(headers);
    // Lowercased lookup — header keys arrive case-mixed.
    const hasAuth = Object.keys(obj).some(k => k.toLowerCase() === "authorization");
    if (!hasAuth) return;
    store.anyAuthGraphqlReplay = {
      url,
      headers: obj,
      recordedAt: Date.now(),
    };
  }

  // ── Tweet extraction ──────────────────────────────────────

  function unwrapTweet(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (obj.__typename === "TweetWithVisibilityResults" && obj.tweet?.rest_id) return obj.tweet;
    if (obj.__typename === "Tweet" && obj.rest_id) return obj;
    if (obj.rest_id && obj.legacy) return obj;
    if (obj.tweet?.rest_id) return obj.tweet;
    if (obj.result) return unwrapTweet(obj.result);
    return null;
  }

  function tweetIsRich(t) { return !!(t?.core?.user_results || t?.legacy?.full_text); }

  function hasContentState(t) {
    return !!t?.article?.article_results?.result?.content_state
        || !!t?.quoted_status_result?.result?.article?.article_results?.result?.content_state;
  }

  function putTweet(tweet) {
    if (!tweet?.rest_id) return;
    const prev = store.tweetCache[tweet.rest_id];
    if (!prev) {
      store.tweetCache[tweet.rest_id] = tweet;
    } else if (!prev.core?.user_results && tweet.core?.user_results) {
      store.tweetCache[tweet.rest_id] = tweet;
    } else if (!prev.legacy?.full_text && tweet.legacy?.full_text) {
      store.tweetCache[tweet.rest_id] = { ...prev, ...tweet };
    } else if (!hasContentState(prev) && hasContentState(tweet)) {
      // Bookmark response → replay response upgrade: merge the article body
      // (and surrounding fields) into the cached entry.
      store.tweetCache[tweet.rest_id] = { ...prev, ...tweet };
    }

    // Delayed enrichment: if we got a richer version after the bookmark action
    if (store.pendingEnrichmentIds[tweet.rest_id] && tweetIsRich(store.tweetCache[tweet.rest_id])) {
      window.postMessage({
        type: "ROOST_TWITTER_ENRICH",
        itemId: tweet.rest_id,
        rawData: store.tweetCache[tweet.rest_id],
        url: location.href,
        timestamp: new Date().toISOString(),
      }, "*");
      delete store.pendingEnrichmentIds[tweet.rest_id];
    }

    // Article body arrival notification: separate channel from ENRICH so the
    // article fetcher can listen without subscribing to general enrich events.
    // NOTE: this fires every putTweet call once content_state is present, not
    // only on first arrival. The same article can post multiple times in one
    // event-loop tick if walkAndCache visits it more than once (e.g., a tweet
    // that appears both standalone and as a quoted_status_result in the same
    // response). Consumers must be idempotent on duplicate (itemId, body) pairs.
    if (hasContentState(store.tweetCache[tweet.rest_id])) {
      window.postMessage({
        type: "ROOST_TWITTER_ARTICLE_BODY",
        itemId: tweet.rest_id,
        rawData: store.tweetCache[tweet.rest_id],
      }, "*");
    }
  }

  // Recursive walker — finds tweets anywhere in a response object.
  // Depth cap must accommodate TweetDetail's threaded_conversation_with_injections_v2
  // tree, where tweets live at depth 9-16+ (instructions → entries → content →
  // items → item → itemContent → tweet_results → result). 25 gives headroom for
  // nested quoted tweets.
  function walkAndCache(obj, depth = 0) {
    if (depth > 25 || !obj || typeof obj !== "object") return;
    const t = unwrapTweet(obj);
    if (t) putTweet(t);
    if (Array.isArray(obj)) { for (const el of obj) walkAndCache(el, depth + 1); return; }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walkAndCache(v, depth + 1);
    }
  }

  // Extract ordered tweets from timeline instructions
  function tweetsFromInstructions(instructions) {
    const out = [];
    for (const inst of instructions) {
      if (inst?.type !== "TimelineAddEntries" || !Array.isArray(inst.entries)) continue;
      for (const entry of inst.entries) {
        const t = unwrapTweet(entry?.content?.itemContent?.tweet_results?.result);
        if (t?.rest_id) out.push(t);
        for (const mi of entry?.content?.items || []) {
          const t2 = unwrapTweet(mi?.item?.itemContent?.tweet_results?.result);
          if (t2?.rest_id) out.push(t2);
        }
      }
    }
    return out;
  }

  // ── Response processing ───────────────────────────────────

  function processGraphQL(url, method, status, text) {
    const op = operationName(url);
    if (op) {
      store.observedOperations.push({ op, method, status, at: Date.now() });
      if (store.observedOperations.length > 50) store.observedOperations.shift();
    }

    let data;
    try { data = JSON.parse(text); } catch { return; }

    walkAndCache(data);

    if (!BOOKMARK_TIMELINE_RE.test(url)) return;

    const instructions = data?.data?.bookmark_timeline_v2?.timeline?.instructions || [];
    const tweets = tweetsFromInstructions(instructions);

    store.ready = true;
    store.matchedUrls++;
    const newTweets = [];
    for (const tw of tweets) {
      store.tweetCache[tw.rest_id] = tw;
      if (!store.seenTweetIds[tw.rest_id]) {
        store.seenTweetIds[tw.rest_id] = true;
        store.bookmarkOrder.push(tw.rest_id);
        newTweets.push(tw);
      }
    }
    // Stream new tweets to panel
    if (newTweets.length > 0) {
      window.postMessage({
        type: "ROOST_TWITTER_ITEMS",
        items: newTweets,
        total: store.bookmarkOrder.length,
      }, "*");
    }
    store.events.unshift({ timestamp: new Date().toISOString(), method, status, tweets: tweets.length });
    if (store.events.length > 20) store.events.length = 20;
    store.lastError = null;
  }

  // ── Bookmark mutation handling ────────────────────────────

  function mutationItemId(url, body) {
    try {
      const parsed = new URL(url, location.origin);
      const urlVars = JSON.parse(parsed.searchParams.get("variables") || "{}");
      let payload = {};
      if (typeof body === "string") try { payload = JSON.parse(body); } catch {}
      const vars = payload?.variables || urlVars || payload;
      return vars?.tweet_id || vars?.tweetId || vars?.rest_id || vars?.id || null;
    } catch { return null; }
  }

  function emitAction(action, itemId) {
    if (!itemId) return;
    const cached = store.tweetCache[itemId] || store.lastTweetContext?.rawData || null;
    const rawData = action === "remove" ? null : cached;
    if (action === "add" && !rawData) store.pendingEnrichmentIds[itemId] = true;
    window.postMessage({
      type: "ROOST_TWITTER_BOOKMARK_ACTION", action, itemId, rawData,
      url: location.href, timestamp: new Date().toISOString(),
    }, "*");
  }

  function mutationAction(url) {
    const op = (operationName(url) || "").toLowerCase();
    return (op.includes("delete") || op.includes("remove") || op.includes("unbookmark")) ? "remove" : "add";
  }

  // ── DOM tweet capture (click context) ─────────────────────

  function tweetFromArticle(article) {
    if (!article) return null;
    const link = article.querySelector('a[href*="/status/"]');
    const m = link?.getAttribute("href")?.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    const handle = nameEl?.innerText?.match(/@([A-Za-z0-9_]+)/)?.[1] || m[1];
    const display = nameEl?.innerText?.split("\n").map(s => s.trim())
      .find(s => s && !s.startsWith("@") && !/^\d/.test(s) && !s.includes("·")) || handle;
    return {
      __typename: "Tweet", rest_id: m[2],
      core: { user_results: { result: { __typename: "User", core: { name: display, screen_name: handle }, legacy: {} } } },
      legacy: { id_str: m[2], full_text: text },
    };
  }

  document.addEventListener("click", (e) => {
    const article = e.target?.closest?.('article[data-testid="tweet"]');
    const tw = tweetFromArticle(article);
    if (tw) { putTweet(tw); store.lastTweetContext = { itemId: tw.rest_id, rawData: tw }; }
  }, true);

  // ── Fetch interception ────────────────────────────────────

  const nativeFetch = window.fetch;

  async function roostFetch(...args) {
    const req = args[0];
    const init = args[1] || {};
    const url = typeof req === "string" ? req : req?.url || "";
    const method = (init.method || (req instanceof Request ? req.method : "GET")).toUpperCase();
    let body = init.body || null;
    if (!body && req instanceof Request) {
      try { body = await req.clone().text(); } catch { body = null; }
    }

    store.fetchCalls++;
    if (store.recentFetchUrls.length < 30) {
      store.recentFetchUrls.push(url.slice(0, 200));
    }

    const response = await nativeFetch.apply(this, args);

    if (GRAPHQL_RE.test(url)) {
      store.transports.fetch = true;
      response.clone().text()
        .then((text) => processGraphQL(url, method, response.status, text))
        .catch(() => {});
      if (response.ok) {
        const reqHeaders = init.headers || (req instanceof Request ? req.headers : null);
        if (TWEET_DETAIL_RE.test(url)) recordTweetDetail(url, reqHeaders);
        if (TWEET_RESULT_BY_REST_ID_RE.test(url)) recordArticleReplay(url, reqHeaders);
        if (GRAPHQL_RE.test(url)) recordAnyAuthGraphqlReplay(url, reqHeaders);
      }
    }

    if (response.ok && isBookmarkOp(url, method)) {
      emitAction(mutationAction(url), mutationItemId(url, body));
    }

    return response;
  }

  try {
    Object.defineProperty(window, "fetch", {
      get() { return roostFetch; },
      set() {},
      configurable: true,
    });
  } catch { window.fetch = roostFetch; }

  // ── XHR interception ──────────────────────────────────────

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._roost = { method: String(method || "GET").toUpperCase(), url: String(url || ""), body: null, headers: {} };
    return nativeOpen.apply(this, arguments);
  };

  // Capture request headers so recordTweetDetail / recordArticleReplay can
  // replay with correct auth. Twitter's SPA routes TweetDetail (and likely
  // TweetResultByRestId) through XHR rather than fetch, so we can't rely on
  // the fetch interceptor to capture it.
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._roost) this._roost.headers[name] = value;
    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this._roost;
    if (meta && !this._roostBound) {
      this._roostBound = true;
      this.addEventListener("load", () => {
        try {
          store.xhrCalls++;
          if (GRAPHQL_RE.test(meta.url)) {
            store.transports.xhr = true;
            processGraphQL(meta.url, meta.method, this.status, this.responseText || "");
          }
          if (this.status >= 200 && this.status < 400) {
            if (TWEET_DETAIL_RE.test(meta.url)) recordTweetDetail(meta.url, meta.headers);
            if (TWEET_RESULT_BY_REST_ID_RE.test(meta.url)) recordArticleReplay(meta.url, meta.headers);
            if (GRAPHQL_RE.test(meta.url)) recordAnyAuthGraphqlReplay(meta.url, meta.headers);
          }
          if (this.status >= 200 && this.status < 400 && isBookmarkOp(meta.url, meta.method)) {
            emitAction(mutationAction(meta.url), mutationItemId(meta.url, meta.body));
          }
        } catch {}
      });
    }
    if (meta) meta.body = body;
    return nativeSend.apply(this, arguments);
  };

  // ── Auto-scroll controller ────────────────────────────────

  const scroll = store._autoScroll = {
    active: false, intervalId: null, interval: 2000,
    lastCount: 0, lastHeight: 0, staleTicks: 0,
    maxStale: 15, startedAt: 0, maxDuration: 30 * 60 * 1000,
  };

  function scrollMsg(type, extra) {
    window.postMessage({ type, captured: store.bookmarkOrder.length, ...extra }, "*");
  }

  function startScroll() {
    if (scroll.active) return;
    Object.assign(scroll, {
      active: true, staleTicks: 0,
      lastCount: store.bookmarkOrder.length,
      lastHeight: document.documentElement.scrollHeight,
      startedAt: Date.now(),
    });
    scrollMsg("ROOST_TWITTER_SCROLL_PROGRESS", { active: true });

    scroll.intervalId = setInterval(() => {
      if (!scroll.active) return;
      if (Date.now() - scroll.startedAt > scroll.maxDuration) { stopScroll("timeout"); return; }
      // Don't count stale ticks while tab is hidden — Twitter pauses loading
      if (document.visibilityState === "hidden") return;

      const count = store.bookmarkOrder.length;
      const height = document.documentElement.scrollHeight;
      if (count > scroll.lastCount || height > scroll.lastHeight) {
        scroll.staleTicks = 0; scroll.lastCount = count; scroll.lastHeight = height;
      } else { scroll.staleTicks++; }

      if (scroll.staleTicks >= scroll.maxStale) { stopScroll("stale"); return; }
      window.scrollTo(0, document.documentElement.scrollHeight);
      scrollMsg("ROOST_TWITTER_SCROLL_PROGRESS", { active: true });
    }, scroll.interval);
  }

  function stopScroll(reason) {
    if (scroll.intervalId) { clearInterval(scroll.intervalId); scroll.intervalId = null; }
    scroll.active = false;
    scrollMsg("ROOST_TWITTER_SCROLL_DONE", { reason: reason || "manual" });
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    if (ev.data?.type === "ROOST_TWITTER_START_SCROLL") startScroll();
    if (ev.data?.type === "ROOST_TWITTER_STOP_SCROLL") stopScroll("manual");
  });
})();
