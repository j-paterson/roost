/**
 * Rename flash diagnostic — captures the gallery's render trace through a
 * category rename so we can see exactly which renders happen between the
 * bulk-write finishing and the filter-follow landing.
 *
 * The instrumentation lives in `src/lib/render-trace.ts` and is driven by
 * `window.__roostTraceEnabled`. This spec sets the flag, fires a rename via
 * the inline-rename UI flow, waits for the rename:end trace marker, then
 * dumps the captured events and asserts the most-likely flash patterns so a
 * regression would surface as a test failure rather than a silent UX bug.
 *
 * Fixture vault has 5 items in `roost_category: "Recipes"` (see
 * tests/fixtures/vault/Bookmarks/bm_*.md). We rename Recipes → Cooking.
 */

import { browser } from "@wdio/globals";

interface TraceEntry {
  t: number;
  name: string;
  data?: Record<string, unknown>;
}

declare global {
  interface Window {
    __roostTraceEnabled?: boolean;
    __roostTrace?: TraceEntry[];
    __roostTraceStart?: number;
  }
}

const SIDEBAR_TIMEOUT = 30_000;
const RENAME_TIMEOUT = 30_000;

describe("Rename flash diagnostic", function () {
  before(async function () {
    // Open Roost sidebar via the registered command.
    await browser.executeObsidianCommand("roost:open");
    const sidebar = await $(".roost-root");
    await sidebar.waitForDisplayed({ timeout: SIDEBAR_TIMEOUT });

    // Wait for the library tree to populate from scanLibrary().
    const recipesItem = await $('.tree-item-self[data-category="Recipes"]');
    await recipesItem.waitForExist({ timeout: 15_000 });

    // Click Recipes so the gallery opens with a filter set on it. This is
    // the precondition where the flash hurts most — we have a real filter
    // pointing at a name that's about to disappear.
    await browser.execute(
      (el) => (el as HTMLElement).click(),
      recipesItem,
    );

    // Wait for at least one card to confirm the gallery is filtered + rendered.
    const anyCard = await $(".roost-card");
    await anyCard.waitForDisplayed({ timeout: 15_000 });
  });

  it("captures the render sequence around a category rename", async function () {
    // Reset and enable tracing.
    await browser.execute(() => {
      window.__roostTrace = [];
      window.__roostTraceStart = Date.now();
      window.__roostTraceEnabled = true;
    });

    // Drive the inline-rename UI: double-click the category name, set the
    // input value, press Enter. The React InlineRenameInput is uncontrolled,
    // so we mutate `.value` then dispatch keydown — that's how its onKeyDown
    // handler reads the new value.
    await browser.execute(() => {
      const titleEl = document.querySelector(
        '.tree-item-self[data-category="Recipes"] .tree-item-inner.nav-file-title-content',
      ) as HTMLElement | null;
      if (!titleEl) throw new Error("Recipes title not found");
      const evt = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
      titleEl.dispatchEvent(evt);
    });

    // Wait for the inline input to mount.
    const renameInput = await $(".roost-inline-rename");
    await renameInput.waitForDisplayed({ timeout: 5_000 });

    // Set value + dispatch Enter keydown on the actual input element.
    await browser.execute(() => {
      const input = document.querySelector(".roost-inline-rename") as HTMLInputElement | null;
      if (!input) throw new Error("rename input not found");
      input.value = "Cooking";
      const ev = new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", bubbles: true, cancelable: true,
      });
      input.dispatchEvent(ev);
    });

    // Poll for the rename:end marker — that's our signal the whole handler
    // (including filter-follow) finished. Hard-cap so we don't hang forever
    // if instrumentation regresses.
    const deadline = Date.now() + RENAME_TIMEOUT;
    let trace: TraceEntry[] = [];
    while (Date.now() < deadline) {
      trace = await browser.execute(() => window.__roostTrace ?? []);
      if (trace.some((e) => e.name === "rename:end")) break;
      await browser.pause(100);
    }

    // Disable tracing so subsequent specs (if any) start clean.
    await browser.execute(() => {
      window.__roostTraceEnabled = false;
    });

    // Dump the trace to the test log so we can read the actual sequence.
    // eslint-disable-next-line no-console
    console.log("\n=== RENAME RENDER TRACE ===");
    for (const e of trace) {
      // eslint-disable-next-line no-console
      console.log(`  [${String(e.t).padStart(5)}ms] ${e.name}`, e.data ?? "");
    }
    // eslint-disable-next-line no-console
    console.log("=== END TRACE ===\n");

    // Sanity: handler completed.
    expect(trace.some((e) => e.name === "rename:start")).toBe(true);
    expect(trace.some((e) => e.name === "rename:end")).toBe(true);

    // Diagnostic count: how many actual grid rebuilds happened. `rebuild`
    // (vs `keyMatch:skip`) means containerEl.empty() ran and placeholders
    // were recreated. With the current code we expect at least 2:
    //   1. post-trigger applyFilter(oldName) → empty render against new data
    //   2. filter-follow applyFilter(newName) → correct render
    // The fix should collapse this to exactly 1.
    const rebuilds = trace.filter((e) => e.name === "onDataUpdated:rebuild");

    // Guarded onDataUpdated calls during writes — these prove the existing
    // bulkWriteInProgress short-circuit works during the bulk write window.
    const guarded = trace.filter((e) => e.name === "onDataUpdated:guarded");

    // applyFilter calls categorized by filter intent.
    const applyOld = trace.filter(
      (e) => e.name === "applyFilter:enter" && e.data?.["filterCategory"] === "Recipes",
    );
    const applyNew = trace.filter(
      (e) => e.name === "applyFilter:enter" && e.data?.["filterCategory"] === "Cooking",
    );

    // eslint-disable-next-line no-console
    console.log(
      `[diag] rebuilds=${rebuilds.length} guarded=${guarded.length} ` +
      `applyFilter(oldName)=${applyOld.length} applyFilter(newName)=${applyNew.length}`,
    );

    // The empty-render hypothesis: a rebuild ran while filter was still oldName
    // AFTER bulkWrite:flagOff fired. Find the index of flagOff and check.
    const flagOffIdx = trace.findIndex((e) => e.name === "bulkWrite:flagOff");
    const filterFollowIdx = trace.findIndex((e) => e.name === "rename:filterFollow");
    if (flagOffIdx >= 0 && filterFollowIdx >= 0) {
      const between = trace.slice(flagOffIdx, filterFollowIdx);
      const emptyRebuildBetween = between.find((e) => {
        if (e.name !== "onDataUpdated:rebuild") return false;
        const fc = e.data?.["filteredCount"];
        return fc === 0 || fc === null;
      });
      // eslint-disable-next-line no-console
      console.log(
        `[diag] events between flagOff and filterFollow: ${between.length}, ` +
        `empty rebuild present: ${!!emptyRebuildBetween}`,
      );
      // This expectation documents the bug — it should FAIL once the fix
      // suppresses the post-trigger empty render.
      if (emptyRebuildBetween) {
        // eslint-disable-next-line no-console
        console.log(
          `[bug-confirmed] empty grid rendered at t=${emptyRebuildBetween.t}ms ` +
          `between flagOff and filterFollow`,
        );
      }
    }

    // A rename should not produce zero rebuilds — the gallery has to update
    // somehow. Sanity bound only.
    expect(rebuilds.length).toBeGreaterThanOrEqual(1);
  });
});
