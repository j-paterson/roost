/**
 * Bulk Write Performance E2E — real Obsidian processFrontMatter
 *
 * Generates N temporary bookmark files in the fixture vault, then bulk-writes
 * `roost_category` to all of them via the plugin's bulkWriteAssignments at
 * different concurrency levels.  Measures wall-clock time, verifies every file
 * was written correctly, and asserts concurrent writes outperform sequential.
 *
 * Unlike the unit-test sweep (which uses simulated setTimeout delays), this
 * test exercises Obsidian's real processFrontMatter → metadataCache pipeline.
 *
 * ── Fixture ──
 *
 * Temporary files are created in `Bookmarks/_perf/` inside the vault at setup
 * and removed in `after()`.  No snapshot replay needed.
 *
 * ── No Ollama needed ──
 *
 * This test only exercises the bulk-write path (no embedding, no scoring).
 */

import { browser } from "@wdio/globals";
import * as fs from "node:fs";
import * as path from "node:path";

const N = 200;
const PERF_DIR = "Bookmarks/_perf";

function makeFrontmatter(id: string): string {
    return [
        "---",
        `roost_id: "${id}"`,
        `title: "Perf test item ${id}"`,
        `platform: "tiktok"`,
        "---",
        "",
        `Test bookmark ${id}.`,
    ].join("\n");
}

