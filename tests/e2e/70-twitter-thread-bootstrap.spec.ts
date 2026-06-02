/**
 * Twitter probe + thread-bootstrap regression.
 *
 * The probe's whole contract with `ThreadFetcher.ensureReplayReady` is:
 *   "When the page fires a /i/api/graphql/.../TweetDetail fetch, record its
 *    URL + headers into window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay."
 *
 * Earlier we tried to exercise this against a live public tweet URL.  That
 * turned out to be invalid — an unauthenticated hit to `x.com/jack/status/20`
 * gets a SSR "Log in / Sign up" shell that fires **zero** graphql, so the
 * test couldn't tell whether the probe was broken or Twitter just wasn't
 * issuing requests.  (See the first `it` below — kept as a diagnostic.)
 *
 * The real regression test here uses a mocked fetch so we don't depend on
 * Twitter's behavior at all: patch `window.fetch` before the probe installs,
 * fire a TweetDetail-shaped request, then assert `tweetDetailReplay` got
 * populated.  That's exactly the invariant `ensureReplayReady` depends on.
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
const PUBLIC_TWEET_URL = "https://x.com/jack/status/20";

const WEBVIEW_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface ProbeSnapshot {
    installed: boolean;
    replayRecorded: boolean;
    replayUrl: string | null;
    replayHeaderKeys: string[];
    matchedUrls: number;
    ops: { op: string; method: string; status: number }[];
    currentUrl: string;
    fetchCalls: number;
    xhrCalls: number;
    recentFetchUrls: string[];
    title: string;
    bodySnippet: string;
}

// Runs `js` inside the twitter webview, returns its result.
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
            "var r = s && s.tweetDetailReplay;" +
            "return JSON.stringify({" +
            "installed: !!s," +
            "replayRecorded: !!r," +
            "replayUrl: (r && r.url) || null," +
            "replayHeaderKeys: r ? Object.keys(r.headers || {}).map(function(k){return k.toLowerCase();}).sort() : []," +
            "matchedUrls: (s && s.matchedUrls) || 0," +
            "ops: (s && s.observedOperations) || []," +
            "currentUrl: location.href," +
            "fetchCalls: (s && s.fetchCalls) || 0," +
            "xhrCalls: (s && s.xhrCalls) || 0," +
            "recentFetchUrls: (s && s.recentFetchUrls) || []," +
            "title: document.title," +
            "bodySnippet: (document.body && document.body.innerText || '').slice(0, 200)," +
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

describe("Twitter probe — thread-bootstrap regression", function () {
    this.timeout(120_000);

    before(async function () {
        await ensureWebviewReady();
    });

    // ────────────────────────────────────────────────────────────────────────
    // CORE REGRESSION — mocked fetch, deterministic, no live-Twitter dependency
    // ────────────────────────────────────────────────────────────────────────

    it("records tweetDetailReplay when a TweetDetail-shaped fetch fires on the page", async function () {
        // 1. Navigate to a neutral page so we have a clean JS context.
        //    Wait for the probe to be gone so we know we can set up mocks.
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
                return snap ? snap.currentUrl === "about:blank" : false;
            },
            { timeout: 10_000, timeoutMsg: "webview never reached about:blank", interval: 250 },
        );

        // 2. Install the mock fetch FIRST, then inject the probe.  The probe
        //    captures window.fetch at injection time as `nativeFetch`, so order
        //    matters: mock → probe → call fetch.
        const installResult = await runInWebview<string>(
            "(function(){" +
                "try {" +
                // mock: respond 200 to any TweetDetail URL, pass through otherwise.
                "var origFetch = window.fetch.bind(window);" +
                "window.fetch = function(url, init) {" +
                "var u = typeof url === 'string' ? url : (url && url.url) || '';" +
                "if (/\\/i\\/api\\/graphql\\/.+\\/TweetDetail(?:\\?|$)/.test(u)) {" +
                "return Promise.resolve(new Response('{\"data\":{}}', {status: 200, headers: {'content-type':'application/json'}}));" +
                "}" +
                "return origFetch(url, init);" +
                "};" +
                // now inject the probe — its nativeFetch === our mock.
                PROBE_SOURCE +
                "return 'ok';" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(installResult).toBe("ok");

        // 3. Fire a TweetDetail-shaped fetch from inside the page, await it.
        const fetchResult = await runInWebview<string>(
            "(async function(){" +
                "try {" +
                // Use absolute URL: on about:blank, location.origin is "null",
                // so `new URL(relative, "null")` throws in operationName().  The
                // production probe runs on x.com where location.origin is real,
                // so this matches production semantics.
                "var r = await fetch('https://x.com/i/api/graphql/FAKEHASH123/TweetDetail?variables=%7B%22focalTweetId%22%3A%2220%22%7D', {" +
                "headers: { 'x-client-transaction-id': 'test-transaction', 'authorization': 'Bearer test-token' }" +
                "});" +
                "return 'status:' + r.status;" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(fetchResult).toBe("status:200");

        // The probe's processGraphQL runs in a fire-and-forget
        // `.then(...)` after `response.clone().text()` resolves.  One second
        // is comfortably more than the microtask + IPC round trip.
        await browser.pause(1000);

        // 4. Assert the probe recorded the replay.
        const snap = await snapshotProbe();
        if (!snap) throw new Error("no snapshot");
        // eslint-disable-next-line no-console
        console.log(
            `[mock-test] installed=${snap.installed} replayRecorded=${snap.replayRecorded} ` +
                `replayUrl=${snap.replayUrl} headerKeys=[${snap.replayHeaderKeys.join(",")}] ` +
                `fetchCalls=${snap.fetchCalls} matchedUrls=${snap.matchedUrls}`,
        );

        expect(snap.installed).toBe(true);
        expect(snap.replayRecorded).toBe(true);
        expect(snap.replayUrl).toContain("/i/api/graphql/");
        expect(snap.replayUrl).toContain("TweetDetail");
        // Headers should have been captured and lowercased; custom ones must be present.
        expect(snap.replayHeaderKeys).toContain("authorization");
        expect(snap.replayHeaderKeys).toContain("x-client-transaction-id");
        // Observed ops ring-buffer should also include TweetDetail.
        const opNames = snap.ops.map((o) => o.op);
        expect(opNames).toContain("TweetDetail");
    });

    // ────────────────────────────────────────────────────────────────────────
    // LIVE DIAGNOSTIC — unauthenticated, captures what real x.com actually fires
    //
    // NOT a strict regression.  The expected outcome against an unauth'd
    // webview is a SSR login wall with zero graphql.  If fetchCalls is 0 and
    // the body starts with "Don't miss what's happening", that's the baseline.
    // If Twitter someday ships a different logged-out path, this will surface
    // it in the log output — which is the point.
    // ────────────────────────────────────────────────────────────────────────

    it("smoke: logs what a real public status page serves (unauthenticated)", async function () {
        await browser.executeObsidian(
            ({ app }, pluginId, probeSrc, url) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const plugin = (app as any).plugins.plugins[pluginId];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const wv = plugin.getWebviewManager().getElement("twitter") as any;
                const reinject = () => {
                    wv.executeJavaScript(
                        "try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}\n" +
                            "try { " + probeSrc + " } catch(e) {}\n" +
                            "void 0;",
                    ).catch(() => {});
                };
                wv.addEventListener("dom-ready", reinject);
                wv.__roostTestReinject = reinject;
                wv.loadURL(url);
            },
            PLUGIN_ID,
            PROBE_SOURCE,
            PUBLIC_TWEET_URL,
        );

        const deadline = Date.now() + 15_000;
        let snap: ProbeSnapshot | null = null;
        while (Date.now() < deadline) {
            await browser.pause(POLL_INTERVAL_MS);
            snap = await snapshotProbe();
            if (snap && snap.replayRecorded) break;
            if (snap && snap.currentUrl.includes("/jack/status/") && snap.fetchCalls > 0) {
                // once we've got at least one fetch post-navigation, give the page
                // another second then stop — we've learned what we need.
                await browser.pause(1000);
                snap = await snapshotProbe();
                break;
            }
        }

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

        if (!snap) throw new Error("no snapshot from live smoke");
        const ops = snap.ops.map((o) => `${o.op}(${o.status})`).join(", ") || "<none>";
        // eslint-disable-next-line no-console
        console.log(
            `[live-smoke] url=${snap.currentUrl} title=${JSON.stringify(snap.title)} ` +
                `fetchCalls=${snap.fetchCalls} xhrCalls=${snap.xhrCalls} ` +
                `replayRecorded=${snap.replayRecorded} ops=[${ops}]`,
        );
        // eslint-disable-next-line no-console
        console.log(`[live-smoke] body=${JSON.stringify(snap.bodySnippet)}`);
        // eslint-disable-next-line no-console
        console.log(`[live-smoke] recentFetchUrls=\n  ${snap.recentFetchUrls.join("\n  ")}`);

        // Assertion: probe must be installed.  We don't assert replayRecorded —
        // unauth'd x.com doesn't fire graphql on status pages.  We DO assert
        // the page navigated to the expected URL so we know the webview isn't
        // just broken.
        expect(snap.installed).toBe(true);
        expect(snap.currentUrl).toContain("x.com");
    });
});
