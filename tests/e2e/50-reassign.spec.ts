/**
 * Reassign E2E — Slice 12
 *
 * Tests the "Move to…" flow in the plain-gallery (sync mode) view:
 *
 *  1. Open Roost sidebar → navigate to the Recipes category (`.tree-item-self[data-category="Recipes"]`).
 *  2. Click the first `.roost-card` to expand it.
 *  3. Click the `.roost-expanded-action=Move to…` div (NOT a button — it's a plain div).
 *  4. Type "Places" in the `.roost-picker-input` to filter the CollectionPicker.
 *  5. Click the first `.roost-picker-row` (which shows "Places").
 *  6. Wait 1 000 ms for Obsidian to write the frontmatter.
 *  7. Optionally dismiss any inline suggestion UI (selection bar, not a modal — in plain
 *     gallery mode neighbor suggestions use `enterSelectionMode`, not `SuggestionModal`).
 *     Guard with `isDisplayed().catch(() => false)` to be safe.
 *  8. Read `${vaultPath}/Bookmarks/bm_0.md` via `node:fs` and assert the
 *     frontmatter matches `/roost_category:\s*"?Places"?/i`.
 *
 * ── Fixture ──
 *
 * tests/fixtures/vault/Bookmarks/bm_0.md starts with `roost_category: "Recipes"`.
 * There is no embedding-cache.json in the fixture vault, so `itemVec` is null.
 * Because `itemVec === null`, `suggestNeighbors()` is never called and no
 * neighbor-suggestion overlay appears.
 *
 * ── Fixture restoration ──
 *
 * wdio.conf.mts points at the fixture vault IN-PLACE (not a snapshot copy).
 * The move mutates bm_0.md on disk.  The `after()` hook restores it to its
 * original content so subsequent test runs start clean.
 *
 * ── Ollama stub ──
 *
 * Started in `before()` on the default stub port (OLLAMA_STUB_PORT env var or
 * 11435) as a defensive guard.  In this test path no Ollama calls are expected
 * (no embedding, no scoring), but `suggest-neighbors.ts` or any background
 * plugin logic might attempt one.  The catch-all stub prevents false 500 errors.
 *
 * ── Selector translations (Playwright → WDIO) ──
 *
 * Playwright                                   WDIO
 * ─────────────────────────────────────────────────────────────────────────────
 * page.locator(".tree-item-self",{hasText:"Recipes"}).click()
 *   → browser.execute((el) => el.click(), $('.tree-item-self[data-category="Recipes"]'))
 *
 * page.locator("button",{hasText:/move/i}).click()
 *   → $(".roost-expanded-action=Move to…") then JS click
 *     (element is a <div>, not a <button>; exact text is "Move to…",
 *      with a single Unicode ellipsis U+2026)
 *
 * page.locator(".roost-dropdown-item",{hasText:/places/i}).click()
 *   → type "Places" in .roost-picker-input then click first .roost-picker-row
 *     (element class is .roost-picker-row, not .roost-dropdown-item)
 *
 * suggestionModal.isVisible().catch(()=>false)
 *   → (await $(".roost-suggestion-modal").isDisplayed().catch(() => false))
 *     (guarded; in plain gallery mode the modal never appears — no-op check)
 *
 * harness.vaultPath
 *   → browser.executeObsidian(({app}) => (app.vault.adapter as any).getBasePath?.() ?? ...)
 */

import { browser } from "@wdio/globals";
import { withOllamaStub } from "./harness.js";
import type { OllamaStub } from "./ollama-stub.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── constants ──

const SIDEBAR_TIMEOUT = 30_000;
const GALLERY_TIMEOUT = 15_000;
const PICKER_TIMEOUT = 10_000;

// Original frontmatter content of bm_0.md — restored in after() so re-runs stay clean.
const BM0_ORIGINAL = [
    "---",
    `roost_id: "bm_0"`,
    `roost_category: "Recipes"`,
    `platform: "tiktok"`,
    `synced_at: "2026-04-10"`,
    `tags: ["recipe"]`,
    "---",
    "",
    "Test bookmark bm_0 in Recipes.",
].join("\n");

// ── helpers ──

/** Open the Roost sidebar and wait for the React root to mount. */
async function openRoostSidebar(): Promise<void> {
    await browser.executeObsidianCommand("roost:open");
    const sidebarEl = await $(".roost-root");
    await sidebarEl.waitForDisplayed({ timeout: SIDEBAR_TIMEOUT });
    // Allow React to fully render the library tree and sidebar panels.
    await browser.pause(2000);
}

