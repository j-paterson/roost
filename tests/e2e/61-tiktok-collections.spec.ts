/**
 * Deterministic e2e for the TikTok Collections sub-tab activation.
 *
 * The sync (packages/core/src/sync/tiktok-sync.ts) has to switch TikTok's
 * profile to the "Collections" sub-tab, which only responds to a TRUSTED
 * (isTrusted) Chromium-level event — a synthetic element.click() is ignored.
 * Live verification used to require a logged-in TikTok session + manually
 * reading the sync log. This test instead loads a trusted-gated fixture page
 * (tests/e2e/fixtures/tiktok-profile.html) into the REAL Electron webview and
 * checks, deterministically:
 *   1. the shipped mechanism (a trusted mouse click at the button center after
 *      scrollIntoView) reveals the collection links — the regression guard;
 *   2. whether the coordinate-free mechanism (focus + a trusted Enter keypress)
 *      ALSO reveals them — answers whether we can drop the pixel math.
 *
 * `sendInputEvent` only delivers real events to a genuinely loaded document, so
 * the fixture is loaded via file:// (not executeJavaScript-injected DOM).
 */
import * as path from "path";

const PLUGIN_ID = "roost";
const WEBVIEW_READY_TIMEOUT_MS = 30_000;
const FIXTURE_URL =
    "file://" + path.join(process.cwd(), "tests", "e2e", "fixtures", "tiktok-profile.html");

async function ensureTikTokWebviewReady(): Promise<void> {
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
        wm.getElement("tiktok"); // ensure it exists
    }, PLUGIN_ID);

    await browser.waitUntil(
        async () =>
            browser.executeObsidian(({ app }, pluginId) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const plugin = (app as any).plugins.plugins[pluginId];
                const wm = plugin?.getWebviewManager?.();
                return wm ? wm.getWebContents("tiktok") !== null : false;
            }, PLUGIN_ID),
        { timeout: WEBVIEW_READY_TIMEOUT_MS, timeoutMsg: "tiktok webview never became ready", interval: 500 },
    );
}

/** Run JS inside the tiktok webview's loaded page. */
async function inWebview<T = unknown>(js: string): Promise<T | null> {
    const raw = await browser.executeObsidian(
        async ({ app }, pluginId, src) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = (app as any).plugins.plugins[pluginId]?.getWebviewManager().getElement("tiktok");
            if (!wv) return null;
            try { return await wv.executeJavaScript(src); } catch (err) { return { __error: String(err) }; }
        },
        PLUGIN_ID,
        js,
    );
    return (raw as T) ?? null;
}

/** Load the fixture fresh (resets the collapsed state) and wait for the button. */
async function loadFixture(): Promise<void> {
    await browser.executeObsidian(({ app }, pluginId, url) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (app as any).plugins.plugins[pluginId].getWebviewManager().getElement("tiktok").loadURL(url);
    }, PLUGIN_ID, FIXTURE_URL);
    await browser.waitUntil(
        async () => (await inWebview<boolean>("!!document.getElementById('collections')")) === true,
        { timeout: 15_000, timeoutMsg: "fixture never loaded #collections", interval: 300 },
    );
}

const linksVisible = async (): Promise<number> =>
    (await inWebview<number>(
        "document.getElementById('collection-list').style.display !== 'none' ? document.querySelectorAll('a[href*=\"/collection/\"]').length : 0",
    )) ?? 0;

describe("TikTok Collections sub-tab activation", function () {
    this.timeout(90_000);

    before(async function () {
        await ensureTikTokWebviewReady();
    });

    it("control: a synthetic .click() is ignored (trusted-gating works)", async function () {
        await loadFixture();
        await inWebview("document.getElementById('collections').click();"); // isTrusted:false
        await browser.pause(500);
        expect(await linksVisible()).toBe(0);
    });

    it("shipped: a trusted mouse click (after scrollIntoView) reveals the collections", async function () {
        await loadFixture();
        const coords = await inWebview<string>(`
            (function () {
              var btn = document.getElementById('collections');
              btn.scrollIntoView({ block: 'center' });
              var r = btn.getBoundingClientRect();
              return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
            })()
        `);
        const { x, y } = JSON.parse(coords!);
        await browser.executeObsidian(({ app }, pluginId, pt) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = (app as any).plugins.plugins[pluginId].getWebviewManager().getElement("tiktok");
            wv.sendInputEvent({ type: "mouseDown", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
            wv.sendInputEvent({ type: "mouseUp", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        }, PLUGIN_ID, { x, y });
        await browser.pause(800);
        expect(await linksVisible()).toBeGreaterThan(0);
    });

    it("probe: does a coordinate-free trusted Enter also activate it?", async function () {
        await loadFixture();
        await inWebview("document.getElementById('collections').focus();");
        await browser.executeObsidian(({ app }, pluginId) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const wv = (app as any).plugins.plugins[pluginId].getWebviewManager().getElement("tiktok");
            wv.focus?.();
            wv.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
            wv.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        }, PLUGIN_ID);
        await browser.pause(800);
        const count = await linksVisible();
        // Informational, not a hard gate: this is the answer to "can we drop the
        // pixel math?". Logged so the run output records it either way.
        // eslint-disable-next-line no-console
        console.log(`[e2e] coordinate-free Enter activation → collections visible: ${count > 0} (${count} links)`);
    });
});
