/**
 * Live Instagram API discovery probe — runs against REAL instagram.com using
 * injected session cookies.
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * `instagram-discovery.js` is a fetch/XHR-observing probe (spike). Unit tests
 * confirm the probe mechanics, but only a live run reveals the real URL shapes,
 * response field paths, and pagination contract — which is what we need before
 * committing to a data model for Phase 2.
 *
 * ONE run with your cookies does both jobs at once:
 *   • CAPTURE — navigates to the Saved page and scrolls to trigger pagination;
 *     writes every observed API call (URL, method, headers, status, respSample)
 *     to tests/e2e/.ig-discovery-capture.json (gitignored).
 *   • ASSERT  — checks that at least one call was recorded, has status 200, and
 *     has a JSON-parseable respSample. This confirms the probe is intercepting
 *     API responses rather than CDN media.
 *
 * The assertion test skips gracefully if no API calls are captured — increase
 * NAVIGATE_SETTLE_MS or scroll more passes if that happens.
 *
 * HOW TO RUN
 * ----------
 * 1. Export your instagram.com cookies as an array of { name, value, domain, path }
 *    objects. Any cookie-manager browser extension (EditThisCookie, Cookie-Editor)
 *    works. You need at minimum: sessionid, csrftoken, ds_user_id.
 *    Save to:  tests/e2e/.ig-cookies.json   (gitignored — never commit)
 *
 * 2. Run:
 *    E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
 *      --spec tests/e2e/90-instagram-discovery.live.spec.ts
 *
 * 3. Inspect the capture:
 *      tests/e2e/.ig-discovery-capture.json
 *    It contains every observed API call with full URL, method, status, auth
 *    headers, and a 4 KB respSample. Use the `summary.distinctEndpoints` array
 *    and `observedCalls[N].respSampleHead` to identify field paths, then commit
 *    to a data model for Phase 2.
 *
 * This spec is EXCLUDED from the default suite (needs real credentials + network).
 */

import { browser } from "@wdio/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    summarizeFindings,
    type ObservedCall,
} from "../../packages/core/src/sync/instagram-discovery";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = "roost";
const WEBVIEW_KEY = "instagram";
const WEBVIEW_READY_TIMEOUT_MS = 60_000;
const OBSERVED_CALLS_TIMEOUT_MS = 60_000;
/** Pause after navigation before scrolling — let the SPA render and fire initial API calls. */
const NAVIGATE_SETTLE_MS = 5_000;

const COOKIES_PATH = path.join(__dirname, ".ig-cookies.json");
const CAPTURE_PATH = path.join(__dirname, ".ig-discovery-capture.json");
const FIXTURE_VAULT = path.resolve(__dirname, "../fixtures/vault");
const PROBE_PATH = path.resolve(
    __dirname,
    "../../packages/core/src/probes/instagram-discovery.js",
);

/**
 * Saved page — the primary surface for discovering the API shape. For a logged-in
 * account this is /<username>/saved/ (a grid of COLLECTIONS), NOT /explore/saved/
 * (which redirects to /explore/ for most accounts). Username is account-specific,
 * so it comes from ROOST_IG_SAVED_URL rather than being hardcoded in the repo.
 */
const SAVED_POSTS_URL =
    process.env.ROOST_IG_SAVED_URL?.trim() || "https://www.instagram.com/explore/saved/";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function runInWebview<T = unknown>(js: string): Promise<T | null> {
    const raw = await browser.executeObsidian(
        async ({ app }, pluginId, webviewKey, src) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement(webviewKey) as any;
            if (!wv) return null;
            try { return await wv.executeJavaScript(src); }
            catch (err) { return { __error: String(err) }; }
        },
        PLUGIN_ID,
        WEBVIEW_KEY,
        js,
    );
    return (raw as T) ?? null;
}

