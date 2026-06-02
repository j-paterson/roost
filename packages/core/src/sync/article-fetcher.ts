/**
 * X Article body fetcher.
 *
 * Replays a previously-observed TweetResultByRestId GraphQL request from the
 * probe's cache, swapping in a different tweetId and adding
 * `withArticleRichContentState: true` to fieldToggles. The probe auto-harvests
 * the response into window.__TWITTER_BOOKMARK_SPIKE__.tweetCache, from which
 * we read the article body's content_state.
 *
 * Mirrors src/sync/thread-fetcher.ts in shape and concurrency model. See
 * docs/superpowers/specs/2026-04-30-x-article-body-fetching-design.md for the
 * full design.
 */
import type { ElectronWebview } from "@/types/sync";
import type { RawApiData } from "@/lib/normalize";

function hasContentStateAnywhere(t: RawApiData | null): boolean {
  if (!t) return false;
  const direct = (t as { article?: { article_results?: { result?: { content_state?: unknown } } } })
    .article?.article_results?.result?.content_state;
  if (direct) return true;
  const quoted = (t as { quoted_status_result?: { result?: { article?: { article_results?: { result?: { content_state?: unknown } } } } } })
    .quoted_status_result?.result?.article?.article_results?.result?.content_state;
  if (quoted) return true;
  return false;
}

const BOOTSTRAP_WAIT_MS = 8000;
const PER_REQUEST_DELAY_MS = 2000;
const RATE_LIMIT_BACKOFF_MS = 10_000;
const TIMEOUT_RETRY_DELAY_MS = 2000;
const REPLAY_FETCH_TIMEOUT_MS = 15_000;

export type ArticleFetchReason =
  | "no-replay"
  | "404"
  | "rate-limit"
  | "timeout"
  | "cache-miss"
  | "no-content-state"
  | "exec-error";

export interface ArticleFetchResult {
  tweetId: string;
  ok: boolean;
  rawTweet: RawApiData | null;
  reason?: ArticleFetchReason;
}

export class ArticleFetcher {
  private wc: ElectronWebview;
  private webviewEl: ElectronWebview;
  private log: (msg: string) => void;
  private replayReady = false;

  constructor(
    wc: ElectronWebview,
    webviewEl: ElectronWebview,
    log: (msg: string) => void = () => {},
  ) {
    this.wc = wc;
    this.webviewEl = webviewEl;
    this.log = log;
  }

  /**
   * Ensure window.__TWITTER_BOOKMARK_SPIKE__.articleResultReplay exists by
   * triggering a TweetResultByRestId request via SPA nav to /i/article/<id>.
   * Idempotent — no-op when replay already recorded. Returns false on timeout.
   */
  async ensureReplayReady(seedTweetId: string): Promise<boolean> {
    if (this.replayReady) return true;

    const existing = await this.wc.executeJavaScript(`
      (function() {
        var r = window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.articleResultReplay;
        return r ? JSON.stringify({ recordedAt: r.recordedAt }) : null;
      })();
    `).catch(() => null);
    if (existing) {
      this.replayReady = true;
      return true;
    }

    this.log(`Article fetch: bootstrapping TweetResultByRestId replay via SPA nav to article/${seedTweetId}`);
    await this.wc.executeJavaScript(`
      (function() {
        try {
          history.pushState(null, '', '/i/article/' + ${JSON.stringify(seedTweetId)});
          window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (e) { /* ignore */ }
      })();
    `).catch(() => {});

    const deadline = Date.now() + BOOTSTRAP_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const ready = await this.wc.executeJavaScript(`
        !!(window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.articleResultReplay);
      `).catch(() => false);
      if (ready) {
        this.replayReady = true;
        return true;
      }
    }

    // Timeout — capture diagnostic on which ops fired during the window.
    const diag = await this.wc.executeJavaScript(`
      (function() {
        try {
          var s = window.__TWITTER_BOOKMARK_SPIKE__;
          if (!s) return "store=missing";
          var ops = (s.observedOperations || []).map(function(o){ return o.op + "(" + o.status + ")"; });
          return JSON.stringify({
            url: location.href,
            title: document.title,
            fetchCalls: s.fetchCalls || 0,
            xhrCalls: s.xhrCalls || 0,
            ops: ops.slice(-20),
          });
        } catch (e) { return "err:" + String(e); }
      })();
    `).catch(() => "diag failed");
    this.log(`Article fetch: bootstrap timed out — no TweetResultByRestId observed. diag=${diag}`);

