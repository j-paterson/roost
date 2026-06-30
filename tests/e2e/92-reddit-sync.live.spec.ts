/**
 * Live Reddit PRODUCTION sync e2e. Drives the real syncReddit path against
 * reddit.com using injected cookies, and asserts notes + media land in the vault.
 *
 * EXCLUDED from the default suite (needs real credentials + network).
 * Run: E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
 *   --spec tests/e2e/92-reddit-sync.live.spec.ts
 * Requires tests/e2e/.reddit-cookies.json (reddit_session).
 *
 * Sync entry point: plugin.syncPlatformHeadless("reddit") (src/main.ts) —
 * calls runPlatformSync directly with an off-screen mount container and routes
 * progress through fireLog. This is the headless-safe entry; plugin.runSync only
 * fires the roost:request-sync workspace event, which needs the sidebar React
 * hook mounted to actually run (unreliable under wdio). Logs are captured via
 * plugin.onLog (same as spec 86) and streamed to tests/e2e/.reddit-sync-live.log;
 * the vault is asserted on disk with Node fs (also like spec 86).
 */

import { browser } from "@wdio/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = "roost";
const WEBVIEW_KEY = "reddit";
const WEBVIEW_READY_TIMEOUT_MS = 60_000;

const COOKIES_PATH = path.join(__dirname, ".reddit-cookies.json");
const FIXTURE_VAULT = path.resolve(__dirname, "../fixtures/vault");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Ensure the reddit webview element exists and has a live webContents.
 * Mirrors the pattern in spec 90 (90-instagram-discovery.live.spec.ts).
 * We attach the manager's container to the body so the webview is in a visible
 * tree — some Electron builds refuse to initialise webContents off-screen.
 */
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
        // create() is idempotent; ensures the webview element exists even when
        // the manager didn't pre-create it on boot.
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
            timeoutMsg: "reddit webview never became ready (webContentsId stayed null)",
            interval: 500,
        },
    );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Reddit production sync — live", function () {
    // Allow up to 10 minutes for the full sync (matches runPlatformSync's internal
    // 10 min poll ceiling). The before() hook counts against this budget too.
    this.timeout(600_000);

    before(async function () {
        if (!fs.existsSync(COOKIES_PATH)) {
            // eslint-disable-next-line no-console
            console.warn(
                "\n[live-spec] SKIPPED: tests/e2e/.reddit-cookies.json not found.\n" +
                "  1. Export your reddit.com cookies (DevTools → Application → Cookies,\n" +
                "     or a cookie-manager extension) as a JSON array of\n" +
                "     { name, value, domain, path } objects. You need at minimum:\n" +
                "     reddit_session.\n" +
                "  2. Save to tests/e2e/.reddit-cookies.json  (gitignored — never commit)\n" +
                "  3. Re-run:\n" +
                "     E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \\\n" +
                "       --spec tests/e2e/92-reddit-sync.live.spec.ts\n",
            );
            this.skip();
            return;
        }

        let cookies: unknown[];
        try {
            cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf-8"));
        } catch (e) {
            throw new Error(`Failed to parse .reddit-cookies.json: ${String(e)}`);
        }
        if (!Array.isArray(cookies) || cookies.length === 0) {
            throw new Error(".reddit-cookies.json is empty or not an array — re-export cookies.");
        }

        // Boot a clean Obsidian session with the fixture vault so the plugin
        // initialises from a known state (mirrors spec 90's before() pattern).
        await browser.reloadObsidian({ vault: FIXTURE_VAULT });
        await ensureWebviewReady();

        // Inject reddit.com cookies into the webview's Electron session
        // BEFORE any navigation, so the first page load arrives authenticated.
        // Uses @electron/remote (same pattern as spec 90).
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
            throw new Error("No cookies were injected — check .reddit-cookies.json format.");
        }

        // Mark first-time setup complete. We drive the sync via
        // syncPlatformHeadless (not the Hub UI), so the onboarding panel can't
        // block it — but setting this defensively guarantees the setup gate
        // (hub-body.tsx renders only the onboarding panel while !setupComplete)
        // never interferes with this or future UI-driven assertions.
        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (plugin?.settings && plugin.settings.setupComplete !== true) {
                plugin.settings.setupComplete = true;
                if (typeof plugin.saveSettings === "function") await plugin.saveSettings();
            }
        }, PLUGIN_ID);
    });

    it("syncs ≥1 saved Reddit post into the vault", async function () {
        // Live, tailable log of everything the sync emits:
        //   tail -f tests/e2e/.reddit-sync-live.log
        const liveLog = path.join(__dirname, ".reddit-sync-live.log");
        try { fs.writeFileSync(liveLog, `[${new Date().toISOString()}] starting Reddit sync\n`); } catch { /* ignore */ }

        // Resolve the sync folder AND the real vault root, then assert against
        // the vault ON DISK (Node fs) — mirroring spec 86. NOTE:
        // wdio-obsidian-service runs Obsidian against a TEMP COPY of
        // FIXTURE_VAULT, so we must read the live adapter.basePath, not
        // FIXTURE_VAULT (which is the untouched source).
        const { syncFolder, vaultRoot } = (await browser.executeObsidian(({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const adapter = app.vault.adapter as any;
            return {
                syncFolder: plugin.settings.syncFolder as string,
                vaultRoot: String(adapter.basePath ?? adapter.getBasePath?.() ?? ""),
            };
        }, PLUGIN_ID)) as { syncFolder: string; vaultRoot: string };
        if (!vaultRoot) throw new Error("could not resolve live vault basePath");
        const redditDir = path.join(vaultRoot, syncFolder, "Reddit");
        // eslint-disable-next-line no-console
        console.log(`[live-spec] live vault: ${vaultRoot} — asserting at ${redditDir}`);

        // Subscribe to the plugin log bus (the established capture API — spec 86),
        // then kick off the sync. syncPlatformHeadless calls runPlatformSync
        // directly with an off-screen mount container and routes every line
        // through fireLog, so onLog(...) sees it. (runSync only fires a workspace
        // event that needs the sidebar React hook mounted — unreliable headless,
        // which is why the first attempt wrote 0 notes.) We FIRE-AND-FORGET: the
        // sync runs minutes past WebDriver's 30s renderer-script timeout, so we
        // must not await it inside one execute() call — the renderer event loop
        // keeps running it between the short poll calls below.
        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (!plugin) throw new Error(`plugin ${pid} not loaded`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            w.__roostLogs = [];
            w.__roostLogCursor = 0;
            plugin.onLog((msg: string) => { w.__roostLogs.push(msg); });
            w.__roostRedditSync = { done: false, error: null };
            Promise.resolve()
                .then(() => plugin.syncPlatformHeadless("reddit"))
                .then(() => { w.__roostRedditSync.done = true; })
                .catch((e: unknown) => { w.__roostRedditSync = { done: true, error: String(e) }; });
        }, PLUGIN_ID);

        // Drain new log lines → live file + console, count .md notes on disk,
        // and read the sync's settle flag. One short script call per tick.
        let syncErr: string | null = null;
        const drainAndCount = async (): Promise<{ mdCount: number; done: boolean; error: string | null }> => {
            const probe = (await browser.executeObsidian(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const logs: string[] = w.__roostLogs || [];
                const from: number = w.__roostLogCursor || 0;
                const fresh = logs.slice(from);
                w.__roostLogCursor = logs.length;
                const s = w.__roostRedditSync || { done: false, error: null };
                return { fresh, done: s.done as boolean, error: s.error as string | null };
            })) as { fresh: string[]; done: boolean; error: string | null };
            if (probe.fresh.length) {
                const stamp = new Date().toISOString();
                try { fs.appendFileSync(liveLog, probe.fresh.map((l) => `[${stamp}] ${l}`).join("\n") + "\n"); } catch { /* ignore */ }
                // eslint-disable-next-line no-console
                for (const l of probe.fresh) console.log("  [reddit]", l);
            }
            let mdCount = 0;
            try { mdCount = fs.existsSync(redditDir) ? fs.readdirSync(redditDir).filter((f) => f.endsWith(".md")).length : 0; } catch { /* ignore */ }
            return { mdCount, done: probe.done, error: probe.error };
        };

        // Pass as soon as ≥1 note lands; bail early if the sync rejected.
        await browser.waitUntil(
            async () => {
                const { mdCount, done, error } = await drainAndCount();
                syncErr = error;
                return error != null || mdCount > 0 || done === true;
            },
            {
                timeout: 540_000,
                interval: 5_000,
                timeoutMsg: "no Reddit note appeared within 9 min — see tests/e2e/.reddit-sync-live.log",
            },
        );
        await drainAndCount(); // flush trailing log lines
        if (syncErr) throw new Error(`syncPlatformHeadless("reddit") failed: ${syncErr}`);

        // Assert on disk (Node fs) — count notes + sibling raw.json/media.
        const mdNotes = fs.existsSync(redditDir) ? fs.readdirSync(redditDir).filter((f) => f.endsWith(".md")) : [];
        const attachFolders = fs.existsSync(redditDir)
            ? fs.readdirSync(redditDir, { withFileTypes: true })
                .filter((d) => d.isDirectory() && d.name.startsWith("reddit-"))
                .map((d) => d.name)
            : [];
        let rawJsonCount = 0;
        let mediaCount = 0;
        for (const f of attachFolders) {
            const inner = fs.readdirSync(path.join(redditDir, f));
            if (inner.includes("raw.json")) rawJsonCount++;
            if (inner.some((x) => /\.(jpg|jpeg|mp4|webp|png)$/i.test(x))) mediaCount++;
        }
        // eslint-disable-next-line no-console
        console.log(
            `[live-spec] ${redditDir}: notes=${mdNotes.length} attachFolders=${attachFolders.length} ` +
            `raw.json=${rawJsonCount} media=${mediaCount}  (full log: ${liveLog})`,
        );

        // Primary gate: at least one Reddit note must exist on disk.
        expect(mdNotes.length).toBeGreaterThan(0);
    });
});
