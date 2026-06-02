/**
 * Full-chain article backfill regression — fetcher → parser → vault.
 *
 * Proves the wiring from `runArticleBackfill` through `ArticleFetcher` →
 * probe → parser → `VaultWriter.rewriteNoteBody` against synthesized-but-
 * realistic Twitter data.
 *
 * Two tests:
 *
 *   1. Fast path — `articleResultReplay` pre-set in the probe store. The
 *      backfill skips SPA-nav bootstrap, fires a mocked fetch, reads
 *      content_state from tweetCache, merges into raw.json, and re-renders
 *      the note body.
 *
 *   2. Bootstrap path (skipped for stability) — only `anyAuthGraphqlReplay`
 *      pre-set. The backfill would SPA-nav-bootstrap, time out, fall back to
 *      queryId extraction, then fetch. This path is left as `.skip` because
 *      the SPA-nav attempt fires `history.pushState` inside the webview which
 *      can invalidate injected mocks depending on Electron's navigation state
 *      machine — too flaky to run in CI without a dedicated harness that
 *      re-injects on every dom-ready.
 *
 * Setup note: the replayScript in ArticleFetcher calls `new URL(replay.url)`
 * with no base argument. This is required because on `about:blank` the page
 * origin is the string "null" which Electron/Chromium treats as an invalid
 * base URL (Chrome 120). In production the webview is always on https://x.com
 * so this never arises; the fix is a small production-safe change to the
 * replayScript (see article-fetcher.ts).
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

// ─── Fake tweet ID — must not collide with real bookmarks ─────────────────────
const FAKE_TWEET_ID = "9999999999999999001";

// Content state with 3 blocks: header + 2 paragraphs. The rendered body has
// recognisable structure we can assert on in the final note.
const FAKE_CONTENT_STATE = {
    blocks: [
        {
            key: "blk1",
            type: "header-one",
            text: "E2E Test Article",
            depth: 0,
            inlineStyleRanges: [],
            entityRanges: [],
        },
        {
            key: "blk2",
            type: "unstyled",
            text: "This is the first paragraph of the article body.",
            depth: 0,
            inlineStyleRanges: [],
            entityRanges: [],
        },
        {
            key: "blk3",
            type: "unstyled",
            text: "This is the second paragraph with more content.",
            depth: 0,
            inlineStyleRanges: [],
            entityRanges: [],
        },
    ],
    entityMap: [],
};

// Full TweetResultByRestId response that the mocked fetch returns, including
// content_state so the ArticleFetcher.fetchOne succeeds.
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
                            core: { name: "Fake Author", screen_name: "fakeauthor" },
                            legacy: {},
                        },
                    },
                },
                legacy: {
                    id_str: FAKE_TWEET_ID,
                    full_text: "Stub tweet text for e2e test",
                    conversation_id_str: FAKE_TWEET_ID,
                },
                article: {
                    article_results: {
                        result: {
                            id: "art_fake_e2e",
                            rest_id: FAKE_TWEET_ID,
                            title: "E2E Test Article",
                            preview_text: "This is a preview of the e2e test article.",
                            cover_media: {
                                media_info: {
                                    original_img_url: "https://pbs.twimg.com/media/fake-cover-e2e.jpg",
                                },
                            },
                            metadata: { first_published_at_secs: 1714492800 },
                            content_state: FAKE_CONTENT_STATE,
                        },
                    },
                },
            },
        },
    },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Test 1: Fast path — articleResultReplay pre-set ──────────────────────────

describe("X article backfill — full-chain (fast path)", function () {
    this.timeout(120_000);

    let vaultRoot = "";
    let rawJsonPath = "";
    let notePath = "";
    let cachePath = "";

    // Original raw.json (stub, no content_state) — used to restore after the test.
    const originalRawJson = JSON.stringify(
        JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname, "../fixtures/vault/Bookmarks/X/twitter-9999999999999999001/raw.json"),
                "utf-8",
            ),
        ),
        null,
        2,
    );

    const stubNoteContent = [
        "---",
        `roost_id: "twitter:${FAKE_TWEET_ID}"`,
        `title: "Stub tweet text for e2e test"`,
        `platform: "twitter"`,
        `author: "[[People/@fakeauthor]]"`,
        `url: "https://x.com/fakeauthor/status/${FAKE_TWEET_ID}"`,
        `is_article: true`,
        `article_title: "E2E Test Article"`,
        `article_fetch_failed: true`,
        `article_published_at: "2024-04-30T16:00:00.000Z"`,
        `tags: ["twitter"]`,
        "---",
        "",
        "# E2E Test Article",
        "",
        "![cover](https://pbs.twimg.com/media/fake-cover-e2e.jpg)",
        "",
        "> This is a preview of the e2e test article.",
        "",
        "*Article body not yet fetched.*",
        "",
    ].join("\n");

    before(async function () {
        // 1. Ensure the X webview is live so the backfill's WebviewManager lookup succeeds.
        await ensureWebviewReady();

        // 2. Resolve vault root (wdio-obsidian-service works in a snapshot copy).
        vaultRoot = await browser.executeObsidian(({ app }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const adapter = app.vault.adapter as any;
            return String(adapter.basePath ?? adapter.getBasePath?.() ?? "");
        }) as string;

        rawJsonPath = path.join(vaultRoot, "Bookmarks", "X", `twitter-${FAKE_TWEET_ID}`, "raw.json");
        notePath = path.join(vaultRoot, "Bookmarks", "X", `@fakeauthor - ${FAKE_TWEET_ID}.md`);
        cachePath = path.join(vaultRoot, ".roost", "article-fetch-cache.json");

        // 3. Ensure the fixture files exist in the live snapshot vault.
        //    wdio-obsidian-service copies the fixture vault; the directories should
        //    already be there, but we create them defensively.
        const attachDir = path.join(vaultRoot, "Bookmarks", "X", `twitter-${FAKE_TWEET_ID}`);
        if (!fs.existsSync(attachDir)) {
            fs.mkdirSync(attachDir, { recursive: true });
        }
        fs.writeFileSync(rawJsonPath, originalRawJson, "utf-8");

        if (!fs.existsSync(notePath)) {
            fs.writeFileSync(notePath, stubNoteContent, "utf-8");
        }

        // 4. Clear any leftover article-fetch-cache entry so the backfill doesn't skip.
        if (fs.existsSync(cachePath)) {
            try {
                const c = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                if (c[FAKE_TWEET_ID]) {
                    delete c[FAKE_TWEET_ID];
                    fs.writeFileSync(cachePath, JSON.stringify(c, null, 2));
                }
            } catch { /* ignore parse errors */ }
        }

        // 5. Navigate webview to about:blank for a clean JS context.
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            wv.loadURL("about:blank");
        }, PLUGIN_ID);

        await browser.waitUntil(
            async () => {
                const url = await runInWebview<string>("location.href");
                return url === "about:blank";
            },
            { timeout: 10_000, timeoutMsg: "webview never reached about:blank", interval: 250 },
        );

        // 6. Install mock fetch first (probe captures window.fetch at injection time
        //    as nativeFetch — so mock must come before probe injection), then inject
        //    the probe, then pre-populate articleResultReplay.
        //
        //    Mock intercepts: any /i/api/graphql/.../TweetResultByRestId URL →
        //    returns FAKE_RESPONSE_BODY (with content_state).
        //
        //    articleResultReplay pre-set: ensureReplayReady() finds it immediately
        //    and skips the SPA-nav bootstrap, so the backfill proceeds straight
        //    to fetchOne → replayScript → mocked fetch → tweetCache → merge.
        //
        //    NOTE: ArticleFetcher.replayScript uses `new URL(replay.url)` (no base
        //    arg) so it works on about:blank where location.origin === "null".
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
                PROBE_SOURCE +
                "window.__TWITTER_BOOKMARK_SPIKE__.articleResultReplay = {" +
                "url: 'https://x.com/i/api/graphql/FAKEHASH/TweetResultByRestId?variables=%7B%7D&features=%7B%7D&fieldToggles=%7B%7D'," +
                "headers: { 'authorization': 'Bearer e2e-test-token', 'x-client-transaction-id': 'e2e-tx-id' }," +
                "recordedAt: Date.now()," +
                "_synthetic: true," +
                "_queryId: 'FAKEHASH'" +
                "};" +
                "return 'ok';" +
                "} catch(e) { return 'err:' + String(e); }" +
                "})();",
        );
        expect(installResult).toBe("ok");
    });

    after(async function () {
        // Restore raw.json and note to stub state so subsequent runs are not skipped.
        try {
            if (fs.existsSync(rawJsonPath)) {
                fs.writeFileSync(rawJsonPath, originalRawJson, "utf-8");
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[full-chain] cleanup: could not restore raw.json:", e);
        }
        try {
            if (fs.existsSync(notePath)) {
                fs.writeFileSync(notePath, stubNoteContent, "utf-8");
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[full-chain] cleanup: could not restore note:", e);
        }
        // Remove the fake tweet entry from the article-fetch-cache.
        try {
            if (fs.existsSync(cachePath)) {
                const c = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                if (c[FAKE_TWEET_ID]) {
                    delete c[FAKE_TWEET_ID];
                    fs.writeFileSync(cachePath, JSON.stringify(c, null, 2));
                }
            }
        } catch { /* best-effort */ }
    });

    it("fetchOne → walkAndCache → mergeArticleContent → rewriteNoteBody produces rendered article note", async function () {
        // ── Trigger the backfill ─────────────────────────────────────────────
        // Run via the registered Obsidian command and await the async callback
        // so executeObsidian waits for the full backfill to complete before
        // returning. runArticleBackfill():
        //   • walks Bookmarks/X for raw.json files without content_state
        //   • finds our fixture (no content_state in stub raw.json)
        //   • calls fetchMany → fetchOne → replayScript
        //   • replayScript calls window.fetch (intercepted by our mock) → 200
        //   • probe's walkAndCache puts the tweet into tweetCache
        //   • fetchOne reads tweetCache[tweetId], verifies content_state present
        //   • backfill merges content_state into raw.json on disk
        //   • rewriteNoteBody re-renders the note body via vault.modify
        //   • writes success entry to .roost/article-fetch-cache.json
        const backfillResult = await browser.executeObsidian(async ({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cmds = (app as any).commands;
            const id = `${pluginId}:backfill-x-articles`;
            const cmd = cmds.commands[id];
            if (!cmd) return { ok: false, reason: "command-not-found" };
            try {
                await cmd.callback();
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: String(e) };
            }
        }, PLUGIN_ID);
        // eslint-disable-next-line no-console
        console.log("[full-chain] backfillResult:", JSON.stringify(backfillResult));
        expect((backfillResult as { ok: boolean }).ok).toBe(true);

        // Give vault.modify a moment to flush to disk after the backfill.
        await browser.pause(500);

        const noteContent = fs.existsSync(notePath)
            ? fs.readFileSync(notePath, "utf-8")
            : null;

        // eslint-disable-next-line no-console
        console.log("[full-chain] note content (first 600 chars):\n" +
            (noteContent ? noteContent.slice(0, 600) : "(not found)"));

        // ── Assert: raw.json has content_state ──────────────────────────────
        expect(fs.existsSync(rawJsonPath)).toBe(true);
        const rawParsed = JSON.parse(fs.readFileSync(rawJsonPath, "utf-8"));
        const articleResult = rawParsed?.article?.article_results?.result;
        expect(articleResult).toBeDefined();
        expect(articleResult?.content_state).toBeDefined();
        expect(Array.isArray(articleResult?.content_state?.blocks)).toBe(true);
        expect(articleResult.content_state.blocks.length).toBeGreaterThan(0);

        // ── Assert: note body contains the rendered article ──────────────────
        expect(noteContent).not.toBeNull();
        // renderArticleNoteBody emits: "# E2E Test Article\n\n![cover](...)\n\n{body}"
        // where {body} starts with the header-one block rendered as "# E2E Test Article".
        expect(noteContent).toContain("# E2E Test Article");
        // The two unstyled paragraph blocks must appear in the note.
        expect(noteContent).toContain("first paragraph");
        expect(noteContent).toContain("second paragraph");
        // The stub sentinel must be gone.
        expect(noteContent).not.toContain("*Article body not yet fetched.*");

        // ── Assert: is_article frontmatter preserved ─────────────────────────
        // rewriteNoteBody only rewrites the body — frontmatter is preserved
        // as-is. The stub note has is_article: true from its initial frontmatter.
        expect(noteContent).toContain("is_article: true");

        // ── Assert: article-fetch-cache has a success entry ──────────────────
        expect(fs.existsSync(cachePath)).toBe(true);
        const cacheContent = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        const cacheEntry = cacheContent[FAKE_TWEET_ID];
        expect(cacheEntry).toBeDefined();
        expect(cacheEntry.ok).toBe(true);
        expect(typeof cacheEntry.fetchedAt).toBe("number");
        // wordCount reflects the 3-block content: header (~3 words) + 2 paragraphs (~16 words)
        expect(typeof cacheEntry.wordCount).toBe("number");
        expect(cacheEntry.wordCount).toBeGreaterThan(0);

        // eslint-disable-next-line no-console
        console.log("[full-chain] PASS — cache entry:", JSON.stringify(cacheEntry));
    });
});

