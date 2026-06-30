/**
 * Live Reddit VIDEO-MUX proof e2e. Drives the real syncReddit path and pages
 * through saved posts until it finds a v.redd.it VIDEO post, then proves the
 * ffmpeg audio-mux path end-to-end: it copies the written video.mp4 (+ its
 * raw.json) out of the temp vault before teardown and runs ffprobe on it to
 * confirm the output carries BOTH a video and an audio stream (= muxed), not a
 * video-only fallback. The source post's reddit_video.has_audio tells us which
 * outcome is correct, so a has_audio video whose output lacks audio = a real
 * mux bug (test fails); a muxed has_audio video = PROOF (test passes).
 *
 * EXCLUDED from the default suite (needs real credentials + network + ffmpeg).
 * Run: E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
 *   --spec tests/e2e/93-reddit-video-mux.live.spec.ts
 * Requires tests/e2e/.reddit-cookies.json (reddit_session) AND ffmpeg+ffprobe
 * on PATH (the mux is skipped to video-only when ffmpeg is absent).
 *
 * Proof artifacts (video.mp4 + raw.json per video post seen) are copied to
 * tests/e2e/.reddit-video-mux-proof/ for inspection after the run.
 */

import { browser } from "@wdio/globals";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = "roost";
const WEBVIEW_KEY = "reddit";
const WEBVIEW_READY_TIMEOUT_MS = 60_000;

