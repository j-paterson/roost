/**
 * X article bootstrap — queryId extraction fallback regression.
 *
 * Exercises the `bootstrapViaQueryIdExtraction` path WITHOUT a real x.com
 * session by mocking the fetch responses that the extraction script issues:
 *
 *   1. Mock `window.fetch` so that:
 *      - `https://x.com/` returns HTML containing a <script src="...main.FAKEHASH.js"> tag
 *      - That bundle URL returns JS containing
 *        `{queryId:"FAKE_QUERY_ID_123",operationName:"TweetResultByRestId"}`
 *   2. Pre-populate `tweetDetailReplay` in the probe store (the extraction
 *      script requires it as input for headers).
 *   3. Inject the probe (so window.__TWITTER_BOOKMARK_SPIKE__ is wired up).
 *   4. Manually invoke the extraction script that ArticleFetcher.extractionScript()
 *      produces.
 *   5. Assert:
 *      - result.ok === true
 *      - store.articleResultReplay is now populated
 *      - The synthetic URL contains FAKE_QUERY_ID_123
 *      - The synthetic URL contains TweetResultByRestId
 *      - The headers were copied from tweetDetailReplay (includes authorization)
 *      - The _synthetic marker is set
 *
 * Mirrors 82-x-article-bodies.spec.ts (the probe regression) and
 * 70-twitter-thread-bootstrap.spec.ts (the mock-fetch pattern).
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

const FAKE_QUERY_ID = "FAKE_QUERY_ID_123";
const FAKE_BUNDLE_HASH = "FAKEHASH";
const FAKE_BUNDLE_URL = `https://abs.twimg.com/responsive-web/client-web/main.${FAKE_BUNDLE_HASH}.js`;

// Root HTML that the extraction script fetches first — must contain the bundle script tag.
const FAKE_ROOT_HTML = `<!DOCTYPE html><html><head>
<script src="${FAKE_BUNDLE_URL}"></script>
</head><body><div id="react-root"></div></body></html>`;

// The bundle JS that the extraction script fetches second — must contain the queryId pattern.
// Use the primary ordering: queryId first, then operationName.
const FAKE_BUNDLE_JS = `var x={queryId:"${FAKE_QUERY_ID}",operationName:"TweetResultByRestId"};`;

// The extraction script from ArticleFetcher (copied verbatim so we test the actual logic,
// not a stub). This must stay in sync with src/sync/article-fetcher.ts extractionScript().
const EXTRACTION_SCRIPT = `
  (async function() {
    try {
      var store = window.__TWITTER_BOOKMARK_SPIKE__;
      if (!store) return { ok: false, reason: "no-probe" };
      if (store.articleResultReplay) return { ok: true, source: "already-set" };

      var td = store.tweetDetailReplay;
      if (!td) return { ok: false, reason: "no-tweet-detail-replay" };

      // Fetch x.com root for the main-bundle script tag.
      var rootResp = await fetch("https://x.com/", { credentials: "include" });
      if (!rootResp.ok) return { ok: false, reason: "root-fetch-" + rootResp.status };
      var rootHtml = await rootResp.text();

      // Parse out the main bundle URL from <script src="..."> tags.
      // Format: https://abs.twimg.com/responsive-web/client-web/main.{hash}.js
      // (also "main.{hash}.{platform}.js" — be tolerant)
      var mainBundleMatch = rootHtml.match(/https:\\/\\/abs\\.twimg\\.com\\/responsive-web\\/client-web\\/main\\.[A-Za-z0-9]+(?:\\.[A-Za-z0-9-]+)?\\.js/);
      if (!mainBundleMatch) return { ok: false, reason: "no-main-bundle-found-in-root-html" };
      var mainBundleUrl = mainBundleMatch[0];

      // Fetch the bundle.
      var bundleResp = await fetch(mainBundleUrl, { credentials: "include" });
      if (!bundleResp.ok) return { ok: false, reason: "bundle-fetch-" + bundleResp.status, mainBundleUrl: mainBundleUrl };
      var bundleText = await bundleResp.text();

      // Regex-extract TweetResultByRestId queryId. Handle both orderings.
      // Pattern 1: {queryId:"...",operationName:"TweetResultByRestId"}
      // Pattern 2: {operationName:"TweetResultByRestId",queryId:"..."}
      var m = bundleText.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"TweetResultByRestId"/);
      if (!m) m = bundleText.match(/operationName:"TweetResultByRestId",queryId:"([A-Za-z0-9_-]+)"/);
      if (!m) return { ok: false, reason: "queryId-not-found-in-bundle", mainBundleUrl: mainBundleUrl, bundleSize: bundleText.length };
      var queryId = m[1];

      // Synthesize the replay record. Use the original tweetDetailReplay
      // headers (already includes auth/transaction/etc) but build a brand-new
      // URL targeting TweetResultByRestId with the right shape.
      var url = "https://x.com/i/api/graphql/" + queryId + "/TweetResultByRestId" +
                "?variables=" + encodeURIComponent(JSON.stringify({})) +
                "&features=" + encodeURIComponent(JSON.stringify({})) +
                "&fieldToggles=" + encodeURIComponent(JSON.stringify({}));

      store.articleResultReplay = {
        url: url,
        headers: td.headers,
        recordedAt: Date.now(),
        _synthetic: true,
        _queryId: queryId,
        _bundleUrl: mainBundleUrl
      };

      return { ok: true, source: "extracted", queryId: queryId, bundleUrl: mainBundleUrl };
    } catch (e) {
      return { ok: false, reason: "exception:" + String(e) };
    }
  })();
`;

interface ExtractionResult {
    ok: boolean;
    source?: string;
    queryId?: string;
    bundleUrl?: string;
    reason?: string;
}

interface ReplaySnapshot {
    replaySet: boolean;
    replayUrl: string | null;
    replayIsSynthetic: boolean;
    replayQueryId: string | null;
    replayHeaderKeys: string[];
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

async function snapshotReplay(): Promise<ReplaySnapshot | null> {
    const json = await runInWebview<string>(
        "(function(){" +
            "var s = window.__TWITTER_BOOKMARK_SPIKE__;" +
            "var r = s && s.articleResultReplay;" +
            "return JSON.stringify({" +
            "replaySet: !!r," +
            "replayUrl: (r && r.url) || null," +
            "replayIsSynthetic: !!(r && r._synthetic)," +
            "replayQueryId: (r && r._queryId) || null," +
            "replayHeaderKeys: r ? Object.keys(r.headers || {}).map(function(k){return k.toLowerCase();}).sort() : []," +
            "});" +
            "})();",
    );
    if (!json) return null;
    return JSON.parse(json) as ReplaySnapshot;
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

describe("X article bootstrap — queryId extraction fallback", function () {
    this.timeout(60_000);

    before(async function () {
        await ensureWebviewReady();
    });

    it("extracts queryId from mocked bundle and synthesizes articleResultReplay", async function () {
        // 1. Navigate to about:blank for a clean JS context.
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            wv.loadURL("about:blank");
        }, PLUGIN_ID);

        await browser.waitUntil(
            async () => {
                const snap = await snapshotReplay();
                return snap !== null;
            },
            { timeout: 10_000, interval: 250 },
        );

        // 2. Install mocked fetch + pre-populate tweetDetailReplay + inject probe.
        //    Order matters: mock fetch first (probe captures window.fetch at injection
        //    time), then set tweetDetailReplay, then run extraction.
        //
        //    The mocks intercept:
        //      - https://x.com/       → FAKE_ROOT_HTML (contains main bundle script tag)
        //      - FAKE_BUNDLE_URL      → FAKE_BUNDLE_JS (contains queryId pattern)
        //
        //    Everything else falls through to the original fetch (won't be hit in this test).
        const installResult = await runInWebview<string>(
            "(function(){" +
                "try {" +
                "var origFetch = window.fetch.bind(window);" +
                "window.fetch = function(url, init) {" +
                "var u = typeof url === 'string' ? url : (url && url.url) || '';" +
                // Mock 1: x.com root
                "if (u === 'https://x.com/') {" +
                "return Promise.resolve(new Response(" + JSON.stringify(FAKE_ROOT_HTML) + ", {" +
                "status: 200, headers: {'content-type':'text/html'}" +
                "}));" +
                "}" +
                // Mock 2: main bundle
                "if (u === " + JSON.stringify(FAKE_BUNDLE_URL) + ") {" +
                "return Promise.resolve(new Response(" + JSON.stringify(FAKE_BUNDLE_JS) + ", {" +
                "status: 200, headers: {'content-type':'application/javascript'}" +
                "}));" +
                "}" +
                "return origFetch(url, init);" +
                "};" +
                // Inject the probe so window.__TWITTER_BOOKMARK_SPIKE__ is set up.
                PROBE_SOURCE +
                // Pre-populate tweetDetailReplay — the extraction script requires it
                // to copy headers from. In production this gets set by normal sync
                // activity; here we seed it directly.
                "window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay = {" +
                "url: 'https://x.com/i/api/graphql/HASH/TweetDetail?variables={}', " +
                "headers: { 'authorization': 'Bearer test-token', 'x-client-transaction-id': 'test-tx-id' }, " +
                "recordedAt: Date.now()" +
                "};" +
                "return 'ok';" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(installResult).toBe("ok");

        // 3. Run the extraction script directly (this is the logic inside
        //    ArticleFetcher.extractionScript() — we test it here against our mocks).
        const extractResult = await runInWebview<ExtractionResult>(EXTRACTION_SCRIPT);
        // eslint-disable-next-line no-console
        console.log("[extraction-test] extractResult:", JSON.stringify(extractResult));

        // 4. Assert extraction succeeded.
        expect(extractResult).not.toBeNull();
        expect(extractResult?.ok).toBe(true);
        expect(extractResult?.source).toBe("extracted");
        expect(extractResult?.queryId).toBe(FAKE_QUERY_ID);
        expect(extractResult?.bundleUrl).toBe(FAKE_BUNDLE_URL);

        // 5. Assert store.articleResultReplay is now populated correctly.
        const replay = await snapshotReplay();
        // eslint-disable-next-line no-console
        console.log("[extraction-test] replay snapshot:", JSON.stringify(replay));

        expect(replay).not.toBeNull();
        expect(replay?.replaySet).toBe(true);

        // URL must contain the fake queryId and operation name.
        expect(replay?.replayUrl).toContain(FAKE_QUERY_ID);
        expect(replay?.replayUrl).toContain("TweetResultByRestId");

        // Headers must be copied from tweetDetailReplay (both keys present).
        expect(replay?.replayHeaderKeys).toContain("authorization");
        expect(replay?.replayHeaderKeys).toContain("x-client-transaction-id");

        // Synthetic marker must be set so we can distinguish from natural captures.
        expect(replay?.replayIsSynthetic).toBe(true);

        // The _queryId debug field should match.
        expect(replay?.replayQueryId).toBe(FAKE_QUERY_ID);
    });

    it("handles reversed operationName-first ordering in bundle JS", async function () {
        // 1. Navigate to about:blank for a clean JS context.
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            wv.loadURL("about:blank");
        }, PLUGIN_ID);

        await browser.waitUntil(
            async () => {
                const snap = await snapshotReplay();
                return snap !== null;
            },
            { timeout: 10_000, interval: 250 },
        );

        // Bundle JS with the reversed pattern: operationName first, then queryId.
        const reversedBundleJs = `var x={operationName:"TweetResultByRestId",queryId:"${FAKE_QUERY_ID}"};`;
        const reversedBundleUrl = `https://abs.twimg.com/responsive-web/client-web/main.REVERSED123.js`;
        const reversedRootHtml = `<!DOCTYPE html><html><head><script src="${reversedBundleUrl}"></script></head><body></body></html>`;

        const installResult = await runInWebview<string>(
            "(function(){" +
                "try {" +
                "var origFetch = window.fetch.bind(window);" +
                "window.fetch = function(url, init) {" +
                "var u = typeof url === 'string' ? url : (url && url.url) || '';" +
                "if (u === 'https://x.com/') {" +
                "return Promise.resolve(new Response(" + JSON.stringify(reversedRootHtml) + ", {" +
                "status: 200, headers: {'content-type':'text/html'}" +
                "}));" +
                "}" +
                "if (u === " + JSON.stringify(reversedBundleUrl) + ") {" +
                "return Promise.resolve(new Response(" + JSON.stringify(reversedBundleJs) + ", {" +
                "status: 200, headers: {'content-type':'application/javascript'}" +
                "}));" +
                "}" +
                "return origFetch(url, init);" +
                "};" +
                PROBE_SOURCE +
                "window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay = {" +
                "url: 'https://x.com/i/api/graphql/HASH/TweetDetail?variables={}', " +
                "headers: { 'authorization': 'Bearer reversed-test', 'x-client-transaction-id': 'reversed-tx' }, " +
                "recordedAt: Date.now()" +
                "};" +
                "return 'ok';" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(installResult).toBe("ok");

        const extractResult = await runInWebview<ExtractionResult>(EXTRACTION_SCRIPT);
        // eslint-disable-next-line no-console
        console.log("[extraction-test reversed] extractResult:", JSON.stringify(extractResult));

        expect(extractResult?.ok).toBe(true);
        expect(extractResult?.queryId).toBe(FAKE_QUERY_ID);

        const replay = await snapshotReplay();
        expect(replay?.replaySet).toBe(true);
        expect(replay?.replayUrl).toContain(FAKE_QUERY_ID);
        expect(replay?.replayIsSynthetic).toBe(true);
    });

    it("returns no-tweet-detail-replay when tweetDetailReplay is missing", async function () {
        // 1. Navigate to about:blank for a clean JS context.
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            wv.loadURL("about:blank");
        }, PLUGIN_ID);

        await browser.waitUntil(
            async () => {
                const snap = await snapshotReplay();
                return snap !== null;
            },
            { timeout: 10_000, interval: 250 },
        );

        // Inject probe but do NOT set tweetDetailReplay.
        const installResult = await runInWebview<string>(
            "(function(){" +
                "try {" +
                PROBE_SOURCE +
                // Explicitly ensure tweetDetailReplay is absent.
                "delete window.__TWITTER_BOOKMARK_SPIKE__.tweetDetailReplay;" +
                "return 'ok';" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(installResult).toBe("ok");

        const extractResult = await runInWebview<ExtractionResult>(EXTRACTION_SCRIPT);
        // eslint-disable-next-line no-console
        console.log("[extraction-test no-detail] extractResult:", JSON.stringify(extractResult));

        expect(extractResult?.ok).toBe(false);
        expect(extractResult?.reason).toBe("no-tweet-detail-replay");

        // articleResultReplay must NOT be set.
        const replay = await snapshotReplay();
        expect(replay?.replaySet).toBe(false);
    });
});
