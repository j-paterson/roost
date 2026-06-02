/**
 * Recursive Subcategorize E2E — Task 5 (Live Pipeline)
 *
 * Runs the LIVE Smart Assign pipeline against two new unsorted fixture items
 * and asserts:
 *   1. The staging panel shows at least one SubcategoryView node (data-subcat="true")
 *   2. Confirming categories writes composite frontmatter to disk:
 *        - bm_u_recipe_italian → roost_category: "Recipes" + roost_subcategory: "Italian"
 *        - bm_u_recipe_misc    → roost_category: "Recipes" + roost_subcategory: null
 *
 * ── Why these two items ──
 *
 * The fixture vault has:
 *   - bm_recipe_it_1..4  — anchor items with roost_category="Recipes" + roost_subcategory="Italian"
 *   - bm_recipe_fr_1..4  — anchor items with roost_category="Recipes" + roost_subcategory="French"
 *   - bm_u_recipe_italian — unsorted; title="Spaghetti carbonara"  (matches Recipes/Italian)
 *   - bm_u_recipe_misc    — unsorted; title="Generic food video"    (matches Recipes, no specific subcat)
 *
 * The 15 bm_u_0..14 items have NO vectors in embedding-vectors.bin so they
 * are never passed to the LLM — only the 2 new items receive T1/T2/T1-NONE calls.
 *
 * ── Ollama stub response design ──
 *
 * The stub must handle 4 prompt types per test item (order of registration matters —
 * first-match-wins):
 *
 *   1. T1-NONE (Spaghetti carbonara) → "A"
 *      Match: "or N if none of them fit well" AND "Spaghetti carbonara"
 *      Returns letter "A" so Italian is picked for this item.
 *
 *   2. T1-NONE catch-all → "N"
 *      Match: "or N if none of them fit well"
 *      Returns "N" so Generic food video stays at parent (Recipes) with no subcat.
 *
 *   3. T2 → {"A":9,"B":1,"C":1,"D":1,"E":1,"F":1,"G":1}
 *      Match: "Respond with JSON only"
 *      Returns high score for first candidate so Recipes always wins.
 *
 *   4. T1 catch-all → "A"
 *      Match: "Pick which collection best fits."
 *      Returns "A" (first candidate = Recipes based on centroid similarity).
 *
 * Handlers are registered in the order above so the more specific T1-NONE
 * for Spaghetti carbonara is checked before the general T1-NONE catch-all.
 *
 * ── Sidecar stub ──
 *
 * AgentManager.ensureReady() probes BOTH port 11434 (Ollama) and port 11435
 * (embed sidecar) via GET /api/tags. Both stubs must respond 200.
 * The sidecar stub for this spec shares the same probe-handler logic but
 * doesn't need any LLM stub handlers — no embed calls are made for cached items.
 *
 * ── Embedding vectors ──
 *
 * tests/fixtures/vault/.roost/embedding-vectors.bin contains pre-computed
 * 768-dim float32 vectors for:
 *   - bm_0..34              (anchor: 7 top-level collections)
 *   - bm_recipe_it_1..4     (Recipes/Italian)
 *   - bm_recipe_fr_1..4     (Recipes/French)
 *   - bm_x_0..2             (X/Twitter anchors)
 *   - bm_u_recipe_italian   (test item; Italian-aligned vector)
 *   - bm_u_recipe_misc      (test item; Recipes-aligned vector)
 *
 * bm_u_0..14 are intentionally ABSENT → no T1/T2 calls for them.
 *
 * ── Collection descriptions ──
 *
 * tests/fixtures/vault/.roost/collection-descriptions-contrastive.json and
 * collection-not-descriptions.json are pre-populated with all 7 collection
 * descriptions so generateClusterDescriptions() is skipped entirely
 * (checked: collDescs.size === 0 || collNotDescs.size === 0 → false → skip).
 *
 * ── Selector reference ──
 *
 *   button=Smart Assign         — sync-mode entry point
 *   button*=Run                 — topic editor "Run (N topics)" button
 *   [data-subcat="true"]        — SubcatNode rendered when assignedSubcategories has non-null
 *   button=Confirm Categories   — staging mode, pipelineStep=6
 */

import { browser } from "@wdio/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { startOllamaStub, stopOllamaStub } from "./ollama-stub.js";
import type { OllamaStub } from "./ollama-stub.js";

// ── constants ──

const PIPELINE_TIMEOUT = 90_000;  // full live pipeline: embed → score → review
const CONFIRM_TIMEOUT  = 30_000;

// ── helpers ──