async function ensureWebviewReady(): Promise<void> {
    await browser.executeObsidian(({ app }, pluginId, webviewKey) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plugin = (app as any).plugins.plugins[pluginId];
        if (!plugin) throw new Error(`plugin ${pluginId} not loaded`);
        const wm = plugin.getWebviewManager();
        const container: HTMLElement = wm.getContainer();
        if (!container.parentElement) {
            container.style.cssText = "position: fixed; inset: 0; z-index: 99999;";
            document.body.appendChild(container);
        }
        // NB: production (getWebviewManager) only create()s ENABLED platforms.
        // This discovery spec deliberately creates the disabled-but-registered
        // instagram webview directly — relies on create() not enforcing `enabled`.
        wm.create(webviewKey);
    }, PLUGIN_ID, WEBVIEW_KEY);

    await browser.waitUntil(
        async () =>
            browser.executeObsidian(({ app }, pluginId, webviewKey) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const plugin = (app as any).plugins.plugins[pluginId];
                const wm = plugin?.getWebviewManager?.();
                return wm ? wm.getWebContents(webviewKey) !== null : false;
            }, PLUGIN_ID, WEBVIEW_KEY),
        {
            timeout: WEBVIEW_READY_TIMEOUT_MS,
            timeoutMsg: "instagram webview never became ready (webContentsId stayed null)",
            interval: 500,
        },
    );
}

/**
 * Re-inject the probe (clears any previous store) and navigate to `url`.
 * The probe is also re-injected on every subsequent `dom-ready` so SPA
 * navigations within the same webview are covered.
 */
