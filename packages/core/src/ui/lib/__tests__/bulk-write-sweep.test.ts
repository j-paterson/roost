// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { TFile } from "obsidian";
import { bulkWriteAssignments, type BulkWriteFileManager, type BulkWritePlugin, type BulkWriteEventBus } from "../bulk-write-assignments";

function mkFile(path: string): TFile { return { path } as TFile; }

function mkHarness(n: number, delayMs: number) {
  const files = new Map<string, TFile>();
  const fmStore = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < n; i++) {
    const path = `Bookmarks/i${i}.md`;
    files.set(`i${i}`, mkFile(path));
    fmStore.set(path, { roost_id: `i${i}` });
  }
  const plugin: BulkWritePlugin = { bulkWriteInProgress: false };
  const events: BulkWriteEventBus = { trigger: () => {} };
  const fileManager: BulkWriteFileManager = {
    async processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void) {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      const draft = { ...(fmStore.get(file.path) ?? {}) };
      fn(draft);
      fmStore.set(file.path, draft);
    },
  };
  return { files, fmStore, plugin, events, fileManager };
}

async function bench(n: number, concurrency: number, delayMs: number, runs: number) {
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const h = mkHarness(n, delayMs);
    const m = new Map<string, string>();
    for (let i = 0; i < n; i++) m.set(`i${i}`, "Music");
    const t0 = performance.now();
    const result = await bulkWriteAssignments({
      itemAssignments: m,
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, v) => ({ roost_category: v }),
      log: () => {},
      setProgress: () => {},
      concurrency,
    });
    times.push(performance.now() - t0);
    expect(result.tagged).toBe(n);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}

// Slow benchmark (~57s). Run explicitly: npx vitest run bulk-write-sweep
describe.skip("concurrency sweep — 426 items", () => {
  const N = 426;
  const RUNS = 3;
  const levels = [1, 2, 4, 6, 8, 10, 15, 20, 30, 50];

  for (const delayMs of [2, 5, 10]) {
    const label = delayMs < 5 ? "fast SSD" : delayMs < 10 ? "normal disk" : "synced storage";

    it(`sweep @ ${delayMs}ms I/O (${label})`, async () => {
      const results: { c: number; ms: number }[] = [];
      for (const c of levels) {
        const ms = await bench(N, c, delayMs, RUNS);
        results.push({ c, ms });
      }

      const seq = results[0].ms;
      console.log(`\n--- ${N} items @ ${delayMs}ms I/O (${label}) ---`);
      console.log("concurrency | median ms | speedup | vs prev");
      let prev = seq;
      for (const { c, ms } of results) {
        const speedup = seq / ms;
        const vsPrev = prev / ms;
        console.log(
          `${String(c).padStart(11)} | ${ms.toFixed(0).padStart(9)} | ${speedup.toFixed(1).padStart(6)}x | ${c === 1 ? "baseline" : (vsPrev > 1.05 ? `+${((vsPrev - 1) * 100).toFixed(0)}%` : "~same")}`,
        );
        prev = ms;
      }

      // Correctness: highest concurrency still writes everything
      const h = mkHarness(N, delayMs);
      const m = new Map<string, string>();
      for (let i = 0; i < N; i++) m.set(`i${i}`, "Music");
      const finalResult = await bulkWriteAssignments({
        itemAssignments: m,
        fileByKey: h.files,
        fileManager: h.fileManager,
        plugin: h.plugin,
        events: h.events,
        patchFor: (_, v) => ({ roost_category: v }),
        log: () => {},
        setProgress: () => {},
        concurrency: 50,
      });
      expect(finalResult.tagged).toBe(N);
      expect(finalResult.errors).toBe(0);
    }, 60_000);
  }
});