// ─── Test 2: Bootstrap path — anyAuthGraphqlReplay pre-set ────────────────────
//
// This test would exercise the full bootstrap path: SPA-nav times out, the
// queryId extraction script fires, synthesizes articleResultReplay, then
// fetchOne succeeds.
//
// SKIPPED: The SPA-nav attempt calls `history.pushState` inside the webview
// which can navigate away from about:blank and invalidate injected mocks. A
// stable version requires re-injecting mocks on every dom-ready event (the
// pattern from 70-twitter-thread-bootstrap.spec.ts second test). That harness
// work is deferred — this skeleton documents the intent and expected structure.

describe("X article backfill — full-chain (bootstrap path)", function () {
    this.timeout(120_000);

    it.skip(
        "anyAuthGraphqlReplay → extraction → fetchOne → vault (skipped: SPA-nav invalidates injected mocks without dom-ready re-injection)",
        async function () {
            // To stabilise this test, apply the dom-ready re-injection pattern from
            // 70-twitter-thread-bootstrap.spec.ts:
            //
            //   wv.addEventListener("dom-ready", reinjectMocksAndProbe);
            //
            // Setup:
            //   1. Pre-populate anyAuthGraphqlReplay (NOT articleResultReplay).
            //   2. Mock fetch for:
            //      - https://x.com/ → HTML with fake main bundle <script src>
            //      - https://abs.twimg.com/...main.FAKEHASH.js
            //        → JS with {queryId:"TEST_EXTRACTED_QID",operationName:"TweetResultByRestId"}
            //      - TweetResultByRestId URLs → FAKE_RESPONSE_BODY with content_state
            //   3. Trigger backfill. The 8s SPA-nav timeout fires, extractionScript
            //      runs, synthesizes articleResultReplay from the bundle, fetchOne
            //      succeeds.
            //   4. Assert same outcomes as Test 1.
            throw new Error("not implemented — see comment above");
        },
    );
});