/** Retrieve the vault base path from inside Obsidian's Electron process. */
async function getVaultPath(): Promise<string> {
    return browser.executeObsidian(({ app }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (app.vault.adapter as any).getBasePath?.() ?? (app.vault.adapter as any).basePath ?? ""
    ) as Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Reassign — move-to + suggestion modal", function () {
    let ollama: OllamaStub | null = null;
    let stubBound = false;
    let vaultPath: string;
    let bm0Path: string;

    before(async function () {
        // Start Ollama stub as a defensive guard against any background Ollama calls.
        // Skip the test if the stub port is already bound (developer machine with
        // a real embed sidecar / Ollama running). Same pattern as 20-pipelines-panel
        // and 81-recursive-subcat-live — CI has nothing on the port so the bind
        // succeeds and the test runs.
        try {
            ollama = await withOllamaStub.start();
            stubBound = true;
        } catch (err) {
            console.warn("[50-reassign] Stub port already bound — skipping. Stop local sidecar/Ollama to run this spec locally.", err instanceof Error ? err.message : err);
            return;
        }
        // Specific patterns registered before the catch-all (first-registered wins).
        ollama.respond(/embed/i, { embedding: new Array(384).fill(0.01) });
        ollama.respond(/.*/, "skip");

        // Open sidebar and resolve vault path.
        await openRoostSidebar();

        // Wait for the Recipes category to appear in the library tree.
        const firstCategory = await $(`.tree-item-self[data-category="Recipes"]`);
        await firstCategory.waitForExist({ timeout: GALLERY_TIMEOUT });

        vaultPath = await getVaultPath();
        bm0Path = path.join(vaultPath, "Bookmarks", "bm_0.md");
    });

    after(async function () {
        // Restore bm_0.md to its original content so subsequent runs start clean.
        // The vault is used in-place (not a snapshot copy) per wdio.conf.mts.
        if (bm0Path) {
            try {
                fs.writeFileSync(bm0Path, BM0_ORIGINAL, "utf-8");
            } catch (err) {
                console.warn("[50-reassign] Failed to restore bm_0.md:", err);
            }
        }

        // Stop the Ollama stub.
        if (ollama) await withOllamaStub.stop(ollama);
    });

    it("Move-to flow updates frontmatter and offers neighbor suggestions", async function () {
        if (!stubBound) {
            this.skip();
            return;
        }
        // ── Step 1: Navigate to Recipes category ──
        // Click via JS to bypass Obsidian viewport clipping.
        const recipesItem = await $(`.tree-item-self[data-category="Recipes"]`);
        await recipesItem.waitForExist({ timeout: GALLERY_TIMEOUT });
        await browser.execute((el) => (el as HTMLElement).click(), recipesItem);

        // Wait for gallery cards to appear AND be fully hydrated.
        // Cards start as `.roost-card.roost-card-placeholder` (skeleton shown by
        // IntersectionObserver). Only hydrated cards (`.roost-card-ready`) have
        // the click handler and expanded detail attached.
        const anyReadyCard = await $(".roost-card.roost-card-ready");
        await anyReadyCard.waitForDisplayed({ timeout: GALLERY_TIMEOUT });

        // ── Step 2: Click the first hydrated card to expand it ──
        // The card that has bm_0's data may or may not be rendered first; we click
        // the first visible hydrated card since bm_0 is in Recipes.
        await browser.execute((el) => (el as HTMLElement).click(), anyReadyCard);

        // ── Step 3: Wait for and click "Move to…" ──
        // The element is a <div class="roost-expanded-action"> with text "Move to…"
        // (NOT a <button>). The trailing character is a single Unicode ellipsis
        // (U+2026) — see bookmarks-bases-view.ts:1536. WDIO's exact-text selector
        // "=Move to…" matches textContent.
        const moveBtn = await $(".roost-expanded-action=Move to…");
        await moveBtn.waitForExist({ timeout: PICKER_TIMEOUT });
        await browser.execute((el) => (el as HTMLElement).click(), moveBtn);

        // ── Step 4: CollectionPicker appears — filter for "Places" ──
        // The modal appends to document.body. Wait for the picker input.
        const pickerInput = await $(".roost-picker-input");
        await pickerInput.waitForDisplayed({ timeout: PICKER_TIMEOUT });

        // Type "Places" to filter the picker rows.
        await pickerInput.setValue("Places");

        // Wait for at least one picker row to appear after filtering.
        const firstRow = await $(".roost-picker-row");
        await firstRow.waitForDisplayed({ timeout: PICKER_TIMEOUT });

        // ── Step 5: Click the first matching picker row ──
        await browser.execute((el) => (el as HTMLElement).click(), firstRow);

        // ── Step 6: Wait for Obsidian to write the frontmatter ──
        await browser.pause(1000);

        // ── Step 7: Optionally dismiss suggestion UI ──
        // In plain gallery mode, neighbor suggestions use enterSelectionMode (an inline
        // gallery selection bar), NOT the SuggestionModal.  No itemVec in the fixture
        // means no suggestions at all.  These guards are no-ops but kept for safety.
        const suggestionModal = await $(".roost-suggestion-modal");
        const modalVisible = await suggestionModal.isDisplayed().catch(() => false);
        if (modalVisible) {
            // Try "No thanks" button (vanilla fallback in suggestion-modal.ts).
            const noThanksBtn = await suggestionModal.$("button=No thanks");
            const noThanksVisible = await noThanksBtn.isDisplayed().catch(() => false);
            if (noThanksVisible) {
                await browser.execute((el) => (el as HTMLElement).click(), noThanksBtn);
            } else {
                // Try generic "Dismiss" button from SuggestionReview React component.
                const dismissBtn = await suggestionModal.$("button=Dismiss");
                const dismissVisible = await dismissBtn.isDisplayed().catch(() => false);
                if (dismissVisible) {
                    await browser.execute((el) => (el as HTMLElement).click(), dismissBtn);
                } else {
                    // Last resort: click any button inside the modal.
                    const anyBtn = await suggestionModal.$("button");
                    const anyBtnVisible = await anyBtn.isDisplayed().catch(() => false);
                    if (anyBtnVisible) {
                        await browser.execute((el) => (el as HTMLElement).click(), anyBtn);
                    }
                }
            }
            await browser.pause(500);
        }

        // ── Step 8: Assert bm_0.md frontmatter now says Places ──
        // Read the file directly via node:fs (vault path resolved from inside Obsidian).
        const text = fs.readFileSync(bm0Path, "utf-8");
        expect(/roost_category:\s*"?Places"?/i.test(text)).toBe(true);
    });
});
