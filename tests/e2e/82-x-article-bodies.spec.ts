/**
 * X article body fetching — probe + fetcher regression.
 *
 * Exercises the article-body capture path end-to-end inside a real Electron
 * webview, without depending on a live X login session:
 *
 *   1. Mock `window.fetch` so any /i/api/graphql/.../TweetResultByRestId URL
 *      returns a canned response containing a tweet with article.article_results
 *      .result.content_state populated.
 *   2. Inject the probe (mirroring how src/main.ts does at sync time).
 *   3. Fire a TweetResultByRestId-shaped fetch from inside the page. Verify:
 *      - probe records articleResultReplay (URL + headers)
 *      - probe walkAndCache merges the response into tweetCache with the new
 *        content_state branch in putTweet
 *      - ROOST_TWITTER_ARTICLE_BODY postMessage fires
 *
 * This proves the probe layer is correct independent of whether SPA-nav to
 * /i/article/<id> actually triggers TweetResultByRestId on live x.com — that
 * is the one failure mode that requires a real authenticated session to test.
 *
 * Mirror of tests/e2e/70-twitter-thread-bootstrap.spec.ts which does the same
 * for TweetDetail.
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

const FAKE_TWEET_ID = "1234567890";
const FAKE_ARTICLE_TITLE = "Test Article";

// A canned TweetResultByRestId response: a wrapping tweet with an article
// containing a minimal but realistic content_state (one paragraph block).
const FAKE_RESPONSE_BODY = JSON.stringify({
    data: {
        tweetResult: {
            result: {
                __typename: "Tweet",
                rest_id: FAKE_TWEET_ID,
                core: {
                    user_results: {
                        result: {
                            __typename: "User",
                            core: { name: "Test Author", screen_name: "test" },
                            legacy: {},
                        },
                    },
                },
                legacy: {
                    id_str: FAKE_TWEET_ID,
                    full_text: "Stub tweet text",
                    conversation_id_str: FAKE_TWEET_ID,
                },
                article: {
                    article_results: {
                        result: {
                            id: "art_1",
                            rest_id: FAKE_TWEET_ID,
                            title: FAKE_ARTICLE_TITLE,
                            preview_text: "Preview snippet here.",
                            cover_media: {
                                media_info: {
                                    original_img_url: "https://pbs.twimg.com/media/fake-cover.jpg",
                                },
                            },
                            metadata: { first_published_at_secs: 1714492800 },
                            content_state: {
                                blocks: [
                                    {
                                        key: "blk1",
                                        type: "header-one",
                                        text: "Test Article",
                                        depth: 0,
                                        inlineStyleRanges: [],
                                        entityRanges: [],
                                    },
                                    {
                                        key: "blk2",
                                        type: "unstyled",
                                        text: "This is the article body. It has multiple sentences.",
                                        depth: 0,
                                        inlineStyleRanges: [{ offset: 8, length: 11, style: "BOLD" }],
                                        entityRanges: [],
                                    },
                                ],
                                entityMap: [],
                            },
                        },
                    },
                },
            },
        },
    },
});

interface ProbeSnapshot {
    installed: boolean;
    articleReplayRecorded: boolean;
    articleReplayUrl: string | null;
    articleReplayHeaderKeys: string[];
    cachedTweet: unknown | null;
    hasContentState: boolean;
    receivedArticleBodyMessage: boolean;
    fetchCalls: number;
    matchedUrls: number;
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

async function snapshotProbe(): Promise<ProbeSnapshot | null> {
    const json = await runInWebview<string>(
        "(function(){" +
            "var s = window.__TWITTER_BOOKMARK_SPIKE__;" +
            "var r = s && s.articleResultReplay;" +
            "var t = s && s.tweetCache && s.tweetCache[" + JSON.stringify(FAKE_TWEET_ID) + "];" +
            "var cs = t && t.article && t.article.article_results && t.article.article_results.result && t.article.article_results.result.content_state;" +
            "return JSON.stringify({" +
            "installed: !!s," +
            "articleReplayRecorded: !!r," +
            "articleReplayUrl: (r && r.url) || null," +
            "articleReplayHeaderKeys: r ? Object.keys(r.headers || {}).map(function(k){return k.toLowerCase();}).sort() : []," +
            "cachedTweet: t || null," +
            "hasContentState: !!cs," +
            "receivedArticleBodyMessage: !!window.__ARTICLE_BODY_MSG_RECEIVED__," +
            "fetchCalls: (s && s.fetchCalls) || 0," +
            "matchedUrls: (s && s.matchedUrls) || 0," +
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

describe("X article body fetching — probe + cache regression", function () {
    this.timeout(120_000);

    before(async function () {
        await ensureWebviewReady();
    });

    it("captures TweetResultByRestId replay + merges content_state into tweetCache + emits ROOST_TWITTER_ARTICLE_BODY", async function () {
        // 1. Land on about:blank for a clean JS context.
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            wv.loadURL("about:blank");
        }, PLUGIN_ID);

        await browser.waitUntil(
            async () => {
                const snap = await snapshotProbe();
                return snap !== null;
            },
            { timeout: 10_000, interval: 250 },
        );

        // 2. Install the mock fetch FIRST + a postMessage listener for
        //    ROOST_TWITTER_ARTICLE_BODY, THEN inject the probe. The probe
        //    captures window.fetch at injection time as nativeFetch, so order
        //    matters: mock → listener → probe → fire fetch.
        const installResult = await runInWebview<string>(
            "(function(){" +
                "try {" +
                "var origFetch = window.fetch.bind(window);" +
                "window.fetch = function(url, init) {" +
                "var u = typeof url === 'string' ? url : (url && url.url) || '';" +
                "if (/\\/i\\/api\\/graphql\\/.+\\/TweetResultByRestId(?:\\?|$)/.test(u)) {" +
                "return Promise.resolve(new Response(" + JSON.stringify(FAKE_RESPONSE_BODY) + ", {" +
                "status: 200, headers: {'content-type':'application/json'}" +
                "}));" +
                "}" +
                "return origFetch(url, init);" +
                "};" +
                "window.__ARTICLE_BODY_MSG_RECEIVED__ = false;" +
                "window.addEventListener('message', function(ev) {" +
                "if (ev && ev.data && ev.data.type === 'ROOST_TWITTER_ARTICLE_BODY') {" +
                "window.__ARTICLE_BODY_MSG_RECEIVED__ = true;" +
                "}" +
                "});" +
                PROBE_SOURCE +
                "return 'ok';" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(installResult).toBe("ok");

        // 3. Fire a TweetResultByRestId-shaped fetch.
        const fetchResult = await runInWebview<string>(
            "(async function(){" +
                "try {" +
                "var r = await fetch('https://x.com/i/api/graphql/FAKEHASH123/TweetResultByRestId?variables=%7B%22tweetId%22%3A%22" + FAKE_TWEET_ID + "%22%7D&fieldToggles=%7B%22withArticleRichContentState%22%3Atrue%7D', {" +
                "headers: { 'x-client-transaction-id': 'test-transaction', 'authorization': 'Bearer test-token' }" +
                "});" +
                "return 'status:' + r.status;" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(fetchResult).toBe("status:200");

        // The probe's processGraphQL runs in a fire-and-forget
        // .then(...) after response.clone().text() resolves. One second
        // is comfortably more than the microtask + IPC round trip, plus the
        // postMessage propagation.
        await browser.pause(1000);

        // 4. Assert the probe captured everything we expected.
        const snap = await snapshotProbe();
        if (!snap) throw new Error("no snapshot");
        // eslint-disable-next-line no-console
        console.log(
            "[article-probe] installed=" + snap.installed +
                " replayRecorded=" + snap.articleReplayRecorded +
                " hasContentState=" + snap.hasContentState +
                " bodyMsgReceived=" + snap.receivedArticleBodyMessage +
                " fetchCalls=" + snap.fetchCalls,
        );

        expect(snap.installed).toBe(true);

        // (a) Replay URL+headers were recorded by recordArticleReplay().
        expect(snap.articleReplayRecorded).toBe(true);
        expect(snap.articleReplayUrl).toContain("/i/api/graphql/");
        expect(snap.articleReplayUrl).toContain("TweetResultByRestId");
        expect(snap.articleReplayHeaderKeys).toContain("authorization");
        expect(snap.articleReplayHeaderKeys).toContain("x-client-transaction-id");

        // (b) walkAndCache merged the response — tweetCache has the article body.
        expect(snap.cachedTweet).not.toBeNull();
        expect(snap.hasContentState).toBe(true);

        // (c) The new ROOST_TWITTER_ARTICLE_BODY postMessage fired.
        expect(snap.receivedArticleBodyMessage).toBe(true);
    });
});
