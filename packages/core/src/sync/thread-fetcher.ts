/**
 * Tweet-thread fetcher.
 *
 * Replays a previously-observed TweetDetail GraphQL request from the probe's
 * cache, swapping in a different focalTweetId. The probe auto-harvests the
 * response into window.__TWITTER_BOOKMARK_SPIKE__.tweetCache, from which we
 * reconstruct the self-thread (same-author reply chain).
 */
import type { ElectronWebview, StopSignal } from "@/types/sync";
import type { RawApiData } from "@/lib/normalize";
import { getConversationId, getTweetAuthorId, isSelfThreadTail } from "@/lib/extract";
import { roostUnwrapTweet } from "@/lib/normalize";

const BOOTSTRAP_WAIT_MS = 8000;
const RL_INITIAL_COOLDOWN_MS = 30_000;
const RL_MAX_COOLDOWN_MS = 300_000;
const RL_ABORT_THRESHOLD_MS = 600_000;

export interface ThreadSegment {
  rest_id: string;
  raw: RawApiData;
}

export class ThreadFetcher {
  private wc: ElectronWebview;
  private webviewEl: ElectronWebview;
  private log: (msg: string) => void;
  private replayReady = false;
  private rateLimitUntil = 0;
  private consecutiveRateLimits = 0;
  private aborted = false;

  constructor(wc: ElectronWebview, webviewEl: ElectronWebview, log: (msg: string) => void = () => {}) {
    this.wc = wc;
    this.webviewEl = webviewEl;
    this.log = log;
  }

  /** True when repeated 429s exceed tolerance — caller should stop the enrich loop. */
  shouldAbort(): boolean { return this.aborted; }