    // Fallback: extract queryId from x.com's main JS bundle and synthesize the
    // TweetResultByRestId replay record without needing a natural request capture.
    this.log(`Article fetch: SPA-nav bootstrap timed out — trying queryId extraction fallback`);
    const extractResult = await this.wc.executeJavaScript(this.extractionScript()).catch((e: unknown) => ({
      ok: false, reason: "exec-error:" + String(e),
    }));
    const r = extractResult as { ok: boolean; reason?: string; source?: string; queryId?: string; queryIdSource?: string; bundleUrl?: string; headerSource?: string };
    if (r && r.ok) {
      this.log(`Article fetch: queryId=${r.queryId} (source=${r.queryIdSource || r.source}) headers=${r.headerSource || "?"} from ${r.bundleUrl || "n/a"}`);
      this.replayReady = true;
      return true;
    }
    this.log(`Article fetch: extraction failed: ${r?.reason || "unknown"}`);
    return false;
  }

  /**
   * Build the self-contained extraction script that:
   *  1. Fetches https://x.com/ to locate the main bundle URL.
   *  2. Fetches the bundle and regex-extracts TweetResultByRestId's queryId.
   *  3. Synthesizes an articleResultReplay record using headers copied from
   *     tweetDetailReplay (which must already exist in the probe store).
   *
   * Runs inside the webview via executeJavaScript so it can use the
   * webview's cookies and access window.__TWITTER_BOOKMARK_SPIKE__.
   */
  private extractionScript(): string {
    return `
      (async function() {
        try {
          var store = window.__TWITTER_BOOKMARK_SPIKE__;
          if (!store) return { ok: false, reason: "no-probe" };
          if (store.articleResultReplay) return { ok: true, source: "already-set" };

          // Source headers for the synthesized request. Prefer TweetDetail
          // (battle-tested for replay) but fall back to ANY captured authenticated
          // GraphQL request — Bookmarks fires reliably during every sync.
          var headerSource = store.tweetDetailReplay
                          || store.anyAuthGraphqlReplay
                          || null;
          if (!headerSource) return { ok: false, reason: "no-auth-headers-captured" };
          var headerSourceLabel = store.tweetDetailReplay ? "tweet-detail" : "any-auth-graphql";

          // Fetch x.com root for the main-bundle script tag.
          // credentials:"include" is fine since x.com is same-origin from inside the webview.
          var rootHtml = "";
          try {
            var rootResp = await fetch("https://x.com/", { credentials: "include" });
            if (!rootResp.ok) return { ok: false, reason: "root-fetch-status-" + rootResp.status };
            rootHtml = await rootResp.text();
          } catch (e) {
            return { ok: false, reason: "root-fetch-network: " + String(e) };
          }

          // Parse out the main bundle URL from <script src="..."> tags.
          // Format: https://abs.twimg.com/responsive-web/client-web/main.{hash}.js
          // (also "main.{hash}.{platform}.js" — be tolerant)
          var mainBundleMatch = rootHtml.match(/https:\\/\\/abs\\.twimg\\.com\\/responsive-web\\/client-web\\/main\\.[A-Za-z0-9]+(?:\\.[A-Za-z0-9-]+)?\\.js/);
          if (!mainBundleMatch) return { ok: false, reason: "no-main-bundle-found-in-root-html", rootHtmlSize: rootHtml.length };
          var mainBundleUrl = mainBundleMatch[0];

          // Fetch the bundle. abs.twimg.com is cross-origin so credentials:"omit"
          // and CORS — Twitter's CDN should serve permissively. If CORS blocks,
          // we fall through to the hardcoded-queryId fallback below.
          var bundleText = "";
          var bundleErr = null;
          try {
            var bundleResp = await fetch(mainBundleUrl, { credentials: "omit", mode: "cors" });
            if (!bundleResp.ok) {
              bundleErr = "bundle-fetch-status-" + bundleResp.status;
            } else {
              bundleText = await bundleResp.text();
            }
          } catch (e) {
            bundleErr = "bundle-fetch-network: " + String(e);
          }

          var queryId = null;
          var queryIdSource = null;

          if (bundleText) {
            // Regex-extract TweetResultByRestId queryId. Handle both orderings.
            var m = bundleText.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"TweetResultByRestId"/);
            if (!m) m = bundleText.match(/operationName:"TweetResultByRestId",queryId:"([A-Za-z0-9_-]+)"/);
            if (m) { queryId = m[1]; queryIdSource = "bundle"; }
          }

          if (!queryId) {
            // Hardcoded fallback. Updated periodically as Twitter rotates queryIds.
            // Sources: trevorhobenshield/twitter-api-client, annismckenzie/x-article-exporter.
            // Last verified: 2026-04-30 (rotates every 2-4 weeks; if backfill stops
            // working with reason 'queryId-stale' the user should re-export by
            // letting the natural-capture path observe a real TweetResultByRestId
            // request, OR we update this fallback list).
            var KNOWN_QUERY_IDS = [
              "D_jNhjWZeRZT5NURzfJZSQ",
              "d6YKjvQ920F-D4Y1PruO-A"
            ];
            queryId = KNOWN_QUERY_IDS[0];
            queryIdSource = "hardcoded-fallback";
          }

          if (!queryId) return { ok: false, reason: "queryId-not-found", bundleErr: bundleErr };

          // Synthesize the replay record. Use the original tweetDetailReplay
          // headers (already includes auth/transaction/etc) but build a brand-new
          // URL targeting TweetResultByRestId with the right shape.
          var url = "https://x.com/i/api/graphql/" + queryId + "/TweetResultByRestId" +
                    "?variables=" + encodeURIComponent(JSON.stringify({})) +
                    "&features=" + encodeURIComponent(JSON.stringify({})) +
                    "&fieldToggles=" + encodeURIComponent(JSON.stringify({}));

          store.articleResultReplay = {
            url: url,
            headers: headerSource.headers,
            recordedAt: Date.now(),
            _synthetic: true,
            _queryId: queryId,
            _queryIdSource: queryIdSource,
            _bundleUrl: mainBundleUrl,
            _headerSource: headerSourceLabel
          };

          return { ok: true, source: "extracted", queryId: queryId, queryIdSource: queryIdSource, bundleUrl: mainBundleUrl, headerSource: headerSourceLabel };
        } catch (e) {
          return { ok: false, reason: "exception:" + String(e) };
        }
      })();
    `;
  }

  /**
   * Fetch a single article body via replay. Returns ok:true when the cached
   * tweet has article.article_results.result.content_state populated.
   */
  async fetchOne(tweetId: string): Promise<ArticleFetchResult> {
    if (!this.replayReady) {
      return { tweetId, ok: false, rawTweet: null, reason: "no-replay" };
    }

    // 1. Issue replay fetch from inside the webview.
    const replayResult = await Promise.race([
      this.wc.executeJavaScript(this.replayScript(tweetId)),
      new Promise<{ ok: false; status: 0; error: string }>(resolve =>
        setTimeout(() => resolve({ ok: false, status: 0, error: "timeout" }), REPLAY_FETCH_TIMEOUT_MS),
      ),
    ]).catch(e => ({ ok: false, status: 0, error: String(e) }));

    const r = replayResult as { ok: boolean; status?: number; error?: string; body?: string; finalUrl?: string };
    if (!r || r.ok === false) {
      const errStr = r?.error || "";
      if (errStr === "timeout") return { tweetId, ok: false, rawTweet: null, reason: "timeout" };
      if (r?.status === 404) return { tweetId, ok: false, rawTweet: null, reason: "404" };
      if (r?.status === 429) return { tweetId, ok: false, rawTweet: null, reason: "rate-limit" };
      this.log(`fetchOne(${tweetId}): exec-error status=${r?.status} err=${errStr} body=${r?.body || "<empty>"}`);
      return { tweetId, ok: false, rawTweet: null, reason: "exec-error" };
    }

    // 2. Wait for walkAndCache to merge (~200ms is conservative).
    await new Promise(r => setTimeout(r, 200));

    // 3. Read tweetCache[tweetId] back.
    const cachedRaw = await this.wc.executeJavaScript(`
      (function() {
        try {
          var c = window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.tweetCache;
          if (!c) return null;
          var t = c[${JSON.stringify(tweetId)}];
          return t ? JSON.stringify(t) : null;
        } catch (e) { return null; }
      })();
    `).catch(() => null);

    if (!cachedRaw) {
      const respBody = (r as { body?: string }).body || "";
      const finalUrl = (r as { finalUrl?: string }).finalUrl || "";
      this.log(`fetchOne(${tweetId}): replay 200 but tweetCache miss — walkAndCache did not register this tweet. url=${finalUrl} body=${respBody.slice(0, 400)}`);
      return { tweetId, ok: false, rawTweet: null, reason: "cache-miss" };
    }

    let parsed: RawApiData;
    try {
      parsed = JSON.parse(cachedRaw);
    } catch {
      this.log(`fetchOne(${tweetId}): tweetCache value failed JSON.parse`);
      return { tweetId, ok: false, rawTweet: null, reason: "cache-miss" };
    }

    // 4. Validate that content_state is populated. The replay should have
    //    produced article.article_results.result.content_state on the tweet
    //    (or on a quoted_status_result, depending on the article shape).
    if (!hasContentStateAnywhere(parsed)) {
      // Dump diagnostic info on the response shape to diagnose why content_state
      // is missing — usually a missing feature flag or wrong fieldToggle name.
      const t = parsed as { article?: { article_results?: { result?: Record<string, unknown> } }; quoted_status_result?: { result?: { article?: { article_results?: { result?: Record<string, unknown> } } } } };
      const direct = t.article?.article_results?.result;
      const quoted = t.quoted_status_result?.result?.article?.article_results?.result;
      const ar = direct ?? quoted;
      const arKeys = ar ? Object.keys(ar).join(",") : "<no article_results>";
      const respBody = (r as { body?: string }).body || "";
      this.log(`fetchOne(${tweetId}): no-content-state. article_results.result keys: [${arKeys}]. body snippet: ${respBody.slice(0, 600)}`);
      return { tweetId, ok: false, rawTweet: parsed, reason: "no-content-state" };
    }

    return { tweetId, ok: true, rawTweet: parsed };
  }

  private replayScript(tweetId: string): string {
    return `
      (async function() {
        try {
          var store = window.__TWITTER_BOOKMARK_SPIKE__;
          var replay = store && store.articleResultReplay;
          if (!replay) return { ok: false, error: "no replay URL recorded" };
          // replay.url is always an absolute https:// URL — use new URL(str) directly
          // so this works on about:blank (location.origin === "null") as well as
          // on real x.com pages.
          var url = new URL(replay.url);

          var vars = {};
          try { vars = JSON.parse(url.searchParams.get("variables") || "{}"); } catch(e) {}
          // TweetResultByRestId requires these variables to be defined or
          // x.com returns GRAPHQL_VALIDATION_FAILED. Set defaults but let the
          // captured-replay values win if the source URL already specified them.
          var defaults = {
            tweetId: ${JSON.stringify(tweetId)},
            withCommunity: false,
            includePromotedContent: false,
            withVoice: false
          };
          for (var dk in defaults) {
            if (!(dk in vars)) vars[dk] = defaults[dk];
          }
          // Always overwrite tweetId — the captured URL has the wrong tweet.
          vars.tweetId = ${JSON.stringify(tweetId)};
          // Some queries name it differently; cover both.
          if ("rest_id" in vars) vars.rest_id = ${JSON.stringify(tweetId)};
          if ("focalTweetId" in vars) vars.focalTweetId = ${JSON.stringify(tweetId)};
          url.searchParams.set("variables", JSON.stringify(vars));

          var toggles = {};
          try { toggles = JSON.parse(url.searchParams.get("fieldToggles") || "{}"); } catch(e) {}
          toggles.withArticleRichContentState = true;
          toggles.withArticlePlainText = false;
          toggles.withGrokAnalyze = false;
          toggles.withDisallowedReplyControls = false;
          url.searchParams.set("fieldToggles", JSON.stringify(toggles));

          // Features required for the article subtree to be present in the
          // response. Without these, x.com returns the bare Tweet without the
          // .article field even when the tweet IS an article. This list grows
          // as Twitter adds new feature gates — when 'no-content-state' starts
          // happening on real articles, add the missing flag here.
          var features = {};
          try { features = JSON.parse(url.searchParams.get("features") || "{}"); } catch(e) {}
          var articleFeatures = {
            responsive_web_twitter_article_data_v2_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            longform_notetweets_consumption_enabled: true,
            creator_subscriptions_tweet_preview_api_enabled: true,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            tweetypie_unmention_optimization_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            rweb_video_timestamps_enabled: true,
            longform_notetweets_consumption_enabled_2: true,
            responsive_web_enhance_cards_enabled: false,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true
          };
          for (var fk in articleFeatures) {
            if (!(fk in features)) features[fk] = articleFeatures[fk];
          }
          url.searchParams.set("features", JSON.stringify(features));

          var headers = {};
          var src = replay.headers || {};
          for (var k in src) {
            var lk = k.toLowerCase();
            if (lk === "content-length" || lk === "cookie" || lk === "host") continue;
            headers[k] = src[k];
          }

          var resp = await fetch(url.toString(), {
            method: "GET",
            credentials: "include",
            headers: headers,
          });
          var bodyText = "";
          // Capture body on both success and failure for diagnostic purposes.
          // The probe's fetch interceptor consumes its own clone; reading here
          // doesn't conflict.
          try { bodyText = (await resp.text()).slice(0, 800); } catch (e) { bodyText = "<read failed>"; }
          return { ok: resp.ok, status: resp.status, body: bodyText, finalUrl: url.toString() };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      })();
    `;
  }

  /**
   * Sequential batch fetch. Bootstraps replay using the first tweet ID.
   * Spaces calls 2s apart. On 429: 10s backoff + one retry. On timeout: 2s
   * delay + one retry. Other failures pass through to the result list.
   */
  async fetchMany(
    tweetIds: string[],
    onProgress?: (done: number, total: number, last?: ArticleFetchResult) => void,
  ): Promise<ArticleFetchResult[]> {
    const results: ArticleFetchResult[] = [];
    if (tweetIds.length === 0) return results;

    const bootstrapped = await this.ensureReplayReady(tweetIds[0]);
    if (!bootstrapped) {
      // All articles fail with no-replay. We still emit progress so callers
      // can show "all failed" state instead of hanging.
      for (let i = 0; i < tweetIds.length; i++) {
        const r: ArticleFetchResult = { tweetId: tweetIds[i], ok: false, rawTweet: null, reason: "no-replay" };
        results.push(r);
        onProgress?.(i + 1, tweetIds.length, r);
      }
      return results;
    }

    for (let i = 0; i < tweetIds.length; i++) {
      let r = await this.fetchOne(tweetIds[i]);
      if (!r.ok && r.reason === "rate-limit") {
        this.log(`fetchMany: 429 on ${tweetIds[i]} — backing off ${RATE_LIMIT_BACKOFF_MS}ms`);
        await new Promise(s => setTimeout(s, RATE_LIMIT_BACKOFF_MS));
        r = await this.fetchOne(tweetIds[i]);
      } else if (!r.ok && r.reason === "timeout") {
        this.log(`fetchMany: timeout on ${tweetIds[i]} — retry after ${TIMEOUT_RETRY_DELAY_MS}ms`);
        await new Promise(s => setTimeout(s, TIMEOUT_RETRY_DELAY_MS));
        r = await this.fetchOne(tweetIds[i]);
      }
      results.push(r);
      onProgress?.(i + 1, tweetIds.length, r);

      if (i < tweetIds.length - 1) {
        await new Promise(s => setTimeout(s, PER_REQUEST_DELAY_MS));
      }
    }

    return results;
  }
}