/** Open the Roost sidebar and wait for the React root to mount. */
async function openRoostSidebar(): Promise<void> {
    await browser.executeObsidianCommand("roost:open");
    const sidebarEl = await $(".roost-root");
    await sidebarEl.waitForDisplayed({ timeout: 30_000 });
    await browser.pause(2000);
}

/**
 * Ensure the sidebar is in sync mode.
 * If the pipeline is running / paused in topic-editor mode, cancel it first.
 */
async function ensureSyncMode(): Promise<void> {
    const smartAssignBtn = await $("button=Smart Assign");
    const alreadySync = await smartAssignBtn.isDisplayed().catch(() => false);
    if (alreadySync) return;

    await browser.execute(() => {
        const buttons = Array.from(document.querySelectorAll(".shrink-0.border-b button"));
        const cancelBtn = buttons.find((b) => b.textContent?.trim() === "✕") as HTMLElement | undefined;
        if (cancelBtn) cancelBtn.click();
    });
    await browser.pause(1500);

    const afterClick = await smartAssignBtn.isDisplayed().catch(() => false);
    if (!afterClick) {
        await browser.execute(() => {
            const allBtns = Array.from(document.querySelectorAll("button"));
            const cancelBtn = allBtns.find((b) => b.textContent?.trim() === "✕") as HTMLElement | undefined;
            if (cancelBtn) cancelBtn.click();
        });
        await smartAssignBtn.waitForDisplayed({ timeout: 15_000 });
    }
}

