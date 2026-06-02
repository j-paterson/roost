/**
 * Boot smoke test — confirms Obsidian starts, loads the fixture vault, and
 * has the Roost plugin enabled.
 *
 * Translated from the original Playwright spec (see 2026-04-20 Addendum in
 * the testing plan) to WebdriverIO + mocha.
 *
 * Behavioral intent (from Slice 6.5 of the testing plan):
 *  - Obsidian launches against the fixture vault
 *  - The workspace loads (DOM has content)
 *  - The roost plugin is in the enabled set
 *  - The Roost sidebar leaf is openable and renders a root element
 */

import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const PLUGIN_ID = "roost";

describe("Boot smoke", function () {
    // The vault and plugin are configured in wdio.conf.mts via capabilities.
    // wdio-obsidian-service copies the fixture vault and injects the built
    // plugin before Obsidian starts, so no per-test setup is needed here.

    it("Obsidian loads and the workspace DOM is non-trivial", async function () {
        // Wait for the app-container div — this is the root Obsidian workspace element
        const workspace = await $(".app-container");
        await expect(workspace).toExist();

        // The body should contain substantial markup
        const bodyHTML = await $("body").getHTML();
        expect(bodyHTML.length).toBeGreaterThan(500);
    });

    it(`plugin '${PLUGIN_ID}' is enabled in app.plugins`, async function () {
        // executeObsidian runs arbitrary code inside the Obsidian Electron process.
        // The 'app' object is the live Obsidian App instance.
        const isEnabled = await browser.executeObsidian(({ app }, pluginId: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (app as any).plugins.enabledPlugins.has(pluginId);
        }, PLUGIN_ID);

        expect(isEnabled).toBe(true);
    });

    it("vault contains the expected fixture bookmark files", async function () {
        // executeObsidian to list markdown files in the Bookmarks folder
        const bookmarkCount = await browser.executeObsidian(({ app }) => {
            return app.vault.getMarkdownFiles()
                .filter((f) => f.path.startsWith("Bookmarks/"))
                .length;
        });

        // The fixture vault has 50 bookmark notes seeded by build-fixture-vault.mjs
        expect(bookmarkCount).toBeGreaterThanOrEqual(10);
    });

    it("Roost sidebar leaf can be activated via command", async function () {
        // Open the Roost sidebar view using the "open" command registered in main.ts
        // Full ID: pluginId:commandId → "roost:open"
        await browser.executeObsidianCommand("roost:open");

        // Wait for the sidebar panel to mount — RoostView mounts React into a
        // div.roost-root inside the leaf container
        const sidebarEl = await $(".roost-root");
        await expect(sidebarEl).toExist();
    });
});