const COOKIES_PATH = path.join(__dirname, ".reddit-cookies.json");
const FIXTURE_VAULT = path.resolve(__dirname, "../fixtures/vault");
const PROOF_DIR = path.join(__dirname, ".reddit-video-mux-proof");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve ffprobe from PATH or the common Homebrew/usr locations. */
function resolveFfprobe(): string | null {
    const candidates = [
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "/usr/bin/ffprobe",
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    // Fall back to bare name (PATH lookup) — execFileSync will throw if absent.
    return "ffprobe";
}

/** Return the distinct stream codec_types in a media file (e.g. ["video","audio"]). */
function ffprobeStreamTypes(ffprobe: string, file: string): string[] {
    const out = execFileSync(
        ffprobe,
        ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
        { encoding: "utf-8", timeout: 30_000 },
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Ensure the reddit webview element exists and has a live webContents.
 * (Verbatim from spec 92.)
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

interface VideoProof {
    id: string;
    sourceHasAudio: boolean | null; // from raw.json reddit_video.has_audio
    hasDash: boolean;
    outputStreams: string[];        // ffprobe codec_types of the written video.mp4
    verdict: "MUXED" | "video-only (source silent → correct)" | "MUX-FAILED" | "ffprobe-error";
}

/** Read reddit_video.{has_audio,dash_url} from a post's raw.json. */
function readSourceVideoMeta(rawJsonPath: string): { hasAudio: boolean | null; hasDash: boolean } {
    try {
        const raw = JSON.parse(fs.readFileSync(rawJsonPath, "utf-8"));
        const rd = raw?.rawData ?? raw; // writer stores the full NormalizedRecord
        const rv = rd?.secure_media?.reddit_video ?? rd?.media?.reddit_video
            ?? rd?.crosspost_parent_list?.[0]?.secure_media?.reddit_video
            ?? rd?.crosspost_parent_list?.[0]?.media?.reddit_video ?? null;
        if (!rv) return { hasAudio: null, hasDash: false };
        const hasAudio = typeof rv.has_audio === "boolean" ? rv.has_audio : null;
        const hasDash = typeof rv.dash_url === "string" && rv.dash_url.length > 0;
        return { hasAudio, hasDash };
    } catch {
        return { hasAudio: null, hasDash: false };
    }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Reddit video-mux proof — live", function () {
    this.timeout(600_000);

    before(async function () {
        if (!fs.existsSync(COOKIES_PATH)) {
            // eslint-disable-next-line no-console
            console.warn(
                "\n[mux-spec] SKIPPED: tests/e2e/.reddit-cookies.json not found.\n" +
                "  Export reddit.com cookies (need reddit_session) to that path, then re-run:\n" +
                "    E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \\\n" +
                "      --spec tests/e2e/93-reddit-video-mux.live.spec.ts\n",
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

        await browser.reloadObsidian({ vault: FIXTURE_VAULT });
        await ensureWebviewReady();

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
        console.log("[mux-spec] cookie injection:", JSON.stringify(injectResult));
        if (!(injectResult as { ok: boolean }).ok) {
            throw new Error(`Cookie injection failed: ${(injectResult as { reason?: string }).reason}`);
        }
        if (((injectResult as { set?: number }).set ?? 0) === 0) {
            throw new Error("No cookies were injected — check .reddit-cookies.json format.");
        }

        await browser.executeObsidian(async ({ app }, pid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins.plugins[pid];
            if (plugin?.settings && plugin.settings.setupComplete !== true) {
                plugin.settings.setupComplete = true;
                if (typeof plugin.saveSettings === "function") await plugin.saveSettings();
            }
        }, PLUGIN_ID);
    });

    it("pages through saved posts until a v.redd.it video is muxed (video+audio)", async function () {
        const liveLog = path.join(__dirname, ".reddit-mux-live.log");
        try { fs.writeFileSync(liveLog, `[${new Date().toISOString()}] starting Reddit mux-proof sync\n`); } catch { /* ignore */ }
        try { fs.rmSync(PROOF_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch { /* ignore */ }

        const ffprobe = resolveFfprobe();

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
        console.log(`[mux-spec] live vault: ${vaultRoot} — scanning ${redditDir} for video.mp4`);

        // Fire the full sync (no early bail — we need to page until a video lands).
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

        const proofs: VideoProof[] = [];
        const seenVideoIds = new Set<string>();
        let muxProven = false;
        let syncErr: string | null = null;

        const drainAndScan = async (): Promise<{ done: boolean; error: string | null }> => {
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

            // Scan attach folders for a freshly written video.mp4.
            let attachFolders: string[] = [];
            try {
                attachFolders = fs.existsSync(redditDir)
                    ? fs.readdirSync(redditDir, { withFileTypes: true })
                        .filter((d) => d.isDirectory() && d.name.startsWith("reddit-"))
                        .map((d) => d.name)
                    : [];
            } catch { /* ignore */ }

            for (const folder of attachFolders) {
                const id = folder.replace(/^reddit-/, "");
                if (seenVideoIds.has(id)) continue;
                const videoPath = path.join(redditDir, folder, "video.mp4");
                if (!fs.existsSync(videoPath)) continue;
                // A video.mp4 exists for a post we haven't analysed yet.
                seenVideoIds.add(id);

                const rawJsonPath = path.join(redditDir, folder, "raw.json");
                const { hasAudio, hasDash } = readSourceVideoMeta(rawJsonPath);

                // Copy artifacts out before the temp vault is torn down.
                try {
                    const dest = path.join(PROOF_DIR, id);
                    fs.mkdirSync(dest, { recursive: true });
                    fs.copyFileSync(videoPath, path.join(dest, "video.mp4"));
                    if (fs.existsSync(rawJsonPath)) fs.copyFileSync(rawJsonPath, path.join(dest, "raw.json"));
                } catch { /* ignore copy errors */ }

                let outputStreams: string[] = [];
                let verdict: VideoProof["verdict"];
                try {
                    if (!ffprobe) throw new Error("no ffprobe");
                    outputStreams = ffprobeStreamTypes(ffprobe, videoPath);
                    const hasVideo = outputStreams.includes("video");
                    const hasAudioStream = outputStreams.includes("audio");
                    if (hasVideo && hasAudioStream) {
                        verdict = "MUXED";
                        if (hasAudio !== false) muxProven = true; // source had (or might have) audio → real mux proof
                    } else if (hasAudio === false) {
                        verdict = "video-only (source silent → correct)";
                    } else {
                        // Source has audio (or unknown) but output lacks an audio stream → mux did not fire.
                        verdict = "MUX-FAILED";
                    }
                } catch {
                    verdict = "ffprobe-error";
                }

                proofs.push({ id, sourceHasAudio: hasAudio, hasDash, outputStreams, verdict });
                const line = `[mux-spec] VIDEO ${id}: source has_audio=${hasAudio} dash=${hasDash} → output streams=[${outputStreams.join(",")}] verdict=${verdict}`;
                // eslint-disable-next-line no-console
                console.log(line);
                try { fs.appendFileSync(liveLog, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
            }

            return { done: probe.done, error: probe.error };
        };

        // Page through saved posts until: a real mux is proven, the sync finishes,
        // or it errors. (No early bail on the first note — videos may be deep in
        // the saved list.)
        await browser.waitUntil(
            async () => {
                const { done, error } = await drainAndScan();
                syncErr = error;
                return error != null || muxProven || done === true;
            },
            {
                timeout: 540_000,
                interval: 5_000,
                timeoutMsg: "no v.redd.it video was muxed within 9 min — see tests/e2e/.reddit-mux-live.log",
            },
        );
        await drainAndScan(); // flush trailing posts + logs
        if (syncErr) throw new Error(`syncPlatformHeadless("reddit") failed: ${syncErr}`);

        const muxed = proofs.filter((p) => p.verdict === "MUXED");
        const muxFailed = proofs.filter((p) => p.verdict === "MUX-FAILED");
        // eslint-disable-next-line no-console
        console.log(
            `[mux-spec] DONE — video posts seen=${proofs.length}, MUXED=${muxed.length}, ` +
            `MUX-FAILED=${muxFailed.length}. Artifacts in ${PROOF_DIR}\n` +
            proofs.map((p) => `   • ${p.id}: ${p.verdict} (has_audio=${p.sourceHasAudio}, streams=[${p.outputStreams.join(",")}])`).join("\n"),
        );

        // NOTE: wdio's expect (expect-webdriverio) takes ONE argument — no
        // message arg like vitest. Surface diagnostics via thrown Errors so the
        // failure message is still useful.

        // A has_audio video whose output lacks audio is a genuine mux bug.
        if (muxFailed.length > 0) {
            throw new Error(`mux FAILED for: ${muxFailed.map((p) => p.id).join(", ")} — see tests/e2e/.reddit-mux-live.log`);
        }
        // Proof requires at least one video that was actually muxed with audio.
        // If this throws with 0 video posts, the account simply has no v.redd.it
        // video in its saved list; if it throws with video-only-correct posts,
        // those videos are genuinely silent. Either way the log explains it.
        if (!muxProven) {
            throw new Error(`no audio-bearing v.redd.it video was muxed (video posts seen: ${proofs.length}). See tests/e2e/.reddit-mux-live.log`);
        }
        expect(muxProven).toBe(true);
    });
});
