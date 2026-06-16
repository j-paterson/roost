/**
 * Live-X bookmark folders — runs against REAL x.com using injected session cookies.
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The bookmark-folders feature (branch worktree-agent-ad72a36f9e3095edc) was
 * BLOCKED because the probe (twitter-probe.js) and sync navigation
 * (twitter-sync.ts) contain SIX guesses about X's GraphQL contract, each marked
 * `NEEDS LIVE VERIFICATION`:
 *
 *   1. op names           — "BookmarkFolders" / "BookmarkFolderTimeline"
 *   2. folder-list shape  — data.bookmark_folder_timeline… vs data.bookmark_folders
 *   3. folder id/name path — bookmark_collection_results.result.rest_id / .name
 *   4. URL variables key   — bookmark_collection_id / bookmarkCollectionId / folder_id
 *   5. folder nav URL      — x.com/i/bookmarks/<id>
 *   6. timeline behaviour  — does the folder timeline op fire on navigation
 *
 * A unit test cannot verify those — only a real response can. This spec is that
 * instrument. ONE run with your cookies does both jobs at once:
 *   • VERIFY  — if every guess is right, the assertion tests pass → branch proven.
 *   • CORRECT — if a guess is wrong, the diagnostic test still captures the REAL
 *               op names, response JSON, field paths, and `variables` keys to
 *               tests/e2e/.x-bookmark-folders-capture.json (gitignored), so the
 *               probe can be corrected and the spec re-run.
 *
 * This is EXCLUDED from the default suite (it needs real credentials + network).
 *
 * HOW TO RUN
 * ----------
 * 1. In production Obsidian: Cmd+P → "Export X session cookies"
 *    Paste the clipboard output into  tests/e2e/.x-cookies.json
 *    (never commit this file — it is in .gitignore)
 *
 * 2. Make sure the logged-in X account has AT LEAST ONE bookmark folder with at
 *    least one bookmark in it. Without a folder the assertion tests skip.
 *
 * 3. Run:
 *    E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
 *      --spec tests/e2e/87-x-bookmark-folders.live.spec.ts
 *
 * It uses the wdio-managed isolated fixture vault (tests/fixtures/vault) — your
 * real vault is never touched.
 */

import { browser } from "@wdio/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = "roost";
const WEBVIEW_READY_TIMEOUT_MS = 60_000;
const OBSERVED_OPS_TIMEOUT_MS = 60_000;
const FOLDER_NAV_TIMEOUT_MS = 30_000;

const COOKIES_PATH = path.join(__dirname, ".x-cookies.json");
const CAPTURE_PATH = path.join(__dirname, ".x-bookmark-folders-capture.json");
const FIXTURE_VAULT = path.resolve(__dirname, "../fixtures/vault");
const PROBE_PATH = path.resolve(
    __dirname,
    "../../packages/core/src/probes/twitter-probe.js",
);

// ─── Probe store types (subset we read) ─────────────────────────────────────────

interface ObservedOp { op: string; method: string; status: number; at: number; }
interface FolderDebugEntry {
    op: string;
    method: string;
    status: number;
    dataKeys: string[];
    variablesRaw: string | null;
    variablesParsed: unknown;
    rawSample: string | null;
    at: number;
}

// Cross-`it` state captured by the diagnostic phase.
let observedOps: ObservedOp[] = [];
let folderDebug: FolderDebugEntry[] = [];
let bookmarkFolders: Record<string, string> = {};

// ─── Helpers (mirrors 86-x-article-real-backfill.live.spec.ts) ──────────────────

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

/** Re-inject the probe (idempotent) and navigate to a URL, waiting for the page. */
async function injectProbeAndNavigate(url: string, probeSource: string): Promise<void> {
    await browser.executeObsidian(
        async ({ app }, pluginId, target, probeSrc) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pluginId];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = plugin.getWebviewManager().getElement("twitter") as any;
            const reinject = () => {
                wv.executeJavaScript(
                    "try { delete window.__TWITTER_BOOKMARK_SPIKE__; } catch(e) {}\n" +
                        "try { " + probeSrc + " } catch(e) {}\nvoid 0;",
                ).catch(() => {});
            };
            // Re-inject on every navigation (loadURL replaces the document).
            if (!wv.__roostFolderReinject) {
                wv.addEventListener("dom-ready", reinject);
                wv.__roostFolderReinject = reinject;
            }
            reinject();
            wv.loadURL(target);
        },
        PLUGIN_ID,
        url,
        probeSource,
    );

    await browser.waitUntil(
        async () => {
            const href = await runInWebview<string>("location.href");
            return typeof href === "string" && href.includes("x.com");
        },
        { timeout: FOLDER_NAV_TIMEOUT_MS, timeoutMsg: `webview never reached ${url}`, interval: 500 },
    );
    // Let the SPA render + fire its GraphQL calls.
    await browser.pause(4_000);
}

