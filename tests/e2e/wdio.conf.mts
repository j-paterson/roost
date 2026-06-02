/**
 * WebdriverIO configuration for Roost E2E tests using wdio-obsidian-service.
 *
 * wdio-obsidian-service sidesteps the Playwright --log-level=3 / _electron.launch() timeout
 * (playwright#39008, #28547, #19854) by driving Obsidian via ChromeDriver's
 * --remote-debugging-port (Blink-level) rather than --inspect (Node-level).
 *
 * Version note: browserVersion is set to "latest" which resolves to the newest
 * non-beta Obsidian release at download time (≥1.7.x).  The service auto-downloads
 * a matching ChromeDriver for the Electron version bundled in that installer.
 * Roost requires Obsidian 1.10+ (Bases API). Default pin: 1.10.0.
 */

import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// *.live.spec.ts files require real credentials and are EXCLUDED from the
// default run. To run a live spec explicitly, set E2E_RUN_LIVE=1 (the exclude
// list is then suppressed) and pass --spec:
//   E2E_RUN_LIVE=1 npx wdio run tests/e2e/wdio.conf.mts \
//     --spec tests/e2e/86-x-article-real-backfill.live.spec.ts
const RUN_LIVE = process.env["E2E_RUN_LIVE"] === "1";
/** Promo screenshot spec — only when PROMO_CAPTURE=1 (see npm run capture:promo). */
const RUN_PROMO = process.env["PROMO_CAPTURE"] === "1";
/** Burst frame spec — only when PROMO_BURST=1 (see npm run capture:promo:burst). */
const RUN_PROMO_BURST = process.env["PROMO_BURST"] === "1";
/** Pin Obsidian app version. Default `latest` stable (no Insiders login).
 *  For 1.10+ betas: pre-download with `npx obsidian-launcher download app -v 1.10.0`
 *  or set OBSIDIAN_INSIDERS credentials. Override: OBSIDIAN_E2E_VERSION=1.10.0 */
const OBSIDIAN_VERSION = process.env["OBSIDIAN_E2E_VERSION"] ?? "latest";
/** Stop after first failing test when E2E_BAIL=1 (useful while debugging). */
const E2E_BAIL = process.env["E2E_BAIL"] === "1";

export const config: WebdriverIO.Config = {
    runner: "local",
    framework: "mocha",
    specs: [path.join(__dirname, "**/*.spec.ts")],
    exclude: [
        ...(RUN_LIVE ? [] : [path.join(__dirname, "**/*.live.spec.ts")]),
        ...(RUN_PROMO ? [] : [path.join(__dirname, "**/99-promo-capture.spec.ts")]),
        ...(RUN_PROMO_BURST ? [] : [path.join(__dirname, "**/99b-promo-video-burst.spec.ts")]),
    ],
    // E2E tests are intentionally serial — Obsidian opens one vault at a time
    maxInstances: 1,

    capabilities: [
        {
            browserName: "obsidian",
            // "latest" resolves to the newest stable non-beta Obsidian release.
            // The service downloads the matching Electron-compatible installer
            // and ChromeDriver automatically.
            browserVersion: OBSIDIAN_VERSION,
            "wdio:obsidianOptions": {
                // Install the plugin from the project root (main.js + manifest.json)
                // on top of whatever is already in the fixture vault.
                plugins: [repoRoot],
                // Default vault for the boot smoke test.  Specs that need a
                // clean slate call browser.reloadObsidian({vault: ...}) in before().
                vault: path.join(repoRoot, "tests/fixtures/vault"),
            },
        },
    ],

    services: ["obsidian"],

    // obsidian reporter wraps spec-reporter and shows the Obsidian app version
    // instead of the raw Chromium version in the output header.
    reporters: ["obsidian"],

    // Download cache for Obsidian installers + ChromeDriver binaries
    cacheDir: path.join(repoRoot, ".obsidian-cache"),

    mochaOpts: {
        ui: "bdd",
        timeout: 120_000,
        ...(E2E_BAIL ? { bail: true } : {}),
    },

    logLevel: "warn",
};