  /**
   * Trigger a TweetDetail request so the probe records its URL + headers.
   * Uses SPA-style in-app navigation (history.pushState + popstate) because
   * hard navigation to /i/status/<id> hits Twitter's SSR path and never fires
   * a TweetDetail graphql request — the conversation is inlined in the
   * initial HTML. SPA nav goes through React Router, which triggers the
   * graphql fetch. Assumes caller has the probe injected and the webview on
   * a hydrated x.com page (e.g. /i/bookmarks after scroll).
   * No-op if already recorded.
   */
  async ensureReplayReady(seedTweetId: string): Promise<boolean> {
    if (this.replayReady) return true;

    const existing = await this.wc.executeJavaScript(`
      (function() {
        var r = window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay;
        return r ? JSON.stringify({ recordedAt: r.recordedAt }) : null;
      })();
    `).catch(() => null);
    if (existing) {
      this.replayReady = true;
      return true;
    }

    this.log(`Thread enrich: bootstrapping TweetDetail replay via SPA nav to status/${seedTweetId}`);
    await this.wc.executeJavaScript(`
      (function() {
        try {
          history.pushState(null, '', '/i/status/${seedTweetId}');
          window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (e) { /* ignore */ }
      })();
    `).catch(() => {});

    const deadline = Date.now() + BOOTSTRAP_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const ready = await this.wc.executeJavaScript(`
        !!(window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay);
      `).catch(() => false);
      if (ready) {
        this.replayReady = true;
        return true;
      }
    }
    // Timeout diagnostic: surface what ops x.com actually fired during the
    // bootstrap window, so we can tell whether TweetDetail is still the right
    // op name (or whether the page is serving a logged-out SSR shell with no
    // graphql at all, etc.).
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
    this.log(`Thread enrich: bootstrap timed out — no TweetDetail observed. diag=${diag}`);
    return false;
  }

  /**
   * Fetch a thread via TweetDetail replay. Returns the self-thread tweets
   * (focal + same-author ancestors/descendants), sorted chronologically.
   * Returns null on any failure.
   */
  async fetchThread(focalTweetId: string, authorId: string, conversationId: string, stopSignal?: StopSignal): Promise<ThreadSegment[] | null> {
    if (stopSignal?.stopped || this.aborted) return null;

    if (this.rateLimitUntil > Date.now()) {
      const waitMs = this.rateLimitUntil - Date.now();
      this.log(`Thread enrich: cooling down ${Math.round(waitMs / 1000)}s before next request`);
      await new Promise(r => setTimeout(r, waitMs));
      if (stopSignal?.stopped || this.aborted) return null;
    }

    const result = await this.wc.executeJavaScript(this.replayScript(focalTweetId)).catch(err => {
      return { ok: false, error: String(err) };
    });

    if (result?.status === 429) {
      this.consecutiveRateLimits++;
      const cooldown = Math.min(RL_INITIAL_COOLDOWN_MS * Math.pow(2, this.consecutiveRateLimits - 1), RL_MAX_COOLDOWN_MS);
      this.rateLimitUntil = Date.now() + cooldown;
      this.log(`Thread enrich: rate-limited on ${focalTweetId} (streak=${this.consecutiveRateLimits}) — pausing ${Math.round(cooldown / 1000)}s`);
      if (cooldown >= RL_ABORT_THRESHOLD_MS || this.consecutiveRateLimits >= 5) {
        this.aborted = true;
        this.log(`Thread enrich: aborting — sustained rate limiting (${this.consecutiveRateLimits} consecutive 429s)`);
      }
      return null;
    }

    if (!result || !result.ok) {
      this.log(`Thread enrich: ${focalTweetId} failed — ${result?.error || "unknown"}`);
      return null;
    }

    this.consecutiveRateLimits = 0;

    await new Promise(r => setTimeout(r, 200));
    const segments = await this.extractThread(authorId, conversationId, focalTweetId);
    if (segments && segments.length > 0) return segments;

    const diag = await this.cacheDiag(focalTweetId, authorId, conversationId).catch(() => "diag failed");
    this.log(`Thread enrich: ${focalTweetId} failed — no tweets in cache matched thread | ${diag}`);
    return null;
  }

  private async cacheDiag(focalTweetId: string, authorId: string, conversationId: string): Promise<string> {
    return await this.wc.executeJavaScript(`
      (function() {
        try {
          var cache = window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.tweetCache || {};
          var total = 0, matchConv = 0, matchAuthor = 0, focalInCache = false;
          var sampleConvs = {};
          for (var id in cache) {
            total++;
            var t = cache[id];
            if (!t || !t.legacy) continue;
            if (id === ${JSON.stringify(focalTweetId)}) focalInCache = true;
            var c = t.legacy.conversation_id_str;
            if (c) sampleConvs[c] = (sampleConvs[c] || 0) + 1;
            if (c === ${JSON.stringify(conversationId)}) matchConv++;
            var a = (t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.rest_id) || t.legacy.user_id_str;
            if (c === ${JSON.stringify(conversationId)} && a === ${JSON.stringify(authorId)}) matchAuthor++;
          }
          var topConvs = Object.keys(sampleConvs).sort(function(a,b){return sampleConvs[b]-sampleConvs[a];}).slice(0,3).map(function(k){return k+":"+sampleConvs[k];});
          return "cache=" + total + " focal=" + (focalInCache?"Y":"N") + " matchConv=" + matchConv + " matchAuthor=" + matchAuthor + " topConvs=[" + topConvs.join(",") + "]";
        } catch (e) { return "err:" + String(e); }
      })();
    `).catch(() => "diag err");
  }

  private replayScript(focalTweetId: string): string {
    return `
      (async function() {
        try {
          var store = window.__TWITTER_BOOKMARK_SPIKE__;
          var replay = store && store.tweetDetailReplay;
          if (!replay) return { ok: false, error: "no replay URL recorded" };
          var url = new URL(replay.url, location.origin);
          var vars = {};
          try { vars = JSON.parse(url.searchParams.get("variables") || "{}"); } catch(e) {}
          vars.focalTweetId = ${JSON.stringify(focalTweetId)};
          url.searchParams.set("variables", JSON.stringify(vars));
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
          return { ok: resp.ok, status: resp.status };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      })();
    `;
  }

  private async extractThread(authorId: string, conversationId: string, focalTweetId: string): Promise<ThreadSegment[] | null> {
    // Filter rules:
    //   1. Same conversation_id (same X "thread root")
    //   2. Same author (drops other people's replies)
    //   3. Either the focal itself, OR replying to the author themselves.
    //      Catches the bug where extractThread bundled in same-author
    //      replies-to-other-users (e.g. an author posting "@somebody Thanks!"
    //      under their own OP) as if they were thread segments.
    const raw = await this.wc.executeJavaScript(`
      (function() {
        try {
          var cache = window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.tweetCache || {};
          var out = [];
          for (var id in cache) {
            var t = cache[id];
            if (!t || !t.legacy) continue;
            if (t.legacy.conversation_id_str !== ${JSON.stringify(conversationId)}) continue;
            var tAuthor = (t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.rest_id) || t.legacy.user_id_str;
            if (tAuthor !== ${JSON.stringify(authorId)}) continue;
            if (id !== ${JSON.stringify(focalTweetId)}) {
              var replyUser = t.legacy.in_reply_to_user_id_str;
              if (replyUser && replyUser !== ${JSON.stringify(authorId)}) continue;
            }
            out.push(t);
          }
          return JSON.stringify(out);
        } catch (e) { return "[]"; }
      })();
    `).catch(() => "[]");

    let tweets: RawApiData[];
    try { tweets = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(tweets) || tweets.length === 0) return null;

    tweets.sort((a, b) => {
      const at = a?.legacy?.created_at ? Date.parse(a.legacy.created_at) : 0;
      const bt = b?.legacy?.created_at ? Date.parse(b.legacy.created_at) : 0;
      return at - bt;
    });
    return tweets.map(t => ({ rest_id: t.rest_id, raw: t }));
  }
}

/**
 * Decide whether a tweet is a thread worth enriching.
 * Returns the anchor info needed to call fetchThread, or null.
 */
export function threadAnchor(raw: RawApiData | null | undefined): { focalTweetId: string; authorId: string; conversationId: string } | null {
  const tweet = roostUnwrapTweet(raw) || raw;
  if (!tweet?.rest_id) return null;
  if (!isSelfThreadTail(tweet)) return null;
  const authorId = getTweetAuthorId(tweet);
  const conversationId = getConversationId(tweet);
  if (!authorId || !conversationId) return null;
  return { focalTweetId: tweet.rest_id, authorId, conversationId };
}
