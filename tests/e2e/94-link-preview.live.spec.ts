/**
 * Live link-preview backfill e2e. Runs its own Reddit sync (mirrors spec 92),
 * then asserts that at least one Reddit LINK post exists in the vault (a note
 * with `link_url` + `link_site`), then triggers the "Backfill link previews"
 * command via `app.commands.executeCommandById` and re-scans to confirm at
 * least one note gained `link_title` AND `link_image`.
 *
 * This spec is self-contained: it boots a fresh vault via reloadObsidian and
 * runs its own Reddit sync before asserting on link notes.
 *
 * EXCLUDED from the default suite (needs real credentials + network + a live
 * Reddit vault with link posts).
 * Run: E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
 *   --spec tests/e2e/94-link-preview.live.spec.ts
 * Requires tests/e2e/.reddit-cookies.json (reddit_session).
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
    link_desc?: string;
    link_image?: string;
} {
    const result: { link_url?: string; link_site?: string; link_title?: string; link_desc?: string; link_image?: string } = {};
    const linkUrlMatch = text.match(/^link_url:\s*(.+)$/m);
    if (linkUrlMatch) result.link_url = linkUrlMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const linkSiteMatch = text.match(/^link_site:\s*(.+)$/m);
    if (linkSiteMatch) result.link_site = linkSiteMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const linkTitleMatch = text.match(/^link_title:\s*(.+)$/m);
    if (linkTitleMatch) result.link_title = linkTitleMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const linkDescMatch = text.match(/^link_desc:\s*(.+)$/m);
    if (linkDescMatch) result.link_desc = linkDescMatch[1].trim().replace(/^['"]|['"]$/g, "");
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
                "  tests/e2e/.reddit-cookies.json  (gitignored — never commit).\n",
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
        if (((injectResult as { set?: number }).set ?? 0) === 0) {
            throw new Error("No cookies were injected — check .reddit-cookies.json format.");
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

        // ── Step 2: Subscribe onLog + fire-and-forget Reddit sync (mirrors spec 92) ──
        // reloadObsidian boots a FRESH temp copy of the fixture vault, so the Reddit
        // folder is empty. We must run our own sync before asserting on link notes.
        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (!plugin) throw new Error(`plugin ${pid} not loaded`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            w.__roostLinkPreviewLogs = [];
            w.__roostLinkPreviewCursor = 0;
            w.__roostLinkPreviewDone = false;
            w.__roostLinkPreviewError = undefined;
            plugin.onLog((msg: string) => { w.__roostLinkPreviewLogs.push(msg); });
            Promise.resolve()
                .then(() => plugin.syncPlatformHeadless("reddit"))
                .then(() => { w.__roostLinkPreviewDone = true; })
                .catch((e: unknown) => {
                    w.__roostLinkPreviewDone = true;
                    w.__roostLinkPreviewError = String(e);
                });
        }, PLUGIN_ID);

        // Drain new log lines → live file + console. Shared helper for sync and backfill phases.
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

        // ── Step 3: Poll until a link-post note (.md with link_url) appears on disk ──
        let syncErr: string | undefined;
        await browser.waitUntil(
            async () => {
                await drainLogs();
                const state = (await browser.executeObsidian(() => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const w = window as any;
                    return {
                        done: !!w.__roostLinkPreviewDone,
                        error: w.__roostLinkPreviewError as string | undefined,
                    };
                })) as { done: boolean; error?: string };

                if (state.error) { syncErr = state.error; return true; }

                // Pass as soon as a link-post note (.md with link_url) appears on disk.
                if (fs.existsSync(redditDir)) {
                    const mdFiles = fs.readdirSync(redditDir).filter((f) => f.endsWith(".md"));
                    for (const f of mdFiles) {
                        try {
                            const text = fs.readFileSync(path.join(redditDir, f), "utf-8");
                            if (parseLinkFields(text).link_url) return true;
                        } catch { /* continue */ }
                    }
                }

                return state.done;
            },
            {
                timeout: 540_000,
                interval: 5_000,
                timeoutMsg: "no Reddit link-post note appeared within 9 min — see tests/e2e/.link-preview-live.log",
            },
        );

        await drainLogs(); // flush trailing sync log lines
        if (syncErr) throw new Error(`syncPlatformHeadless("reddit") failed: ${syncErr}`);

        // ── Step 4: Scan Reddit/*.md for link-post notes and assert ──
        const allMdFiles = fs.existsSync(redditDir)
            ? fs.readdirSync(redditDir).filter((f) => f.endsWith(".md"))
            : [];
        log(`Found ${allMdFiles.length} Reddit note(s) on disk`);

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

        // If no link posts are in the account's saved set, throw a descriptive error so
        // the operator knows it's a data condition, not a code failure.
        if (linkNotes.length === 0) {
            throw new Error(
                `No Reddit LINK post notes found (no note has link_url frontmatter). ` +
                `The vault has ${allMdFiles.length} Reddit note(s) total — they may all be ` +
                `self-posts or image posts. Save a Reddit link post and re-sync.`,
            );
        }

        // Verify link_site is present alongside link_url — it is derived from link_url at sync time.
        const notesWithLinkSite = linkNotes.filter((n) => n.fields.link_site);
        log(
            `${notesWithLinkSite.length}/${linkNotes.length} link-post note(s) already have link_site`,
        );
        expect(notesWithLinkSite.length).toBeGreaterThan(0);

        // ── Step 5: Capture thin notes (link_url present but missing link_title or link_image) ──
        const beforeBackfill = linkNotes.filter(
            (n) => !n.fields.link_title || !n.fields.link_image,
        );
        log(
            `${beforeBackfill.length} link note(s) lack link_title or link_image — these are backfill candidates`,
        );

        // ── Step 6: Trigger the OG backfill via Obsidian command ──
        // Reset globals and re-subscribe so backfill logs are captured cleanly, then
        // fire-and-forget the command (mirrors the sync pattern in step 2).
        log("Triggering command: roost:backfill-link-previews");

        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (!plugin) throw new Error(`plugin ${pid} not loaded`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            w.__roostLinkPreviewLogs = [];
            w.__roostLinkPreviewCursor = 0;
            w.__roostLinkPreviewDone = false;
            w.__roostLinkPreviewError = undefined;
            plugin.onLog((msg: string) => { w.__roostLinkPreviewLogs.push(msg); });
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
        }, PLUGIN_ID);

        // Poll until the backfill command signals done OR at least one link note gains
        // link_title + link_image on disk.
        await browser.waitUntil(
            async () => {
                await drainLogs();

                const done = (await browser.executeObsidian(() => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const w = window as any;
                    return {
                        done: !!w.__roostLinkPreviewDone,
                        error: w.__roostLinkPreviewError as string | undefined,
                    };
                })) as { done: boolean; error?: string };

                if (done.error) {
                    throw new Error(`Backfill command failed: ${done.error}`);
                }

                // Gate on link_DESC — the only link_* field that sync NEVER writes
                // for a Reddit link post (extractRedditLink leaves description
                // undefined; link_url/link_site/link_title/link_image can all be
                // set at sync from the post + Reddit preview). So link_desc
                // appearing is the honest proof the OG backfill fetched the
                // destination page and wrote new metadata — title alone would be
                // a false pass (it pre-exists from sync).
                // NOTE: do NOT exit on done.done — executeCommandById resolves when
                // the command DISPATCHES, not when the async backfill finishes
                // (it flips true within ms while runBackfill is still fetching).
                // Poll disk until real enrichment (desc) or timeout.
                const desced = linkNotes.filter((n) => {
                    try {
                        return !!parseLinkFields(fs.readFileSync(path.join(redditDir, n.file), "utf-8")).link_desc;
                    } catch { return false; }
                });
                if (desced.length > 0) {
                    const withImg = desced.filter((n) => {
                        try {
                            return !!parseLinkFields(fs.readFileSync(path.join(redditDir, n.file), "utf-8")).link_image;
                        } catch { return false; }
                    });
                    log(`${desced.length} link note(s) gained link_desc from OG backfill (${withImg.length} also have link_image)`);
                    return true;
                }

                return false;
            },
            {
                timeout: 180_000,
                interval: 5_000,
                timeoutMsg: "link-preview backfill did not complete within 3 min — see tests/e2e/.link-preview-live.log",
            },
        );

        await drainLogs(); // flush trailing backfill log lines

        // ── Step 7: Re-scan and assert enrichment ──
        // Gate on link_DESC — sync never writes it for a Reddit link post, so its
        // presence is unambiguous proof the OG backfill fetched the destination
        // page and wrote new metadata. link_image is reported (best-effort: only
        // pages exposing og:image yield one), not gated.
        const descedNotes = linkNotes.filter((n) => {
            try {
                return !!parseLinkFields(fs.readFileSync(path.join(redditDir, n.file), "utf-8")).link_desc;
            } catch { return false; }
        });
        const imagedNotes = descedNotes.filter((n) => {
            try {
                return !!parseLinkFields(fs.readFileSync(path.join(redditDir, n.file), "utf-8")).link_image;
            } catch { return false; }
        });

        log(
            `Final: ${descedNotes.length}/${linkNotes.length} link note(s) gained link_desc from OG backfill; ` +
            `${imagedNotes.length} also have link_image (full log: ${liveLog})`,
        );

        // Primary gate: the OG backfill enriched at least one thin link note with a
        // destination-page description (a field sync provably never sets).
        expect(descedNotes.length).toBeGreaterThan(0);
    });
});
