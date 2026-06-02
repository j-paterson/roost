/**
 * Confirm blink trace E2E — captures render trace events during Smart Assign
 * confirm to identify what causes gallery re-renders after bulk writes.
 *
 * Replays the fixture snapshot, enables the render trace, clicks Confirm,
 * waits for the sidebar to return to sync mode + metadata cache to settle,
 * then reads the trace log. Asserts on what actually fired rather than
 * guessing.
 *
 * ── What we're trying to learn ──
 *
 * After Confirm writes N files via processFrontMatter:
 *   - Does onDataUpdated fire once, N times, or not at all?
 *   - Does applyFilter fire per-file or once?
 *   - Are rebuilds guarded by bulkWriteInProgress during writes?
 *   - How many rebuilds happen AFTER the flag flips off?
 *   - What's the time gap between flag-off and the last rebuild?
 */

import { browser } from "@wdio/globals";

const STAGING_TIMEOUT = 30_000;

async function openRoostSidebar(): Promise<void> {
    await browser.executeObsidianCommand("roost:open");
    const sidebarEl = await $(".roost-root");
    await sidebarEl.waitForDisplayed({ timeout: 30_000 });
    await browser.pause(2000);
}

async function ensureSyncMode(): Promise<void> {
    const smartAssignBtn = await $("button=Smart Assign");
    const alreadySync = await smartAssignBtn.isDisplayed().catch(() => false);
    if (alreadySync) return;
    await browser.execute(() => {
        const allBtns = Array.from(document.querySelectorAll("button"));
        const cancelBtn = allBtns.find((b) =>
            b.textContent?.trim() === "Cancel" || b.textContent?.trim() === "✕"
        ) as HTMLElement | undefined;
        if (cancelBtn) cancelBtn.click();
    });
    await smartAssignBtn.waitForDisplayed({ timeout: 15_000 });
}

async function replayFixtureSnapshot(): Promise<void> {
    await ensureSyncMode();
    const replayBtn = await $("button*=Replay");
    await replayBtn.waitForDisplayed({ timeout: 10_000 });
    await browser.execute((el) => (el as HTMLElement).click(), replayBtn);
    const firstItem = await $(".roost-dropdown-item");
    await firstItem.waitForDisplayed({ timeout: 5_000 });
    await browser.execute((el) => (el as HTMLElement).click(), firstItem);
    const stagingTree = await $(".nav-folder-children");
    await stagingTree.waitForDisplayed({ timeout: STAGING_TIMEOUT });
    await browser.pause(1000);
}

interface TraceEntry {
    t: number;
    name: string;
    data?: Record<string, unknown>;
}

describe("Confirm blink trace", function () {
    before(async function () {
        await openRoostSidebar();
    });

    it("captures trace events during confirm to identify rebuild source", async function () {
        await replayFixtureSnapshot();

        // Enable the render trace before clicking Confirm.
        await browser.execute(() => {
            (window as any).__roostTraceEnabled = true;
            (window as any).__roostTrace = [];
            (window as any).__roostTraceStart = Date.now();
        });

        const confirmBtn = await $("button=Confirm Categories");
        await confirmBtn.waitForDisplayed({ timeout: STAGING_TIMEOUT });
        await browser.execute((el) => (el as HTMLElement).click(), confirmBtn);

        // Wait for sidebar to return to sync mode (confirm finished).
        const smartAssignBtn = await $("button=Smart Assign");
        await smartAssignBtn.waitForDisplayed({ timeout: 30_000 });

        // Let metadata cache fully settle.
        await browser.pause(3000);

        // Collect the trace.
        const trace = await browser.execute(() => {
            return (window as any).__roostTrace as TraceEntry[];
        }) as TraceEntry[];

        // Disable tracing.
        await browser.execute(() => {
            (window as any).__roostTraceEnabled = false;
        });

        // ── Analysis ──
        console.log(`\nTotal trace events: ${trace.length}`);
        console.log(`Time span: ${trace.length > 0 ? trace[trace.length - 1].t : 0}ms\n`);

        // Count events by name.
        const counts = new Map<string, number>();
        for (const e of trace) {
            counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
        }
        console.log("Event counts:");
        for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${name}: ${count}`);
        }

        // Show timeline of key events.
        const keyEvents = trace.filter(e =>
            e.name.includes("onDataUpdated") ||
            e.name.includes("applyFilter") ||
            e.name.includes("bulkWrite") ||
            e.name.includes("rebuild")
        );
        console.log(`\nKey event timeline (${keyEvents.length} events):`);
        for (const e of keyEvents) {
            const dataStr = e.data ? ` ${JSON.stringify(e.data)}` : "";
            console.log(`  +${e.t}ms  ${e.name}${dataStr}`);
        }

        // Count rebuilds that happened while flag was ON vs OFF.
        const guardedCount = trace.filter(e => e.name === "onDataUpdated:guarded").length;
        const enterCount = trace.filter(e => e.name === "onDataUpdated:enter").length;
        const rebuildCount = trace.filter(e => e.name === "onDataUpdated:rebuild").length;
        const filterEnterCount = trace.filter(e => e.name === "applyFilter:enter").length;
        const filterDeferredCount = trace.filter(e => e.name === "applyFilter:deferred").length;

        console.log(`\nSummary:`);
        console.log(`  onDataUpdated:enter    = ${enterCount}`);
        console.log(`  onDataUpdated:guarded  = ${guardedCount} (suppressed by bulkWriteInProgress)`);
        console.log(`  onDataUpdated:rebuild  = ${rebuildCount} (actual grid rebuilds)`);
        console.log(`  applyFilter:enter      = ${filterEnterCount}`);
        console.log(`  applyFilter:deferred   = ${filterDeferredCount} (suppressed by bulkWriteInProgress)`);

        // Find flag-off timestamp.
        const flagOff = trace.find(e => e.name === "bulkWrite:flagOff");
        if (flagOff) {
            const rebuildsAfterFlagOff = trace.filter(
                e => e.t > flagOff.t && (e.name === "onDataUpdated:rebuild" || e.name === "applyFilter:beforeRender")
            );
            console.log(`\n  bulkWrite:flagOff at +${flagOff.t}ms`);
            console.log(`  Rebuilds AFTER flag off: ${rebuildsAfterFlagOff.length}`);
            if (rebuildsAfterFlagOff.length > 0) {
                console.log(`    First rebuild at +${rebuildsAfterFlagOff[0].t}ms (${rebuildsAfterFlagOff[0].t - flagOff.t}ms after flag off)`);
                console.log(`    Last rebuild at +${rebuildsAfterFlagOff[rebuildsAfterFlagOff.length - 1].t}ms (${rebuildsAfterFlagOff[rebuildsAfterFlagOff.length - 1].t - flagOff.t}ms after flag off)`);
            }
        } else {
            console.log(`\n  bulkWrite:flagOff NOT FOUND in trace`);
        }

        // The test passes regardless — it's diagnostic. But assert we got trace data.
        expect(trace.length).toBeGreaterThan(0);
    });
});