async function injectProbeAndNavigate(url: string, probeSource: string): Promise<void> {
    await browser.executeObsidian(
        async ({ app }, pluginId, webviewKey, target, probeSrc) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement(webviewKey) as any;
            const reinject = () => {
                wv.executeJavaScript(
                    "try { delete window.__INSTAGRAM_DISCOVERY__; } catch(e) {}\n" +
                        "try { " + probeSrc + " } catch(e) {}\nvoid 0;",
                ).catch(() => {});
            };
            if (!wv.__roostIgReinject) {
                wv.addEventListener("dom-ready", reinject);
                wv.__roostIgReinject = reinject;
            }
            reinject();
            wv.loadURL(target);
        },
        PLUGIN_ID,
        WEBVIEW_KEY,
        url,
        probeSource,
    );

    await browser.waitUntil(
        async () => {
            const href = await runInWebview<string>("location.href");
            return typeof href === "string" && href.includes("instagram.com");
        },
        { timeout: WEBVIEW_READY_TIMEOUT_MS, timeoutMsg: `webview never reached ${url}`, interval: 500 },
    );
    await browser.pause(NAVIGATE_SETTLE_MS);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Instagram API discovery — live (real instagram.com, cookie injection)", function () {
    this.timeout(300_000);

    let probeSource = "";
    /** Populated by the diagnostic test; consumed by the shape-assertion test. */
    let capturedCalls: ObservedCall[] = [];

    before(async function () {
        if (!fs.existsSync(COOKIES_PATH)) {
            // eslint-disable-next-line no-console
            console.warn(
                "\n[live-spec] SKIPPED: tests/e2e/.ig-cookies.json not found.\n" +
                "  1. Export your instagram.com cookies (DevTools → Application → Cookies,\n" +
                "     or a cookie-manager extension) as a JSON array of\n" +
                "     { name, value, domain, path } objects. You need at minimum:\n" +
                "     sessionid, csrftoken, ds_user_id.\n" +
                "  2. Save to tests/e2e/.ig-cookies.json\n" +
                "  3. Re-run:\n" +
                "     E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \\\n" +
                "       --spec tests/e2e/90-instagram-discovery.live.spec.ts\n",
            );
            this.skip();
            return;
        }

        let cookies: unknown[];
        try {
            cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf-8"));
        } catch (e) {
            throw new Error(`Failed to parse .ig-cookies.json: ${String(e)}`);
        }
        if (!Array.isArray(cookies) || cookies.length === 0) {
            throw new Error(".ig-cookies.json is empty or not an array — re-export cookies.");
        }

        probeSource = fs.readFileSync(PROBE_PATH, "utf-8");

        await browser.reloadObsidian({ vault: FIXTURE_VAULT });
        await ensureWebviewReady();

        // Inject cookies into the Instagram webview's Electron session before navigation.
        const injectResult = await browser.executeObsidian(
            async ({ app }, pluginId, webviewKey, cookiesJson) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const plugin = (app as any).plugins.plugins[pluginId];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const wv = plugin.getWebviewManager().getElement(webviewKey) as any;
                if (!wv) return { ok: false, reason: "webview-null" };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let remote: any;
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    remote = (globalThis as any).require("@electron/remote");
                } catch (e) {
                    return { ok: false, reason: `remote-unavailable: ${String(e)}` };
                }
                const wc = remote.webContents.fromId(wv.getWebContentsId());
                if (!wc) return { ok: false, reason: "webcontents-null" };
                const list: unknown[] = JSON.parse(cookiesJson);
                let set = 0, failed = 0;
                for (const c of list) {
                    try { await wc.session.cookies.set(c as never); set++; }
                    catch { failed++; }
                }
                return { ok: true, set, failed };
            },
            PLUGIN_ID,
            WEBVIEW_KEY,
            JSON.stringify(cookies),
        );

        // eslint-disable-next-line no-console
        console.log("[live-spec] cookie injection:", JSON.stringify(injectResult));
        if (!(injectResult as { ok: boolean }).ok) {
            throw new Error(
                `Cookie injection failed: ${(injectResult as { reason?: string }).reason}`,
            );
        }
        if (((injectResult as { set?: number }).set ?? 0) === 0) {
            throw new Error("No cookies were injected — check .ig-cookies.json format.");
        }

        // Navigate and confirm authentication.
        await injectProbeAndNavigate(SAVED_POSTS_URL, probeSource);
        const authCheck = await runInWebview<{ url: string; hasLoginPrompt: boolean }>(`
            (function() {
                return {
                    url: location.href,
                    hasLoginPrompt: document.title.toLowerCase().includes("log in") ||
                                    !!document.querySelector('input[name="username"]')
                };
            })()
        `);
        // eslint-disable-next-line no-console
        console.log("[live-spec] auth check:", JSON.stringify(authCheck));
        if ((authCheck as { hasLoginPrompt?: boolean })?.hasLoginPrompt) {
            throw new Error(
                "Instagram webview shows a login prompt after cookie injection — " +
                "cookies may be expired or in the wrong format. " +
                "Re-export (sessionid expires ~1 year; csrftoken rotates more often) and retry.",
            );
        }
    });

    it("captures all observed Instagram API calls (diagnostic — always passes)", async function () {
        // Fresh navigation so the probe counter starts at 0.
        await injectProbeAndNavigate(SAVED_POSTS_URL, probeSource);

        // Scroll three times to trigger pagination API calls.
        for (let i = 0; i < 3; i++) {
            await runInWebview("window.scrollTo(0, document.body.scrollHeight)");
            await browser.pause(2_000);
        }

        // Best-effort: wait for an isApi()-matched call, but DON'T fail the run if
        // none arrive — the capture (incl. the allUrls diagnostic) is written either
        // way so we can tune isApi()/the saved URL from the real traffic.
        try {
            await browser.waitUntil(
                async () => {
                    const n = await runInWebview<number>(
                        "(window.__INSTAGRAM_DISCOVERY__?.observedCalls?.length || 0)",
                    );
                    return typeof n === "number" && n > 0;
                },
                { timeout: OBSERVED_CALLS_TIMEOUT_MS, timeoutMsg: "no isApi match", interval: 1_000 },
            );
        } catch {
            // eslint-disable-next-line no-console
            console.warn("[live-spec] no isApi()-matched call within timeout — writing diagnostic capture anyway.");
        }

        // Pull the full store snapshot (incl. the allUrls diagnostic ring buffer).
        const raw = await runInWebview<string>(`
            (function() {
                var s = window.__INSTAGRAM_DISCOVERY__ || {};
                return JSON.stringify({
                    observedCalls: s.observedCalls || [],
                    allUrls:       s.allUrls       || [],
                    fetchCalls:    s.fetchCalls    || 0,
                    xhrCalls:      s.xhrCalls      || 0
                });
            })()
        `);

        type SeenUrl = { via: string; method: string; url: string; api: boolean };
        let parsed: { observedCalls: ObservedCall[]; allUrls: SeenUrl[]; fetchCalls: number; xhrCalls: number } =
            { observedCalls: [], allUrls: [], fetchCalls: 0, xhrCalls: 0 };
        try { parsed = JSON.parse(raw || "{}"); } catch { /* best-effort */ }

        capturedCalls = parsed.observedCalls;
        const findings = summarizeFindings(capturedCalls);
        const landedUrl = await runInWebview<string>("location.href");

        // Distinct host+path rollup of ALL seen URLs — the key signal for tuning
        // isApi() and spotting the real saved/collections endpoints.
        const seen = new Map<string, { via: string; method: string; api: boolean; count: number; example: string }>();
        for (const u of parsed.allUrls) {
            let key = u.url;
            try { const x = new URL(u.url); key = x.host + x.pathname; } catch { /* keep raw */ }
            const e = seen.get(key) || { via: u.via, method: u.method, api: u.api, count: 0, example: u.url };
            e.count++; seen.set(key, e);
        }
        const allUrlsSummary = [...seen.entries()].map(([hostPath, v]) => ({ hostPath, ...v }));

        // Write the full durable capture artifact (always — even with zero matches).
        fs.writeFileSync(
            CAPTURE_PATH,
            JSON.stringify(
                {
                    capturedAt: new Date().toISOString(),
                    landedUrl,
                    probeCounters: { fetchCalls: parsed.fetchCalls, xhrCalls: parsed.xhrCalls, allUrlsSeen: parsed.allUrls.length },
                    summary: {
                        totalObserved: findings.totalObserved,
                        apiCalls: findings.apiCalls,
                        distinctEndpoints: findings.endpoints.map((e) => ({
                            method: e.method,
                            path: e.path,
                            count: e.count,
                            exampleUrl: e.exampleUrl,
                            authHeaders: e.authHeaders,
                            exampleQuery: e.exampleQuery,
                            respSampleHead: e.respSampleHead,
                        })),
                    },
                    // Every request URL the probe saw (regardless of isApi) — tuning signal.
                    allUrlsSummary,
                    observedCalls: capturedCalls,
                    allUrls: parsed.allUrls,
                },
                null,
                2,
            ),
        );

        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] landed on ${landedUrl}\n` +
            `[live-spec] probe counters: fetch=${parsed.fetchCalls}, xhr=${parsed.xhrCalls}, ` +
            `allUrlsSeen=${parsed.allUrls.length}, isApiMatched=${findings.apiCalls}`,
        );
        for (const u of allUrlsSummary.slice(0, 30)) {
            // eslint-disable-next-line no-console
            console.log(`  [${u.via}${u.api ? " API" : "    "}] ${u.method} ${u.hostPath}  ×${u.count}`);
        }
        // eslint-disable-next-line no-console
        console.log(`[live-spec] capture written to ${CAPTURE_PATH}`);

        // Gate on INTERCEPTION, not isApi: if the probe saw ANY request the wiring
        // works (then tune isApi() from allUrlsSummary). If this is 0, the probe
        // isn't intercepting at all → needs earlier injection or CDP-layer capture.
        expect(parsed.fetchCalls + parsed.xhrCalls).toBeGreaterThan(0);
    });

    it("shape: at least one API call has status 200 and a JSON-parseable respSample", async function () {
        if (capturedCalls.length === 0) {
            // eslint-disable-next-line no-console
            console.warn(
                "[live-spec] No API calls in capturedCalls — diagnostic test may have timed out. " +
                "Check whether isApi() (url.indexOf('instagram.com') + /api/ or /graphql) " +
                "matches the actual URLs Instagram is using; see .ig-discovery-capture.json.",
            );
            this.skip();
            return;
        }

        const ok200 = capturedCalls.filter((c) => c.status === 200);
        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] shape: ${ok200.length} / ${capturedCalls.length} calls have status 200`,
        );
        expect(ok200.length).toBeGreaterThan(0);

        const withSample = ok200.filter((c) => c.respSample && c.respSample.length > 0);
        // eslint-disable-next-line no-console
        console.log(`[live-spec] shape: ${withSample.length} of those have a non-empty respSample`);
        expect(withSample.length).toBeGreaterThan(0);

        // At least one respSample must parse as JSON — confirms the probe is
        // intercepting API responses, not binary media or HTML.
        // If this fails, isApi() is letting non-JSON responses through or
        // clone().text() is returning garbled bytes (unlikely — all IG API responses are UTF-8 JSON).
        const jsonSamples = withSample.filter((c) => {
            try { JSON.parse(c.respSample!); return true; } catch { return false; }
        });
        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] shape: ${jsonSamples.length} have a JSON-parseable respSample. ` +
            (jsonSamples[0]
                ? `Top-level keys: ${Object.keys(JSON.parse(jsonSamples[0].respSample!)).slice(0, 10).join(", ")}`
                : "(none — check .ig-discovery-capture.json)"),
        );
        expect(jsonSamples.length).toBeGreaterThan(0);
    });
});
