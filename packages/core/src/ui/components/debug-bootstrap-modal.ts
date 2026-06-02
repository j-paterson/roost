/**
 * Debug modal for iterating on ThreadFetcher.ensureReplayReady without a full
 * twitter sync. Drives the existing authenticated twitter webview, reinjects
 * the probe on every dom-ready, then auto-sequences through navigation
 * strategies — stopping at the first one that records a tweetDetailReplay or
 * at least surfaces a conversation-shaped graphql op.
 */
import { App, Modal } from "obsidian";
import type { ElectronWebview } from "@/types/sync";
import type { WebviewManager } from "@/sync/webview-manager";

const POLL_MS = 1500;
const PER_STRATEGY_WAIT_MS = 15000;
const BOOKMARKS_HYDRATE_MS = 20000;

// Ops we've already observed on hard-nav and which are NOT the conversation
// fetch we're looking for. If a strategy surfaces anything beyond these, it's
// a signal worth flagging.
const PERIPHERAL_OPS = new Set([
  "getAltTextPromptPreference",
  "ExploreSidebar",
  "UsersByRestIds",
  "Bookmarks",
  "BookmarkFolderTimeline",
  "Viewer",
  "useFetchProfileSections_canViewExpandedProfileQuery",
  "ArticleTombstonesByRestIds",
]);

// Positive signal — if any observed op matches these names (or substrings),
// we've found the conversation fetch under whatever modern name X uses.
const CONVERSATION_OP_HINTS = [
  "TweetDetail",
  "ThreadedConversation",
  "TweetResultByRestId",
  "ConversationTimeline",
];

interface Opts {
  app: App;
  getWebviewManager: () => WebviewManager;
  probeSource: string;
  initialTweetId?: string;
}

interface Strategy {
  name: string;
  run: (wc: ElectronWebview, webviewEl: ElectronWebview, tweetId: string) => Promise<void>;
  requiresBookmarksHydration: boolean;
}

interface PollResult {
  replayRecorded: boolean;
  conversationOps: string[];
  allOps: string[];
}

interface CacheSnapshot {
  size: number;
  focalPresent: boolean;
  convMatches: number;
  authorMatches: number;
}

interface EnrichDiag {
  ok: boolean;
  phase?: string;
  error?: string;
  status: number;
  elapsedMs: number;
  bodyLen: number;
  hasErrors: boolean;
  errors: unknown[] | null;
  hasInstructions: boolean;
  tweetsInResponse: number;
  tweetsByDepth: Record<string, number>;
  tweetsAboveDepthCap: number;
  tweetsAtOrBelowDepthCap: number;
  focalInResponse: boolean;
  focalDepth: number;
  sameConvCount: number;
  sameConvMinDepth: number;
  sameAuthorCount: number;
  sameAuthorMinDepth: number;
  putSim: { new: number; replaceMissingUser: number; mergeMissingText: number; rejectedNoImprovement: number; rejectedNoRestId: number };
  cacheBefore: CacheSnapshot;
  cacheAfter: CacheSnapshot;
  observedOpsDuringReplay: string[];
  replayAgeMs: number;
}

export class DebugBootstrapModal extends Modal {
  private opts: Opts;
  private input!: HTMLInputElement;
  private runBtn!: HTMLButtonElement;
  private logEl!: HTMLElement;
  private domReadyHandler: (() => void) | null = null;
  private webviewEl: ElectronWebview | null = null;

  constructor(opts: Opts) {
    super(opts.app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Debug: probe thread bootstrap" });
    contentEl.createEl("p", {
      text: "Runs A–D (nav strategies) then E (enrich pipeline diagnostic). A–D compare which graphql ops each nav surfaces; summary prints a comparative table. E fires one replay TweetDetail and traces it through every phase (response body → walker depth → putTweet → cache) to pinpoint why thread enrichment isn't populating cache.",
      cls: "setting-item-description",
    });

    const form = contentEl.createDiv();
    form.style.cssText = "display: flex; gap: 8px; margin: 12px 0; align-items: center;";

    this.input = form.createEl("input", { type: "text" });
    this.input.placeholder = "Tweet ID";
    this.input.value = this.opts.initialTweetId || "";
    this.input.style.cssText = "flex: 1; padding: 6px;";

    this.runBtn = form.createEl("button", { text: "Run all", cls: "mod-cta" });
    this.runBtn.addEventListener("click", () => this.run());

    const copyBtn = form.createEl("button", { text: "Copy log" });
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(this.logEl.innerText);
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    });

