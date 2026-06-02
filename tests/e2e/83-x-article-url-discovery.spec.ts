/**
 * X article URL discovery — informational diagnostic.
 *
 * The article body fetcher's bootstrap navigates to /i/article/<tweetId>
 * to trigger a TweetResultByRestId GraphQL request that the probe captures.
 * On the live x.com build this URL may be deprecated — when it returns
 * "This page is not supported. Please visit the author's profile..." the
 * bootstrap times out and the entire backfill fails with no-replay.
 *
 * This spec drives the X webview through several candidate URL forms and
 * reports what x.com actually serves for each + whether any trigger
 * TweetResultByRestId. The output is diagnostic, not pass/fail — use it
 * to identify the working URL form when X changes its routing.
 *
 * Mirrors the LIVE DIAGNOSTIC pattern in 70-twitter-thread-bootstrap.spec.ts.
 *
 * Configure with E2E_ARTICLE_TWEET_ID env var to test against a specific
 * tweet ID; defaults to a known public-article ID if unset (may go stale).
 */

import { browser } from "@wdio/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_SOURCE = fs.readFileSync(
    path.resolve(__dirname, "../../packages/core/src/probes/twitter-probe.js"),
    "utf-8",
);

const PLUGIN_ID = "roost";
const WEBVIEW_READY_TIMEOUT_MS = 30_000;
const PER_URL_OBSERVE_MS = 12_000;

// Default known article tweet ID. May go stale — pass E2E_ARTICLE_TWEET_ID
// to override. Pick from the user's vault: any folder Bookmarks/X/twitter-{id}/
// whose raw.json contains article_results.
const DEFAULT_TWEET_ID = process.env.E2E_ARTICLE_TWEET_ID || "1875730083131838563";

interface ProbeSnapshot {
    installed: boolean;
    articleReplayRecorded: boolean;
    tweetCacheSize: number;
    cachedTweetHasArticle: boolean;
    cachedTweetHasContentState: boolean;
    fetchCalls: number;
    xhrCalls: number;
    matchedUrls: number;
    ops: string[];
    currentUrl: string;
    title: string;
    bodySnippet: string;
    recentFetchUrls: string[];
}

async function runInWebview<T = unknown>(js: string): Promise<T | null> {
    const raw = await browser.executeObsidian(
        async ({ app }, pluginId, src) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            if (!wv) return null;
            try {
                return await wv.executeJavaScript(src);
            } catch (err) {
                return { __error: String(err) };
            }
        },
        PLUGIN_ID,
        js,
    );
    return (raw as T) ?? null;
}

async function snapshotProbe(tweetId: string): Promise<ProbeSnapshot | null> {
    const json = await runInWebview<string>(
        "(function(){" +
            "var s = window.__TWITTER_BOOKMARK_SPIKE__;" +
            "var cache = (s && s.tweetCache) || {};" +
            "var t = cache[" + JSON.stringify(tweetId) + "];" +
            "var hasArt = !!(t && (t.article || (t.quoted_status_result && t.quoted_status_result.result && t.quoted_status_result.result.article)));" +
            "var ar = t && ((t.article && t.article.article_results && t.article.article_results.result) || (t.quoted_status_result && t.quoted_status_result.result && t.quoted_status_result.result.article && t.quoted_status_result.result.article.article_results && t.quoted_status_result.result.article.article_results.result));" +
            "var hasCs = !!(ar && ar.content_state);" +
            "return JSON.stringify({" +
            "installed: !!s," +
            "articleReplayRecorded: !!(s && s.articleResultReplay)," +
            "tweetCacheSize: Object.keys(cache).length," +
            "cachedTweetHasArticle: hasArt," +
            "cachedTweetHasContentState: hasCs," +
            "fetchCalls: (s && s.fetchCalls) || 0," +
            "xhrCalls: (s && s.xhrCalls) || 0," +
            "matchedUrls: (s && s.matchedUrls) || 0," +
            "ops: ((s && s.observedOperations) || []).map(function(o){return o.op + '(' + o.status + ')';})," +
            "currentUrl: location.href," +
            "title: document.title," +
            "bodySnippet: (document.body && document.body.innerText || '').slice(0, 240)," +
            "recentFetchUrls: ((s && s.recentFetchUrls) || []).slice(-10)," +
            "});" +
            "})();",
    );
    if (!json) return null;
    return JSON.parse(json) as ProbeSnapshot;
}

async function ensureWebviewReady(): Promise<void> {
    await browser.executeObsidian(({ app }, pluginId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plugin = (app as any).plugins.plugins[pluginId];
        if (!plugin) throw new Error(`plugin ${pluginId} not loaded`);
        const wm = plugin.getWebviewManager();
        const container: HTMLElement = wm.getContainer();
        if (!container.parentElement) {
            container.style.cssText = "position: fixed; inset: 0; z-index: 99999;";
            document.body.appendChild(container);
        }
    }, PLUGIN_ID);

    await browser.waitUntil(
        async () =>
            browser.executeObsidian(({ app }, pluginId) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const plugin = (app as any).plugins.plugins[pluginId];
                const wm = plugin?.getWebviewManager?.();
                return wm ? wm.getWebContents("twitter") !== null : false;
            }, PLUGIN_ID),
        {
            timeout: WEBVIEW_READY_TIMEOUT_MS,
            timeoutMsg: "twitter webview never became ready (webContentsId stayed null)",
            interval: 500,
        },
    );
}

