/**
 * Live link-preview backfill e2e. After the Reddit sync settles, asserts that
 * at least one Reddit LINK post exists in the vault (a note with `link_url` +
 * `link_site`), then triggers the "Backfill link previews" command via
 * `app.commands.executeCommandById` and re-scans to confirm at least one note
 * gained `link_title` AND `link_image`.
 *
 * EXCLUDED from the default suite (needs real credentials + network + a live
 * Reddit vault with link posts).
 * Run: E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
 *   --spec tests/e2e/94-link-preview.live.spec.ts
 * Requires tests/e2e/.reddit-cookies.json (reddit_session).
 *
 * NOTE: This spec does NOT re-run the Reddit sync itself — it expects the
 * vault to already contain Reddit notes from a prior run of spec 92. If you
 * are running in isolation, run spec 92 first so the vault has notes to assert
 * on. In CI the specs share the same Obsidian session, so order matters.
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

/** Ensure the reddit webview element exists and has a live webContents.
 *  Mirrors the pattern in spec 92. */
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

/** Parse link_url and link_site from a markdown file's text content.
 *  Returns the values if present, undefined if absent. */
function parseLinkFields(text: string): {
    link_url?: string;
    link_site?: string;
    link_title?: string;
    link_image?: string;
} {
    const result: { link_url?: string; link_site?: string; link_title?: string; link_image?: string } = {};
    const linkUrlMatch = text.match(/^link_url:\s*(.+)$/m);
    if (linkUrlMatch) result.link_url = linkUrlMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const linkSiteMatch = text.match(/^link_site:\s*(.+)$/m);
    if (linkSiteMatch) result.link_site = linkSiteMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const linkTitleMatch = text.match(/^link_title:\s*(.+)$/m);
    if (linkTitleMatch) result.link_title = linkTitleMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const linkImageMatch = text.match(/^link_image:\s*(.+)$/m);
    if (linkImageMatch) result.link_image = linkImageMatch[1].trim().replace(/^['"]|['"]$/g, "");
    return result;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Link preview backfill — live", function () {
    this.timeout(600_000);

    before(async function () {
        if (!fs.existsSync(COOKIES_PATH)) {
            // eslint-disable-next-line no-console
            console.warn(
                "\n[live-spec] SKIPPED: tests/e2e/.reddit-cookies.json not found.\n" +
                "  This spec requires Reddit cookies (same as spec 92).\n" +
                "  Export your reddit.com cookies as a JSON array and save to\n" +
                "  tests/e2e/.reddit-cookies.json  (gitignored — never commit).\n" +
                "  Run spec 92 first to populate the vault with Reddit link posts.\n",
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

        // Boot a clean Obsidian session and ensure the reddit webview is ready
        // (mirrors spec 92 before() pattern).
        await browser.reloadObsidian({ vault: FIXTURE_VAULT });
        await ensureWebviewReady();

        // Inject reddit.com cookies into the webview session (mirrors spec 92).
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

        // Mark setup complete so the onboarding gate doesn't interfere.
        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (plugin?.settings && plugin.settings.setupComplete !== true) {
                plugin.settings.setupComplete = true;
                if (typeof plugin.saveSettings === "function") await plugin.saveSettings();
            }
        }, PLUGIN_ID);
    });

    it("finds a Reddit link post with link_url+link_site, runs OG backfill, gains link_title+link_image", async function () {
        const liveLog = path.join(__dirname, ".link-preview-live.log");
        try {
            fs.writeFileSync(liveLog, `[${new Date().toISOString()}] starting link-preview e2e\n`);
        } catch { /* ignore */ }

        const log = (msg: string) => {
            const stamp = new Date().toISOString();
            // eslint-disable-next-line no-console
            console.log("  [link-preview]", msg);
            try { fs.appendFileSync(liveLog, `[${stamp}] ${msg}\n`); } catch { /* ignore */ }
        };

        // ── Step 1: Resolve vault root + sync folder from the live plugin settings ──
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
        log(`live vault: ${vaultRoot} — asserting at ${redditDir}`);

        // ── Step 2: Scan Reddit/*.md for a note with link_url (LINK post) ──
        if (!fs.existsSync(redditDir)) {
            throw new Error(
                `Reddit sync folder not found at ${redditDir} — run spec 92 first to populate the vault.`,
            );
        }

        const allMdFiles = fs.readdirSync(redditDir).filter((f) => f.endsWith(".md"));
        log(`Found ${allMdFiles.length} Reddit note(s) on disk`);

        if (allMdFiles.length === 0) {
            throw new Error(
                "No Reddit notes found in vault — run spec 92 first to populate the vault.",
            );
        }

        // Find notes that have link_url (Reddit LINK posts, not self-posts or images)
        const linkNotes: Array<{ file: string; fields: ReturnType<typeof parseLinkFields> }> = [];
        for (const f of allMdFiles) {
            const filePath = path.join(redditDir, f);
            let text: string;
            try { text = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
            const fields = parseLinkFields(text);
            if (fields.link_url) {
                linkNotes.push({ file: f, fields });
            }
        }

        log(`Found ${linkNotes.length} link-post note(s) with link_url`);

        // Assert: at least one Reddit LINK post note exists
        if (linkNotes.length === 0) {
            throw new Error(
                `No Reddit LINK post notes found (no note has link_url frontmatter). ` +
                `The vault has ${allMdFiles.length} Reddit note(s) total — they may all be ` +
                `self-posts or image posts. Save a Reddit link post and re-sync.`,
            );
        }

        // Verify link_site is present (it's derived from link_url at sync time, so it's always populated
        // alongside link_url). Log any that are missing for diagnostics; don't hard-fail on this.
        const notesWithLinkSite = linkNotes.filter((n) => n.fields.link_site);
        log(
            `${notesWithLinkSite.length}/${linkNotes.length} link-post note(s) already have link_site`,
        );
        // Primary assertion — at least one must have link_url (already verified above) and link_site
        expect(notesWithLinkSite.length).toBeGreaterThan(0);

        // Count notes that are missing OG preview fields before backfill
        const beforeBackfill = linkNotes.filter(
            (n) => !n.fields.link_title || !n.fields.link_image,
        );
        log(
            `${beforeBackfill.length} link note(s) lack link_title or link_image — these are backfill candidates`,
        );

        // ── Step 3: Trigger the OG backfill via Obsidian command ──
        // The command id is registered as "roost:backfill-link-previews"
        // (commandId="backfill-link-previews", with the "roost:" prefix added by main.ts).
        log("Triggering command: roost:backfill-link-previews");

        // Subscribe to plugin logs before firing so we capture backfill progress.
        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (!plugin) throw new Error(`plugin ${pid} not loaded`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            w.__roostLinkPreviewLogs = [];
            w.__roostLinkPreviewCursor = 0;
            w.__roostLinkPreviewDone = false;
            plugin.onLog((msg: string) => { w.__roostLinkPreviewLogs.push(msg); });
        }, PLUGIN_ID);

        // Fire-and-forget the backfill command (it may run longer than the 30s renderer
        // script timeout if the queue is large, so we do not await it inside execute()).
        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            Promise.resolve()
                .then(() =>
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (app as any).commands.executeCommandById("roost:backfill-link-previews"),
                )
                .then(() => { w.__roostLinkPreviewDone = true; })
                .catch((e: unknown) => {
                    w.__roostLinkPreviewDone = true;
                    w.__roostLinkPreviewError = String(e);
                });
            void pid; // suppress unused-variable lint
        }, PLUGIN_ID);

        // Drain new log lines → live file, poll for done or enriched notes on disk.
        const drainLogs = async () => {
            const fresh = (await browser.executeObsidian(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const logs: string[] = w.__roostLinkPreviewLogs || [];
                const from: number = w.__roostLinkPreviewCursor || 0;
                const freshLines = logs.slice(from);
                w.__roostLinkPreviewCursor = logs.length;
                return freshLines;
            })) as string[];
            if (fresh.length) {
                for (const l of fresh) log(l);
            }
        };

        // Poll until the backfill command signals done OR at least one link note gains
        // link_title + link_image on disk.
        await browser.waitUntil(
            async () => {
                await drainLogs();

                // Check done flag
                const done = (await browser.executeObsidian(() => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const w = window as any;
                    return { done: !!w.__roostLinkPreviewDone, error: w.__roostLinkPreviewError as string | undefined };
                })) as { done: boolean; error?: string };

                if (done.error) {
                    throw new Error(`Backfill command failed: ${done.error}`);
                }

                // Check disk: any link note now has link_title AND link_image?
                const enriched = linkNotes.filter((n) => {
                    try {
                        const text = fs.readFileSync(path.join(redditDir, n.file), "utf-8");
                        const f = parseLinkFields(text);
                        return !!(f.link_title && f.link_image);
                    } catch { return false; }
                });

                if (enriched.length > 0) {
                    log(`${enriched.length} link note(s) now have link_title + link_image`);
                    return true;
                }

                return done.done; // also exit when backfill signals done (even if 0 enriched)
            },
            {
                timeout: 300_000, // 5 min — OG fetches need network
                interval: 5_000,
                timeoutMsg: "link-preview backfill did not complete within 5 min — see tests/e2e/.link-preview-live.log",
            },
        );

        await drainLogs(); // flush trailing log lines

        // ── Step 4: Re-scan and assert enrichment ──
        const enrichedNotes = linkNotes.filter((n) => {
            try {
                const text = fs.readFileSync(path.join(redditDir, n.file), "utf-8");
                const f = parseLinkFields(text);
                return !!(f.link_title && f.link_image);
            } catch { return false; }
        });

        log(
            `Final: ${enrichedNotes.length}/${linkNotes.length} link note(s) have link_title + link_image ` +
            `(full log: ${liveLog})`,
        );

        // Primary gate: at least one link note must have been enriched with link_title AND link_image.
        // (If all notes already had both before the backfill, they pass this check too — idempotent.)
        if (enrichedNotes.length === 0) {
            throw new Error(
                `OG backfill ran but no Reddit link post gained link_title + link_image. ` +
                `Check ${liveLog} for per-note failure details.`,
            );
        }

        expect(enrichedNotes.length).toBeGreaterThan(0);
    });
});