    this.logEl = contentEl.createEl("pre");
    this.logEl.style.cssText = "max-height: 500px; overflow: auto; background: var(--background-secondary); padding: 8px; font-size: 11px; line-height: 1.4; user-select: text; -webkit-user-select: text; cursor: text;";
  }

  onClose() {
    this.cleanup();
    this.contentEl.empty();
  }

  private log(msg: string) {
    const ts = new Date().toISOString().slice(11, 23);
    this.logEl.appendText(`${ts}  ${msg}\n`);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private cleanup() {
    if (this.webviewEl && this.domReadyHandler) {
      this.webviewEl.removeEventListener("dom-ready", this.domReadyHandler);
    }
    this.domReadyHandler = null;
    this.webviewEl = null;
  }

  private strategies(): Strategy[] {
    return [
      {
        name: "A. SPA pushState+popstate (from bookmarks)",
        requiresBookmarksHydration: true,
        run: async (wc, _webviewEl, tweetId) => {
          await wc.executeJavaScript(`
            (function() {
              try {
                history.pushState(null, '', '/i/status/${tweetId}');
                window.dispatchEvent(new PopStateEvent('popstate'));
              } catch (e) { /* ignore */ }
            })();
          `).catch(() => {});
        },
      },
      {
        name: "B. DOM link click (override href on existing <a>)",
        requiresBookmarksHydration: true,
        run: async (wc, _webviewEl, tweetId) => {
          await wc.executeJavaScript(`
            (function() {
              try {
                var link = document.querySelector('a[role="link"][href*="/status/"]');
                if (!link) return "no-link";
                // Clone so we don't mutate React's tree, but keep the same
                // handlers by walking up: just set href and click.
                var origHref = link.getAttribute('href');
                link.setAttribute('href', '/i/status/${tweetId}');
                link.click();
                link.setAttribute('href', origHref);
                return "clicked";
              } catch (e) { return "err:" + String(e); }
            })();
          `).catch(() => {});
        },
      },
      {
        name: "C. SPA History API — replaceState (forces router re-eval)",
        requiresBookmarksHydration: true,
        run: async (wc, _webviewEl, tweetId) => {
          await wc.executeJavaScript(`
            (function() {
              try {
                // Some routers only re-evaluate on pushState with a fresh
                // state object. Try replaceState to same path, then
                // pushState to target.
                history.replaceState({}, '', location.pathname);
                history.pushState({}, '', '/i/status/${tweetId}');
                window.dispatchEvent(new PopStateEvent('popstate'));
                window.dispatchEvent(new HashChangeEvent('hashchange'));
              } catch (e) { /* ignore */ }
            })();
          `).catch(() => {});
        },
      },
      {
        name: "D. Hard nav (baseline — known to fail)",
        requiresBookmarksHydration: false,
        run: async (_wc, webviewEl, tweetId) => {
          webviewEl.loadURL(`https://x.com/i/status/${tweetId}`);
        },
      },
    ];
  }

  private async run() {
    const tweetId = this.input.value.trim();
    if (!/^\d+$/.test(tweetId)) {
      this.log("ERR: tweet id must be numeric");
      return;
    }
    this.runBtn.disabled = true;
    this.logEl.empty();
    this.log(`Starting auto-sequenced probe for ${tweetId}`);

    const wm = this.opts.getWebviewManager();
    const webviewEl = wm.getElement("twitter");
    const wc = wm.getWebContents("twitter");
    if (!webviewEl || !wc) {
      this.log("ERR: twitter webview not ready (open sync once to initialize it, then retry)");
      this.runBtn.disabled = false;
      return;
    }
    this.webviewEl = webviewEl;

    this.domReadyHandler = async () => {
      await wc.executeJavaScript(`
        try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}
        try { ${this.opts.probeSource}; } catch(e) {}
        void 0;
      `).catch(() => {});
    };
    webviewEl.addEventListener("dom-ready", this.domReadyHandler);

    const results: { name: string; replayRecorded: boolean; conversationOps: string[]; allOps: string[] }[] = [];

    try {
      // Land on bookmarks once for any SPA-based strategy. Strategies that
      // don't need it (hard nav) will leave this state and come back.
      this.log("─── setup: loadURL → /i/bookmarks ───");
      webviewEl.loadURL("https://x.com/i/bookmarks");
      const hydrated = await this.waitForHydration(wc, BOOKMARKS_HYDRATE_MS);
      this.log(hydrated ? "bookmarks hydrated" : "bookmarks did NOT hydrate (tweet articles missing)");

      for (const strat of this.strategies()) {
        this.log("");
        this.log(`─── strategy ${strat.name} ───`);

        // If we've left bookmarks after a previous strategy (e.g. D did a
        // hard nav), go back for strategies that need SPA state.
        if (strat.requiresBookmarksHydration) {
          const onBookmarks = await wc.executeJavaScript(
            `location.pathname.indexOf("/i/bookmarks") === 0`
          ).catch(() => false);
          if (!onBookmarks) {
            this.log("re-navigating to /i/bookmarks for SPA setup");
            webviewEl.loadURL("https://x.com/i/bookmarks");
            const h2 = await this.waitForHydration(wc, BOOKMARKS_HYDRATE_MS);
            if (!h2) {
              this.log("re-hydrate failed — trying strategy anyway");
            }
          }
        }

        // Clear probe counters so the per-strategy poll only shows its own traffic.
        await wc.executeJavaScript(`
          (function() {
            var s = window.__TWITTER_BOOKMARK_SPIKE__;
            if (s) { s.observedOperations = []; s.recentFetchUrls = []; s.fetchCalls = 0; s.xhrCalls = 0; }
            void 0;
          })();
        `).catch(() => {});

        await strat.run(wc, webviewEl, tweetId);
        const result = await this.pollForWindow(wc, PER_STRATEGY_WAIT_MS);
        results.push({ name: strat.name, ...result });

        if (result.replayRecorded) {
          this.log(`✓ ${strat.name} — tweetDetailReplay recorded`);
        } else if (result.conversationOps.length > 0) {
          this.log(`⚠ ${strat.name} surfaced conversation-shaped op: ${result.conversationOps.join(", ")} (but replay not recorded — probe's TWEET_DETAIL_RE may need updating)`);
        } else {
          this.log(`✗ ${strat.name} no conversation op observed. all ops: [${result.allOps.join(", ")}]`);
        }
      }

      this.log("");
      this.log("═══ comparative summary ═══");
      const uniqueOps = new Set<string>();
      for (const r of results) {
        const replay = r.replayRecorded ? "Y" : "N";
        const convOps = r.conversationOps.length ? r.conversationOps.join(",") : "-";
        const nonPeripheral = r.allOps.filter(o => {
          const name = o.split("(")[0];
          return name && !PERIPHERAL_OPS.has(name);
        });
        for (const o of nonPeripheral) uniqueOps.add(o.split("(")[0]);
        this.log(`${r.name}`);
        this.log(`    replay=${replay}  conversationOps=[${convOps}]  nonPeripheralOps=[${nonPeripheral.join(", ") || "-"}]`);
      }
      this.log("");
      const winners = results.filter(r => r.replayRecorded).map(r => r.name);
      const renameCandidates = Array.from(new Set(results.flatMap(r => r.conversationOps)));
      const allCandidateOps = Array.from(uniqueOps).filter(op =>
        !CONVERSATION_OP_HINTS.some(h => op.toLowerCase().includes(h.toLowerCase()))
      );
      if (winners.length > 0) {
        this.log(`→ working strategies: ${winners.join(" | ")}`);
      }
      if (renameCandidates.length > 0) {
        this.log(`→ conversation-shaped op candidates (check if rate-limits differ): ${renameCandidates.join(", ")}`);
      }
      if (allCandidateOps.length > 0) {
        this.log(`→ other non-peripheral ops seen across strategies (potential alternates): ${allCandidateOps.join(", ")}`);
      }
      if (winners.length === 0 && renameCandidates.length === 0) {
        this.log("→ no strategy surfaced a conversation fetch. Next steps: dump __INITIAL_STATE__, inspect SSR payload, or try scrolling/hovering to trigger lazy-loaded fetches.");
      }

      this.log("");
      this.log("─── strategy E. Enrich pipeline diagnostic ───");
      await this.runEnrichDiagnostic(wc, webviewEl, tweetId);
    } catch (e) {
      this.log(`ERR: ${String(e)}`);
    }

    this.cleanup();
    this.runBtn.disabled = false;
  }

  private async runEnrichDiagnostic(wc: ElectronWebview, webviewEl: ElectronWebview, tweetId: string) {
    // A hard-nav in strategy D reset the probe store (dom-ready re-injects fresh).
    // Ensure we're back on bookmarks with probe + recorded replay before diagnosing.
    const onBookmarks = await wc.executeJavaScript(
      `location.pathname.indexOf("/i/bookmarks") === 0`
    ).catch(() => false);
    if (!onBookmarks) {
      this.log("re-navigating to /i/bookmarks for probe + replay setup");
      webviewEl.loadURL("https://x.com/i/bookmarks");
      const h = await this.waitForHydration(wc, BOOKMARKS_HYDRATE_MS);
      if (!h) {
        this.log("ERR: bookmarks failed to hydrate — cannot diagnose");
        return;
      }
    }

    // Force a replay recording via SPA nav (strategy A). Harmless if already recorded.
    await wc.executeJavaScript(`
      (function() {
        try {
          history.pushState(null, '', '/i/status/${tweetId}');
          window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (e) { /* ignore */ }
      })();
    `).catch(() => {});

    // Wait for tweetDetailReplay to exist in the probe store.
    const replayReady = await this.waitForReplay(wc, 15000);
    if (!replayReady) {
      this.log("ERR: no tweetDetailReplay recorded after SPA nav — cannot diagnose (probe or XHR capture broken)");
      return;
    }
    this.log("replay URL recorded — firing diagnostic fetch");

    const scriptResult = await wc.executeJavaScript(this.enrichDiagScript(tweetId))
      .catch((e: Error) => JSON.stringify({ ok: false, phase: "executeJavaScript", error: String(e) }));

    let r: EnrichDiag;
    try { r = JSON.parse(scriptResult); } catch { this.log(`ERR: parse diag: ${String(scriptResult).slice(0, 300)}`); return; }
    if (!r.ok) { this.log(`ERR: diag phase=${r.phase || "?"}: ${r.error}`); return; }

    this.log(`HTTP ${r.status}  ${r.bodyLen}b  ${r.elapsedMs}ms  replayAge=${r.replayAgeMs}ms`);
    this.log(`hasErrors=${r.hasErrors ? "Y" : "N"}${r.errors ? " errors=" + JSON.stringify(r.errors).slice(0, 200) : ""}`);
    this.log(`hasInstructions=${r.hasInstructions ? "Y" : "N"}`);
    this.log(`tweetsInResponse=${r.tweetsInResponse}  byDepth=${JSON.stringify(r.tweetsByDepth)}`);
    this.log(`tweetsAboveDepthCap(>8)=${r.tweetsAboveDepthCap}  tweetsAtOrBelowCap=${r.tweetsAtOrBelowDepthCap}`);
    this.log(`focalInResponse=${r.focalInResponse ? "Y" : "N"}  focalDepth=${r.focalDepth}`);
    this.log(`sameConv: count=${r.sameConvCount} minDepth=${r.sameConvMinDepth}`);
    this.log(`sameAuthor: count=${r.sameAuthorCount} minDepth=${r.sameAuthorMinDepth}`);
    this.log(`putTweetSim: ${JSON.stringify(r.putSim)}`);
    this.log(`observedOpsDuringReplay=[${r.observedOpsDuringReplay.join(", ") || "-"}]`);
    this.log(`cacheBefore=${JSON.stringify(r.cacheBefore)}`);
    this.log(`cacheAfter =${JSON.stringify(r.cacheAfter)}`);

    // Heuristic verdict — compares the causal chain to narrow the root cause.
    const deltaFocal = r.cacheAfter.focalPresent && !r.cacheBefore.focalPresent;
    const deltaConv = r.cacheAfter.convMatches - r.cacheBefore.convMatches;
    const deltaAuthor = r.cacheAfter.authorMatches - r.cacheBefore.authorMatches;
    const verdicts: string[] = [];
    if (r.hasErrors) verdicts.push("Response has errors envelope — replay rejected by X (stale headers? bad variables? auth?)");
    if (!r.hasInstructions && !r.hasErrors) verdicts.push("Response lacks threaded_conversation_with_injections_v2.instructions — op may have been renamed server-side");
    if (r.hasInstructions && !r.focalInResponse) verdicts.push("Focal tweet NOT in response — replay URL's variables may be swapped wrong or focal is gated");
    if (r.focalInResponse && r.focalDepth > 8) verdicts.push(`Focal at depth ${r.focalDepth} exceeds walker cap (8) — walkAndCache drops it. Raise depth cap or special-case TweetDetail.`);
    if (r.tweetsAboveDepthCap > r.tweetsAtOrBelowDepthCap && r.tweetsAboveDepthCap > 2) verdicts.push(`Most thread tweets (${r.tweetsAboveDepthCap} of ${r.tweetsInResponse}) live below depth 8 — walker misses them.`);
    if (r.observedOpsDuringReplay.length === 0) verdicts.push("Probe's fetch wrapper did NOT observe our replay fetch — we're bypassing the interceptor (possible if nativeFetch stored at load time differs from current window.fetch).");
    if (r.focalInResponse && r.focalDepth <= 8 && !deltaFocal) verdicts.push("Focal reachable by walker but NOT added to cache — putTweet's update-only gate rejects replay version when focal already present with partial fields.");
    if (deltaFocal && deltaAuthor === 0) verdicts.push("Focal cached but no author-matched siblings added — thread siblings failing conv/author gate (likely different authorId field).");
    if (r.putSim.new + r.putSim.replaceMissingUser + r.putSim.mergeMissingText === 0 && r.tweetsInResponse > 0) verdicts.push("Simulated putTweet rejected ALL tweets as 'no improvement' — response tweets are strictly less rich than what's already cached.");

    this.log("");
    this.log("VERDICT:");
    if (verdicts.length === 0) {
      this.log(`  no anomaly — cache gained focal=${deltaFocal ? "Y" : "N"} conv+${deltaConv} author+${deltaAuthor}. Enrich should work.`);
    } else {
      for (const v of verdicts) this.log(`  • ${v}`);
    }
  }

  private async waitForReplay(wc: ElectronWebview, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const ready = await wc.executeJavaScript(
        `!!(window.__TWITTER_BOOKMARK_SPIKE__ && window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay)`
      ).catch(() => false);
      if (ready) return true;
    }
    return false;
  }

  private enrichDiagScript(focalTweetId: string): string {
    const FOCAL = JSON.stringify(focalTweetId);
    return `
      (async function() {
        try {
          var store = window.__TWITTER_BOOKMARK_SPIKE__;
          var replay = store && store.tweetDetailReplay;
          if (!replay) return JSON.stringify({ ok: false, phase: "precheck", error: "no replay URL recorded" });

          // Derive CONV + AUTHOR from focal tweet in cache, if present. Otherwise
          // we discover them from the response itself after the fetch.
          var CONV = null, AUTHOR = null;
          var preFocal = store.tweetCache[${FOCAL}];
          if (preFocal) {
            CONV = preFocal.legacy && preFocal.legacy.conversation_id_str || null;
            AUTHOR = (preFocal.core && preFocal.core.user_results && preFocal.core.user_results.result && preFocal.core.user_results.result.rest_id) || (preFocal.legacy && preFocal.legacy.user_id_str) || null;
          }

          function countCache(conv, author) {
            var out = { size: 0, focalPresent: false, convMatches: 0, authorMatches: 0 };
            for (var id in store.tweetCache) {
              out.size++;
              var t = store.tweetCache[id];
              if (id === ${FOCAL}) out.focalPresent = true;
              if (!t || !t.legacy) continue;
              var c = t.legacy.conversation_id_str;
              if (conv && c === conv) out.convMatches++;
              var a = (t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.rest_id) || t.legacy.user_id_str;
              if (conv && author && c === conv && a === author) out.authorMatches++;
            }
            return out;
          }
          var before = countCache(CONV, AUTHOR);

          var url = new URL(replay.url, location.origin);
          var vars = {};
          try { vars = JSON.parse(url.searchParams.get("variables") || "{}"); } catch(e) {}
          vars.focalTweetId = ${FOCAL};
          url.searchParams.set("variables", JSON.stringify(vars));
          var headers = {};
          var src = replay.headers || {};
          for (var k in src) {
            var lk = k.toLowerCase();
            if (lk === "content-length" || lk === "cookie" || lk === "host") continue;
            headers[k] = src[k];
          }
          var t0 = Date.now();
          var resp = await fetch(url.toString(), { method: "GET", credentials: "include", headers: headers });
          var bodyText = await resp.text();
          var elapsedMs = Date.now() - t0;

          var parsed;
          try { parsed = JSON.parse(bodyText); } catch(e) {
            return JSON.stringify({ ok: false, phase: "parse", error: String(e), status: resp.status, bodyLen: bodyText.length });
          }

          var hasErrors = Array.isArray(parsed && parsed.errors) && parsed.errors.length > 0;
          var hasInstructions = !!(parsed && parsed.data && parsed.data.threaded_conversation_with_injections_v2 && parsed.data.threaded_conversation_with_injections_v2.instructions);

          function unwrapTweet(obj) {
            if (!obj || typeof obj !== "object") return null;
            if (obj.__typename === "TweetWithVisibilityResults" && obj.tweet && obj.tweet.rest_id) return obj.tweet;
            if (obj.__typename === "Tweet" && obj.rest_id) return obj;
            if (obj.rest_id && obj.legacy) return obj;
            if (obj.tweet && obj.tweet.rest_id) return obj.tweet;
            if (obj.result) return unwrapTweet(obj.result);
            return null;
          }

          var tweetsByDepth = {};
          var focalDepth = -1;
          var sameConvDepths = [];
          var sameAuthorDepths = [];
          var walked = [];
          function walk(obj, depth) {
            if (!obj || typeof obj !== "object" || depth > 30) return;
            var t = unwrapTweet(obj);
            if (t && t.rest_id) {
              walked.push({ id: t.rest_id, depth: depth, tweet: t });
              tweetsByDepth[depth] = (tweetsByDepth[depth] || 0) + 1;
              if (t.rest_id === ${FOCAL} && focalDepth < 0) focalDepth = depth;
              var c = t.legacy && t.legacy.conversation_id_str;
              var a = (t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.rest_id) || (t.legacy && t.legacy.user_id_str);
              if (focalDepth >= 0 && t.rest_id === ${FOCAL}) {
                if (!CONV) CONV = c || null;
                if (!AUTHOR) AUTHOR = a || null;
              }
            }
            if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) walk(obj[i], depth + 1); return; }
            for (var k in obj) {
              var v = obj[k];
              if (v && typeof v === "object") walk(v, depth + 1);
            }
          }
          walk(parsed, 0);

          // Second pass now that CONV/AUTHOR may be known from focal.
          for (var i = 0; i < walked.length; i++) {
            var w = walked[i]; var tt = w.tweet;
            var cc = tt.legacy && tt.legacy.conversation_id_str;
            var aa = (tt.core && tt.core.user_results && tt.core.user_results.result && tt.core.user_results.result.rest_id) || (tt.legacy && tt.legacy.user_id_str);
            if (CONV && cc === CONV) sameConvDepths.push(w.depth);
            if (CONV && AUTHOR && cc === CONV && aa === AUTHOR) sameAuthorDepths.push(w.depth);
          }

          var tweetsAboveCap = 0, tweetsAtOrBelowCap = 0;
          for (var d in tweetsByDepth) {
            if (Number(d) > 8) tweetsAboveCap += tweetsByDepth[d];
            else tweetsAtOrBelowCap += tweetsByDepth[d];
          }

          // Simulate putTweet on a cold cache to see gate outcomes
          var putSim = { new: 0, replaceMissingUser: 0, mergeMissingText: 0, rejectedNoImprovement: 0, rejectedNoRestId: 0 };
          var simCache = {};
          for (var j = 0; j < walked.length; j++) {
            var tw = walked[j].tweet;
            if (!tw || !tw.rest_id) { putSim.rejectedNoRestId++; continue; }
            var prev = simCache[tw.rest_id];
            if (!prev) { simCache[tw.rest_id] = tw; putSim.new++; }
            else if (!(prev.core && prev.core.user_results) && (tw.core && tw.core.user_results)) { simCache[tw.rest_id] = tw; putSim.replaceMissingUser++; }
            else if (!(prev.legacy && prev.legacy.full_text) && (tw.legacy && tw.legacy.full_text)) { simCache[tw.rest_id] = Object.assign({}, prev, tw); putSim.mergeMissingText++; }
            else { putSim.rejectedNoImprovement++; }
          }

          // Let probe's async response.clone().text().then(processGraphQL) finish
          await new Promise(function(r){ setTimeout(r, 600); });

          var postTOps = (store.observedOperations || [])
            .filter(function(o){ return o.at >= t0; })
            .map(function(o){ return o.op + "(" + o.status + ")"; });
          var after = countCache(CONV, AUTHOR);

          return JSON.stringify({
            ok: true,
            status: resp.status,
            elapsedMs: elapsedMs,
            bodyLen: bodyText.length,
            hasErrors: hasErrors,
            errors: hasErrors ? parsed.errors.slice(0, 3) : null,
            hasInstructions: hasInstructions,
            tweetsInResponse: walked.length,
            tweetsByDepth: tweetsByDepth,
            tweetsAboveDepthCap: tweetsAboveCap,
            tweetsAtOrBelowDepthCap: tweetsAtOrBelowCap,
            focalInResponse: focalDepth >= 0,
            focalDepth: focalDepth,
            sameConvCount: sameConvDepths.length,
            sameConvMinDepth: sameConvDepths.length ? Math.min.apply(null, sameConvDepths) : -1,
            sameAuthorCount: sameAuthorDepths.length,
            sameAuthorMinDepth: sameAuthorDepths.length ? Math.min.apply(null, sameAuthorDepths) : -1,
            putSim: putSim,
            cacheBefore: before,
            cacheAfter: after,
            observedOpsDuringReplay: postTOps,
            replayAgeMs: Date.now() - replay.recordedAt,
          });
        } catch (e) {
          return JSON.stringify({ ok: false, phase: "throw", error: String(e) });
        }
      })();
    `;
  }

  private async waitForHydration(wc: ElectronWebview, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const state = await wc.executeJavaScript(`
        (function() {
          try {
            var s = window.__TWITTER_BOOKMARK_SPIKE__;
            return JSON.stringify({
              tweetArticles: document.querySelectorAll('article[data-testid="tweet"]').length,
              probeInstalled: !!s && !!s.installed,
            });
          } catch (e) { return "{}"; }
        })();
      `).catch(() => "{}");
      let parsed: { tweetArticles?: number; probeInstalled?: boolean } = {};
      try { parsed = JSON.parse(state); } catch {}
      if ((parsed.tweetArticles || 0) > 0 && parsed.probeInstalled) return true;
    }
    return false;
  }

  private async pollForWindow(wc: ElectronWebview, timeoutMs: number): Promise<PollResult> {
    const deadline = Date.now() + timeoutMs;
    let lastOpsLen = 0;
    let replayRecorded = false;
    const conversationOpsSet = new Set<string>();
    let allOps: string[] = [];

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const diag = await wc.executeJavaScript(`
        (function() {
          try {
            var s = window.__TWITTER_BOOKMARK_SPIKE__;
            if (!s) return JSON.stringify({ missing: true });
            return JSON.stringify({
              url: location.href,
              fetchCalls: s.fetchCalls || 0,
              xhrCalls: s.xhrCalls || 0,
              replay: !!s.tweetDetailReplay,
              ops: (s.observedOperations || []).map(function(o){ return o.op + "(" + o.status + ")"; }),
              opNames: (s.observedOperations || []).map(function(o){ return o.op; }),
            });
          } catch (e) { return JSON.stringify({ err: String(e) }); }
        })();
      `).catch((e: Error) => JSON.stringify({ err: String(e) }));

      let parsed: {
        missing?: boolean; err?: string; url?: string;
        fetchCalls?: number; xhrCalls?: number;
        replay?: boolean; ops?: string[]; opNames?: string[];
      };
      try { parsed = JSON.parse(diag); } catch { parsed = { err: "parse failed: " + diag }; }
      if (parsed.err) { this.log(`  ERR: ${parsed.err}`); continue; }
      if (parsed.missing) { this.log("  store missing (probe not injected yet)"); continue; }

      const ops = parsed.ops || [];
      const opNames = parsed.opNames || [];
      allOps = ops;
      const newOps = ops.slice(lastOpsLen);
      const newOpNames = opNames.slice(lastOpsLen);
      lastOpsLen = ops.length;

      for (const name of newOpNames) {
        if (!name || PERIPHERAL_OPS.has(name)) continue;
        const lower = name.toLowerCase();
        if (CONVERSATION_OP_HINTS.some(h => lower.includes(h.toLowerCase()))) {
          conversationOpsSet.add(name);
        }
      }

      const elapsed = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
      this.log(`  t+${elapsed}s  replay=${parsed.replay ? "Y" : "N"}  fetch=${parsed.fetchCalls}  xhr=${parsed.xhrCalls}  url=${(parsed.url || "").slice(0, 60)}`);
      if (newOps.length) this.log(`    new ops: ${newOps.join(", ")}`);

      if (parsed.replay) replayRecorded = true;
    }

    return { replayRecorded, conversationOps: Array.from(conversationOpsSet), allOps };
  }
}
