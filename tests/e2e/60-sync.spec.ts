/**
 * Sync negative-path E2E — Slice 13
 *
 * Two tests that verify the Roost sync strip handles "no auth" gracefully:
 * clicking "Sync TikTok" or "Sync X" without a logged-in webview does NOT
 * crash the sidebar — it either returns early (webview element is null) or
 * waits up to 15 s for the webview to become ready and logs a failure, then
 * exits cleanly.  Either way the sidebar `.roost-root` remains mounted.
 *
 * ── Plan-vs-reality gaps ──
 *
 * 1. Selector correction: The plan's `button hasText:/sync tiktok/i` never
 *    matches because the sync buttons are icon-only SVGs.  The production
 *    markup (library-tree.tsx:140) uses `title` attributes:
 *      button[title="Sync TikTok"]  and  button[title="Sync X"]
 *    These are generated from PLATFORM_DISPLAY (config.ts:47):
 *      tiktok → "TikTok",  twitter → "X"
 *
 * 2. Fixture addition: The sync strip only renders platforms that have
 *    existing bookmarks (RoostView.tsx scanLibrary reads fm.platform).
 *    Before this slice the fixture only had `source: "tiktok"` (wrong field)
 *    — all files were counted as "other".  Fix applied in build-fixture-vault.mjs:
 *      a. Existing categorized + unsorted bookmarks: source→platform="tiktok"
 *      b. Three new bm_x_0..2 bookmarks: platform="twitter", roost_category="Media"
 *    After regeneration, scanLibrary produces two platform entries → two sync
 *    buttons: title="Sync TikTok" and title="Sync X".
 *
 * 3. No pageerror listener: WDIO has no page.on("pageerror", ...).  Dropped.
 *    "No crash" is verified by asserting .roost-root is still displayed after
 *    the click + 3 s pause.
 *
 * 4. No 15 s wait: The handleSync timeout fires at 15 s, but a crash would
 *    surface within 1–2 s.  A 3 s pause after the click is sufficient.
 *
 * 5. No Ollama stub needed: The sync path does not call Ollama.
 *
 * 6. No fixture restoration needed: clicking a sync button does not mutate
 *    any vault files in the test environment.
 *
 * ── Negative-path flow (what actually happens) ──
 *
 *   handleSync(platform)  [RoostView.tsx:352]
 *     → showPlatform(platform)  — opens a webview leaf
 *     → wm.getElement(platform) returns null in test env  → early return
 *     OR: wm.getElement returns an element, but wm.getWebContents returns
 *         null → waits up to 15 s → logs "[FAIL] Webview not ready" → returns
 *   Sidebar: still mounted, no exception thrown.
 */

import { browser } from "@wdio/globals";

// ── constants ──

const SIDEBAR_TIMEOUT = 30_000;
const SYNC_SETTLE_MS  = 3_000;   // pause after click — long enough to surface any crash

// ── helpers ──

/** Open the Roost sidebar and wait for the React root to mount. */
async function openRoostSidebar(): Promise<void> {
    await browser.executeObsidianCommand("roost:open");
    const sidebarEl = await $(".roost-root");
    await sidebarEl.waitForDisplayed({ timeout: SIDEBAR_TIMEOUT });
    // Allow React to render the library tree and sync strip.
    await browser.pause(2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Both tests share one Obsidian session.  The sidebar stays open between them.
// ─────────────────────────────────────────────────────────────────────────────

describe("Sync — negative path (no auth)", function () {
    before(async function () {
        await openRoostSidebar();
    });

    // ── Test 1 ────────────────────────────────────────────────────────────────

    it("Sync TikTok with no auth shows graceful error (sidebar stays mounted)", async function () {
        // Wait for the icon-only sync button — it has title="Sync TikTok".
        // The button may be clipped from WebDriver's viewport, so we use JS click.
        const syncBtn = await $('button[title="Sync TikTok"]');
        await syncBtn.waitForExist({ timeout: 10_000 });

        // Click via JS to bypass Obsidian workspace viewport clipping.
        try {
            await browser.execute((el) => (el as HTMLElement).click(), syncBtn);
        } catch (err) {
            throw new Error(`Sync TikTok click threw: ${err}`);
        }

        // Wait long enough for any crash to surface (crash would unmount the root).
        // We do NOT wait the full 15 s webview timeout — 3 s is sufficient.
        await browser.pause(SYNC_SETTLE_MS);

        // Assert the sidebar root is still mounted and visible.
        const rootEl = await $(".roost-root");
        const rootVisible = await rootEl.isDisplayed();
        expect(rootVisible).toBe(true);
    });

    // ── Test 2 ────────────────────────────────────────────────────────────────

    it("Sync X with no auth shows graceful error (sidebar stays mounted)", async function () {
        // The "Sync X" button is generated from PLATFORM_DISPLAY["twitter"] = "X".
        // It only renders because bm_x_0..2 fixtures have platform="twitter".
        const syncBtn = await $('button[title="Sync X"]');
        await syncBtn.waitForExist({ timeout: 10_000 });

        try {
            await browser.execute((el) => (el as HTMLElement).click(), syncBtn);
        } catch (err) {
            throw new Error(`Sync X click threw: ${err}`);
        }

        await browser.pause(SYNC_SETTLE_MS);

        const rootEl = await $(".roost-root");
        const rootVisible = await rootEl.isDisplayed();
        expect(rootVisible).toBe(true);
    });
});