async function navigateAndReinjectProbe(url: string): Promise<void> {
    await browser.executeObsidian(
        ({ app }, pluginId, probeSrc, targetUrl) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            // Re-inject the probe on every dom-ready since loadURL replaces the document.
            const reinject = () => {
                wv.executeJavaScript(
                    "try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}\n" +
                        "try { " + probeSrc + " } catch(e) {}\n" +
                        "void 0;",
                ).catch(() => {});
            };
            wv.removeEventListener?.("dom-ready", wv.__roostTestReinject);
            wv.addEventListener("dom-ready", reinject);
            wv.__roostTestReinject = reinject;
            wv.loadURL(targetUrl);
        },
        PLUGIN_ID,
        PROBE_SOURCE,
        url,
    );
}

async function observeForReplay(tweetId: string, ms: number): Promise<ProbeSnapshot | null> {
    const deadline = Date.now() + ms;
    let snap: ProbeSnapshot | null = null;
    while (Date.now() < deadline) {
        await browser.pause(500);
        snap = await snapshotProbe(tweetId);
        // Bail early once we observe a replay or any TweetResultByRestId op
        if (snap && snap.articleReplayRecorded) break;
        if (snap && snap.ops.some(op => op.startsWith("TweetResultByRestId"))) break;
    }
    return snap;
}

interface UrlAttempt {
    label: string;
    url: string;
}

const URL_FORMS = (tweetId: string): UrlAttempt[] => [
    // The original assumption: dedicated article URL form.
    { label: "i/article",      url: `https://x.com/i/article/${tweetId}` },
    // The canonical tweet URL — many article-bearing tweets render the article inline here.
    { label: "i/status",       url: `https://x.com/i/status/${tweetId}` },
    // A neutral starting page — useful as a baseline ("does X load at all unauthenticated?")
    { label: "home",           url: `https://x.com/home` },
];

describe("X article URL discovery — diagnostic", function () {
    this.timeout(180_000);

    before(async function () {
        await ensureWebviewReady();
    });

    it(`probes URL forms for tweet ${DEFAULT_TWEET_ID} and reports what triggers TweetResultByRestId`, async function () {
        const tweetId = DEFAULT_TWEET_ID;
        const results: { label: string; url: string; snap: ProbeSnapshot | null }[] = [];

        for (const attempt of URL_FORMS(tweetId)) {
            // eslint-disable-next-line no-console
            console.log(`\n[url-discovery] navigating to ${attempt.label}: ${attempt.url}`);
            await navigateAndReinjectProbe(attempt.url);
            const snap = await observeForReplay(tweetId, PER_URL_OBSERVE_MS);
            results.push({ label: attempt.label, url: attempt.url, snap });

            // eslint-disable-next-line no-console
            if (!snap) {
                console.log(`[url-discovery] ${attempt.label}: NO SNAPSHOT`);
                continue;
            }
            console.log(
                `[url-discovery] ${attempt.label}: replayRecorded=${snap.articleReplayRecorded} ` +
                    `cacheSize=${snap.tweetCacheSize} hasArticle=${snap.cachedTweetHasArticle} ` +
                    `hasContentState=${snap.cachedTweetHasContentState} ` +
                    `fetchCalls=${snap.fetchCalls} xhrCalls=${snap.xhrCalls} ` +
                    `currentUrl=${snap.currentUrl}`,
            );
            // eslint-disable-next-line no-console
            console.log(`[url-discovery] ${attempt.label} title: ${JSON.stringify(snap.title)}`);
            // eslint-disable-next-line no-console
            console.log(`[url-discovery] ${attempt.label} ops: [${snap.ops.join(", ") || "<none>"}]`);
            // eslint-disable-next-line no-console
            console.log(`[url-discovery] ${attempt.label} body: ${JSON.stringify(snap.bodySnippet)}`);
            // eslint-disable-next-line no-console
            console.log(
                `[url-discovery] ${attempt.label} recentFetchUrls:\n  ${snap.recentFetchUrls.join("\n  ") || "<none>"}`,
            );
        }

        // Cleanup the dom-ready listener.
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            if (wv && wv.__roostTestReinject) {
                wv.removeEventListener("dom-ready", wv.__roostTestReinject);
                delete wv.__roostTestReinject;
            }
        }, PLUGIN_ID);

        // ──── Summary ────────────────────────────────────────────────
        // eslint-disable-next-line no-console
        console.log("\n[url-discovery] SUMMARY:");
        const winner = results.find(r => r.snap?.articleReplayRecorded);
        if (winner) {
            // eslint-disable-next-line no-console
            console.log(`[url-discovery] ✓ TweetResultByRestId captured via: ${winner.label} (${winner.url})`);
        } else {
            // eslint-disable-next-line no-console
            console.log("[url-discovery] ✗ NO URL form triggered TweetResultByRestId.");
            // eslint-disable-next-line no-console
            console.log("[url-discovery]   This means SPA-nav bootstrap won't work on the current X build.");
            // eslint-disable-next-line no-console
            console.log("[url-discovery]   Options: (1) authenticate the test session and re-run,");
            // eslint-disable-next-line no-console
            console.log("[url-discovery]   (2) extract queryId from x.com main bundle to bypass replay capture.");
        }

        // Always-on assertion: the probe must have installed on at least one
        // attempt. If it never installs, the test infrastructure is broken,
        // not just X's URL routing.
        const anyInstalled = results.some(r => r.snap?.installed);
        expect(anyInstalled).toBe(true);
    });
});