/** Retrieve the vault base path from inside Obsidian's Electron process. */
async function getVaultPath(): Promise<string> {
    return browser.executeObsidian(({ app }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (app.vault.adapter as any).getBasePath?.() ?? (app.vault.adapter as any).basePath ?? ""
    ) as Promise<string>;
}

/** Read YAML frontmatter field value from a markdown file on disk. */
function readFrontmatterField(filePath: string, field: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, "utf-8");
    const m = text.match(new RegExp(`${field}:\\s*["']?([^"'\\n\\r]+)["']?`));
    if (!m) return null;
    const val = m[1].trim();
    return (val === "null") ? null : val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Recursive subcategorize — live pipeline", function () {
    let ollamaStub: OllamaStub | null = null;
    let sidecarStub: OllamaStub | null = null;
    let stubsBound = false;

    // Original file contents — used to restore fixture files after the test
    // so the spec is idempotent across re-runs.
    let italianOriginal: string;
    let miscOriginal: string;

    before(async function () {
        // ── Start Ollama stub (port 11434) ──
        // If real Ollama is running on this port (developer machine), the bind
        // will fail with EADDRINUSE and we skip the test. CI has no Ollama, so
        // the stub binds and the test runs. Same pattern as 20-pipelines-panel.
        try {
            ollamaStub = await startOllamaStub(11434);
            sidecarStub = await startOllamaStub(11435);
            stubsBound = true;
        } catch (err) {
            console.warn("[81-recursive-subcat-live] Ollama/sidecar port already bound — skipping. Stop local Ollama (`pkill ollama`) to run this spec locally.", err instanceof Error ? err.message : err);
            if (ollamaStub) await stopOllamaStub(ollamaStub);
            ollamaStub = null;
            sidecarStub = null;
            return;
        }

        // Register handlers in specificity order: most specific first, catch-alls last.

        // T1-NONE for Spaghetti carbonara → pick "A" (Italian)
        // Must be registered BEFORE the general T1-NONE catch-all.
        ollamaStub.respond(
            /or N if none of them fit well[\s\S]*Spaghetti carbonara/,
            "A",
        );

        // T1-NONE catch-all → "N" (Generic food video stays at parent, no subcat)
        ollamaStub.respond("or N if none of them fit well", "N");

        // T2 → high score for first candidate (Recipes wins top-level)
        ollamaStub.respond(
            "Respond with JSON only",
            JSON.stringify({ A: 9, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1 }),
        );

        // T1 catch-all → "A" (first candidate wins)
        ollamaStub.respond("Pick which collection best fits.", "A");

        // ── Snapshot fixture file contents before they may be modified ──
        // We save these here so we can restore them in afterAll, ensuring the
        // test is idempotent even if Confirm Categories writes to the files.
        const vaultPath = await getVaultPath();
        const bookmarksDir = path.join(vaultPath, "Bookmarks");
        const italianPath = path.join(bookmarksDir, "bm_u_recipe_italian.md");
        const miscPath    = path.join(bookmarksDir, "bm_u_recipe_misc.md");
        italianOriginal = fs.existsSync(italianPath) ? fs.readFileSync(italianPath, "utf-8") : "";
        miscOriginal    = fs.existsSync(miscPath)    ? fs.readFileSync(miscPath,    "utf-8") : "";

        await openRoostSidebar();
    });

    after(async function () {
        if (!stubsBound) return;

        // ── Restore fixture files ──
        const vaultPath = await getVaultPath();
        const bookmarksDir = path.join(vaultPath, "Bookmarks");
        if (italianOriginal) fs.writeFileSync(path.join(bookmarksDir, "bm_u_recipe_italian.md"), italianOriginal, "utf-8");
        if (miscOriginal)    fs.writeFileSync(path.join(bookmarksDir, "bm_u_recipe_misc.md"),    miscOriginal,    "utf-8");

        // ── Stop stubs ──
        if (ollamaStub) await stopOllamaStub(ollamaStub);
        if (sidecarStub) await stopOllamaStub(sidecarStub);
    });

    it("Live pipeline writes roost_category + roost_subcategory for both test items", async function () {
        if (!stubsBound) {
            this.skip();
            return;
        }
        await ensureSyncMode();

        // ── Step 1: Click "Smart Assign" ──
        // This calls buildFilterInput → run() → setMode("topics")
        // and opens the topic editor showing detected vault categories.
        const smartAssignBtn = await $("button=Smart Assign");
        await smartAssignBtn.waitForDisplayed({ timeout: 10_000 });
        await browser.execute((el) => (el as HTMLElement).click(), smartAssignBtn);

        // ── Step 2: Click "Run (N topics)" in the topic editor ──
        // The button text starts with "Run" and includes the topic count.
        // It triggers runClustering_() → full pipeline.
        const runBtn = await $("button*=Run");
        await runBtn.waitForDisplayed({ timeout: 15_000 });
        await browser.execute((el) => (el as HTMLElement).click(), runBtn);

        // ── Step 3: Wait for staging mode with subcategory nodes ──
        // The pipeline runs: Embed → Score Known (T1+T2+T1-NONE) → Discover →
        // Describe (skipped — cache present) → Edit → Score New → Review.
        // When pipelineStep=6 and mode="staging", the staging tree renders.
        // We wait for "Confirm Categories" as the signal.
        const confirmBtn = await $("button=Confirm Categories");
        await confirmBtn.waitForDisplayed({ timeout: PIPELINE_TIMEOUT });

        // ── Step 4: Assert subcategory nodes are visible ──
        // SubcatNode renders data-subcat="true" when assignedSubcategories has
        // at least one non-null value. bm_u_recipe_italian should get "Italian".
        const subcatNodes = await $$('[data-subcat="true"]');
        const subcatCount = subcatNodes.length;
        expect(subcatCount).toBeGreaterThan(0);

        // ── Step 5: Click "Confirm Categories" ──
        await browser.execute((el) => (el as HTMLElement).click(), confirmBtn);

        // Wait for sidebar to return to sync mode.
        const smartAssignAfter = await $("button=Smart Assign");
        await smartAssignAfter.waitForDisplayed({ timeout: CONFIRM_TIMEOUT });

        // Brief settle for file writes to flush.
        await browser.pause(500);

        // ── Step 6: Assert frontmatter on disk ──
        const vaultPath = await getVaultPath();
        const bookmarksDir = path.join(vaultPath, "Bookmarks");
        const italianPath = path.join(bookmarksDir, "bm_u_recipe_italian.md");
        const miscPath    = path.join(bookmarksDir, "bm_u_recipe_misc.md");

        // bm_u_recipe_italian → Recipes + Italian
        const italianCat    = readFrontmatterField(italianPath, "roost_category");
        const italianSubcat = readFrontmatterField(italianPath, "roost_subcategory");
        expect(italianCat).toBe("Recipes");
        expect(italianSubcat).toBe("Italian");

        // bm_u_recipe_misc → Recipes + no subcat
        const miscCat    = readFrontmatterField(miscPath, "roost_category");
        const miscSubcat = readFrontmatterField(miscPath, "roost_subcategory");
        expect(miscCat).toBe("Recipes");
        expect(miscSubcat).toBeNull();

        // ── Step 7: Assert no unexpected stub calls ──
        const unexpected = ollamaStub.unexpectedCalls();
        if (unexpected.length > 0) {
            console.warn("[81-recursive-subcat-live] Unexpected Ollama calls:", unexpected.map(u => u.fingerprint));
        }
        expect(unexpected.length).toBe(0);
    });
});