// ─── Suite ──────────────────────────────────────────────────────────────────────

describe("X bookmark folders — live (real x.com, cookie injection)", function () {
    this.timeout(300_000);

    let probeSource = "";

    before(async function () {
        if (!fs.existsSync(COOKIES_PATH)) {
            // eslint-disable-next-line no-console
            console.warn(
                "\n[live-spec] SKIPPED: tests/e2e/.x-cookies.json not found.\n" +
                "  1. In production Obsidian: Cmd+P → 'Export X session cookies'\n" +
                "  2. Paste the clipboard output into tests/e2e/.x-cookies.json\n" +
                "  3. Re-run this spec.\n",
            );
            this.skip();
            return;
        }

        let cookies: unknown[];
        try {
            cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf-8"));
        } catch (e) {
            throw new Error(`Failed to parse .x-cookies.json: ${String(e)}`);
        }
        if (!Array.isArray(cookies) || cookies.length === 0) {
            throw new Error(".x-cookies.json is empty or not an array — re-export cookies.");
        }

        probeSource = fs.readFileSync(PROBE_PATH, "utf-8");

        // Isolated temp copy of the fixture vault — real vault untouched.
        await browser.reloadObsidian({ vault: FIXTURE_VAULT });
        await ensureWebviewReady();

        // Inject cookies into the X webview's Electron session before navigation.
        const injectResult = await browser.executeObsidian(
            async ({ app }, pluginId, cookiesJson) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const plugin = (app as any).plugins.plugins[pluginId];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const wv = plugin.getWebviewManager().getElement("twitter") as any;
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
            throw new Error("No cookies were injected — check .x-cookies.json format.");
        }

        // Navigate to bookmarks and confirm we are authenticated.
        await injectProbeAndNavigate("https://x.com/i/bookmarks", probeSource);
        const authCheck = await runInWebview<{ url: string; hasSignIn: boolean }>(`
            (function() {
                return {
                    url: location.href,
                    hasSignIn: document.title.toLowerCase().includes("log in") ||
                               document.body.innerText.toLowerCase().includes("sign in to x")
                };
            })()
        `);
        // eslint-disable-next-line no-console
        console.log("[live-spec] auth check:", JSON.stringify(authCheck));
        if ((authCheck as { hasSignIn?: boolean })?.hasSignIn) {
            throw new Error(
                "X webview shows a login prompt even after cookie injection — cookies likely expired. " +
                "Re-export with the 'Export X session cookies' command.",
            );
        }
    });

    it("captures the real bookmark-folder GraphQL ops (diagnostic — always passes)", async function () {
        // The folder LIST op fires when the bookmarks page renders its folder
        // chips. Open the bookmarks page fresh so we catch it, then poll until
        // the probe has observed some graphql traffic.
        await injectProbeAndNavigate("https://x.com/i/bookmarks", probeSource);

        await browser.waitUntil(
            async () => {
                const n = await runInWebview<number>(
                    "(window.__TWITTER_BOOKMARK_SPIKE__?.observedOperations?.length || 0)",
                );
                return typeof n === "number" && n > 0;
            },
            {
                timeout: OBSERVED_OPS_TIMEOUT_MS,
                timeoutMsg: "probe never observed any graphql op — is the webview logged in?",
                interval: 1_000,
            },
        );

        const snap = await runInWebview<{
            observedOperations: ObservedOp[];
            bookmarkFolderDebug: FolderDebugEntry[];
            bookmarkFolders: Record<string, string>;
        }>(`
            (function() {
                var s = window.__TWITTER_BOOKMARK_SPIKE__ || {};
                return {
                    observedOperations: s.observedOperations || [],
                    bookmarkFolderDebug: s.bookmarkFolderDebug || [],
                    bookmarkFolders: s.bookmarkFolders || {}
                };
            })()
        `);

        observedOps = snap?.observedOperations ?? [];
        folderDebug = snap?.bookmarkFolderDebug ?? [];
        bookmarkFolders = snap?.bookmarkFolders ?? {};

        // Durable artifact for correcting the probe if a guess is wrong.
        fs.writeFileSync(
            CAPTURE_PATH,
            JSON.stringify(
                {
                    capturedAt: new Date().toISOString(),
                    distinctOps: [...new Set(observedOps.map((o) => o.op))].sort(),
                    folderRelatedOps: [...new Set(folderDebug.map((d) => d.op))].sort(),
                    bookmarkFolders,
                    folderDebug,
                },
                null,
                2,
            ),
        );

        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] observed ${observedOps.length} ops; distinct: ` +
            `${[...new Set(observedOps.map((o) => o.op))].join(", ")}`,
        );
        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] folder-related ops: ` +
            `${[...new Set(folderDebug.map((d) => d.op))].join(", ") || "(none)"}`,
        );
        // eslint-disable-next-line no-console
        console.log(`[live-spec] capture written to ${CAPTURE_PATH}`);

        // Diagnostic phase never fails — it exists to surface data.
        expect(observedOps.length).toBeGreaterThan(0);
    });

    it("guess #1+#2+#3: probe parses the folder LIST into store.bookmarkFolders", async function () {
        const folderOps = [...new Set(folderDebug.map((d) => d.op))];
        if (folderOps.length === 0) {
            // eslint-disable-next-line no-console
            console.warn(
                "[live-spec] No folder/collection-related graphql op was observed. " +
                "Either this account has no bookmark folders, or the folder list is " +
                "fetched under an op name not matching /bookmark|folder|collection/i. " +
                "Inspect .x-bookmark-folders-capture.json distinctOps. Skipping.",
            );
            this.skip();
            return;
        }

        const count = Object.keys(bookmarkFolders).length;
        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] folder op(s) seen: ${folderOps.join(", ")}; ` +
            `bookmarkFolders parsed: ${count} → ${JSON.stringify(bookmarkFolders)}`,
        );

        // If a folder op fired but nothing parsed, the SHAPE/FIELD guesses (#2/#3)
        // or the op-name regex (#1) are wrong. The capture file has the real shape.
        if (count === 0) {
            // eslint-disable-next-line no-console
            console.error(
                `[live-spec] FAIL guess #1/#2/#3: a folder op fired (${folderOps.join(", ")}) but ` +
                `store.bookmarkFolders is empty — the op-name regex (BOOKMARK_FOLDERS_LIST_RE) ` +
                `and/or the response-shape / id+name field paths in twitter-probe.js are wrong. ` +
                `The REAL response is in ${path.basename(CAPTURE_PATH)} → folderDebug[].rawSample / ` +
                `.dataKeys. Correct the probe's folder-list parse to match, then re-run.`,
            );
        }
        expect(count).toBeGreaterThan(0);
    });

    it("guess #4+#5+#6: navigating a folder stamps _bookmark_folder on its tweets", async function () {
        const folderEntries = Object.entries(bookmarkFolders);
        if (folderEntries.length === 0) {
            // eslint-disable-next-line no-console
            console.warn("[live-spec] No parsed folders to navigate — skipping (see prior test).");
            this.skip();
            return;
        }

        const [folderId, folderName] = folderEntries[0];
        // Guess #5: the folder navigation URL.
        const folderUrl = `https://x.com/i/bookmarks/${folderId}`;
        // eslint-disable-next-line no-console
        console.log(`[live-spec] navigating folder "${folderName}" → ${folderUrl}`);
        await injectProbeAndNavigate(folderUrl, probeSource);

        // Give the folder timeline op time to fire + be parsed.
        await browser.pause(3_000);

        const result = await runInWebview<{
            taggedCount: number;
            folderDebug: FolderDebugEntry[];
            currentUrl: string;
        }>(`
            (function() {
                var s = window.__TWITTER_BOOKMARK_SPIKE__ || {};
                var tagged = 0;
                for (var id in (s.tweetCache || {})) {
                    if (s.tweetCache[id]._bookmark_folder === ${JSON.stringify(folderName)}) tagged++;
                }
                return {
                    taggedCount: tagged,
                    folderDebug: s.bookmarkFolderDebug || [],
                    currentUrl: location.href
                };
            })()
        `);

        const tagged = result?.taggedCount ?? 0;
        // Refresh the capture file with post-navigation debug (folder timeline op).
        try {
            const existing = fs.existsSync(CAPTURE_PATH)
                ? JSON.parse(fs.readFileSync(CAPTURE_PATH, "utf-8"))
                : {};
            existing.folderTimelineDebug = result?.folderDebug ?? [];
            existing.folderNavUrl = folderUrl;
            existing.folderNavResolvedUrl = result?.currentUrl;
            fs.writeFileSync(CAPTURE_PATH, JSON.stringify(existing, null, 2));
        } catch { /* best-effort */ }

        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] folder "${folderName}": ${tagged} tweets tagged; ` +
            `landed on ${result?.currentUrl}`,
        );

        if (tagged === 0) {
            // eslint-disable-next-line no-console
            console.error(
                `[live-spec] FAIL guess #4/#5/#6: navigated to ${folderUrl} but no tweet got ` +
                `_bookmark_folder="${folderName}". One of: the nav URL (#5) is wrong (landed on ` +
                `${result?.currentUrl}); the folder timeline op-name regex (BOOKMARK_FOLDER_TIMELINE_RE, ` +
                `#1); or the URL \`variables\` folder-id key (#4 — code tries ` +
                `bookmark_collection_id/bookmarkCollectionId/folder_id). The real folder-timeline op + ` +
                `its variables are in ${path.basename(CAPTURE_PATH)} → folderTimelineDebug[]. Correct ` +
                `twitter-probe.js + twitter-sync.ts and re-run.`,
            );
        }
        expect(tagged).toBeGreaterThan(0);
    });
});