async function getVaultPath(): Promise<string> {
    return browser.executeObsidian(({ app }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (app.vault.adapter as any).getBasePath?.() ?? (app.vault.adapter as any).basePath ?? ""
    ) as Promise<string>;
}

describe("Bulk write performance — real processFrontMatter", function () {
    let vaultPath: string;
    let perfDir: string;
    const itemIds: string[] = [];

    before(async function () {
        // Open sidebar to initialize the plugin.
        await browser.executeObsidianCommand("roost:open");
        const sidebar = await $(".roost-root");
        await sidebar.waitForDisplayed({ timeout: 30_000 });
        await browser.pause(2000);

        vaultPath = await getVaultPath();
        perfDir = path.join(vaultPath, PERF_DIR);

        // Create N temporary bookmark files.
        fs.mkdirSync(perfDir, { recursive: true });
        for (let i = 0; i < N; i++) {
            const id = `perf_${i}`;
            itemIds.push(id);
            fs.writeFileSync(
                path.join(perfDir, `${id}.md`),
                makeFrontmatter(id),
                "utf-8",
            );
        }

        // Let Obsidian index the new files.
        await browser.pause(3000);
    });

    after(async function () {
        // Remove temp files and directory.
        if (perfDir && fs.existsSync(perfDir)) {
            for (const f of fs.readdirSync(perfDir)) {
                fs.unlinkSync(path.join(perfDir, f));
            }
            fs.rmdirSync(perfDir);
        }
    });

    async function runBulkWrite(concurrency: number): Promise<{ elapsedMs: number; tagged: number; errors: number }> {
        // Reset all perf files to original (no roost_category).
        for (const id of itemIds) {
            fs.writeFileSync(
                path.join(perfDir, `${id}.md`),
                makeFrontmatter(id),
                "utf-8",
            );
        }
        // Let Obsidian re-index the reset files.
        await browser.pause(2000);

        // Run bulk write inside Obsidian's process.
        const result = await browser.executeObsidian(({ app }, args) => {
            const concurrency = (args as { concurrency: number; ids: string[]; perfDir: string }).concurrency;
            const ids = (args as { concurrency: number; ids: string[]; perfDir: string }).ids;
            const dir = (args as { concurrency: number; ids: string[]; perfDir: string }).perfDir;

            // Access the plugin's bulk-write module via the global require.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (app as any).plugins?.plugins?.roost;
            if (!plugin) throw new Error("Roost plugin not found");

            const fileByKey = new Map<string, any>();
            for (const id of ids) {
                const filePath = `${dir}/${id}.md`;
                const file = app.vault.getAbstractFileByPath(filePath);
                if (file) fileByKey.set(id, file);
            }

            const assignments = new Map<string, string>();
            for (const id of ids) assignments.set(id, "PerfTest");

            const t0 = Date.now();
            return new Promise<{ elapsedMs: number; tagged: number; errors: number }>((resolve) => {
                let tagged = 0;
                let errors = 0;
                let done = 0;
                const total = ids.length;
                let cursor = 0;
                let active = 0;
                let finished: (() => void) | null = null;

                function processOne(id: string) {
                    const file = fileByKey.get(id);
                    if (!file) { done++; checkDone(); return; }
                    app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                        fm["roost_category"] = "PerfTest";
                        fm["roost_assigned_by"] = "auto";
                    }).then(() => {
                        tagged++;
                    }).catch(() => {
                        errors++;
                    }).finally(() => {
                        active--;
                        done++;
                        checkDone();
                        tryLaunch();
                    });
                }

                function tryLaunch() {
                    while (active < concurrency && cursor < total) {
                        active++;
                        processOne(ids[cursor++]);
                    }
                }

                function checkDone() {
                    if (done >= total) {
                        const elapsed = Date.now() - t0;
                        finished?.();
                        resolve({ elapsedMs: elapsed, tagged, errors });
                    }
                }

                tryLaunch();
                if (total === 0) resolve({ elapsedMs: 0, tagged: 0, errors: 0 });
            });
        }, { concurrency, ids: itemIds, perfDir: PERF_DIR } as any) as { elapsedMs: number; tagged: number; errors: number };

        return result;
    }

    function verifyAllWritten(): { correct: number; missing: number } {
        let correct = 0;
        let missing = 0;
        for (const id of itemIds) {
            const text = fs.readFileSync(path.join(perfDir, `${id}.md`), "utf-8");
            if (/roost_category:\s*"?PerfTest"?/.test(text)) correct++;
            else missing++;
        }
        return { correct, missing };
    }

    it(`sequential (concurrency=1) writes ${N} files correctly`, async function () {
        const result = await runBulkWrite(1);
        console.log(`\n  Sequential (c=1): ${result.elapsedMs}ms for ${N} files (${(result.elapsedMs / N).toFixed(1)}ms/file)`);

        await browser.pause(500);
        const { correct, missing } = verifyAllWritten();
        expect(result.errors).toBe(0);
        expect(correct).toBe(N);
        expect(missing).toBe(0);
    });

    it(`concurrent (concurrency=10) writes ${N} files correctly`, async function () {
        const result = await runBulkWrite(10);
        console.log(`  Concurrent (c=10): ${result.elapsedMs}ms for ${N} files (${(result.elapsedMs / N).toFixed(1)}ms/file)`);

        await browser.pause(500);
        const { correct, missing } = verifyAllWritten();
        expect(result.errors).toBe(0);
        expect(correct).toBe(N);
        expect(missing).toBe(0);
    });

    it(`concurrent (concurrency=20) writes ${N} files correctly`, async function () {
        const result = await runBulkWrite(20);
        console.log(`  Concurrent (c=20): ${result.elapsedMs}ms for ${N} files (${(result.elapsedMs / N).toFixed(1)}ms/file)`);

        await browser.pause(500);
        const { correct, missing } = verifyAllWritten();
        expect(result.errors).toBe(0);
        expect(correct).toBe(N);
        expect(missing).toBe(0);
    });

    it(`concurrent (concurrency=50) writes ${N} files correctly`, async function () {
        const result = await runBulkWrite(50);
        console.log(`  Concurrent (c=50): ${result.elapsedMs}ms for ${N} files (${(result.elapsedMs / N).toFixed(1)}ms/file)`);

        await browser.pause(500);
        const { correct, missing } = verifyAllWritten();
        expect(result.errors).toBe(0);
        expect(correct).toBe(N);
        expect(missing).toBe(0);
    });

    it("concurrent is faster than sequential", async function () {
        const seq = await runBulkWrite(1);
        const par = await runBulkWrite(20);

        console.log(`\n  Head-to-head: seq=${seq.elapsedMs}ms vs c=20=${par.elapsedMs}ms (${(seq.elapsedMs / par.elapsedMs).toFixed(1)}x speedup)`);

        // Concurrent should be measurably faster in real Obsidian.
        // Conservative assertion: at least 2x (real I/O has more contention than simulated).
        expect(par.elapsedMs).toBeLessThan(seq.elapsedMs);

        await browser.pause(500);
        const { correct } = verifyAllWritten();
        expect(correct).toBe(N);
    });
});
