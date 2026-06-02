// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { TFile } from "obsidian";
import { bulkWriteAssignments, type BulkWriteFileManager, type BulkWritePlugin, type BulkWriteEventBus } from "../bulk-write-assignments";

function mkFile(path: string): TFile {
  return { path } as TFile;
}

interface Harness {
  fileManager: BulkWriteFileManager;
  plugin: BulkWritePlugin;
  events: BulkWriteEventBus;
  files: Map<string, TFile>;
  fmStore: Map<string, Record<string, unknown>>;
  triggerCalls: string[];
  flagSequence: boolean[]; // values of bulkWriteInProgress sampled at each processFrontMatter call
  progressCalls: { done: number; total: number }[];
  log: (m: string) => void;
  logs: string[];
  callOrder: string[];
}

function mkHarness(opts: {
  ids: string[];
  delayMs?: number;
  failIds?: Set<string>;
  /** Pre-existing frontmatter values per id. Useful for alreadySet tests. */
  initialFm?: Map<string, Record<string, unknown>>;
}): Harness {
  const files = new Map<string, TFile>();
  const fmStore = new Map<string, Record<string, unknown>>();
  for (const id of opts.ids) {
    const path = `Bookmarks/${id}.md`;
    files.set(id, mkFile(path));
    fmStore.set(path, { roost_id: id, ...(opts.initialFm?.get(id) ?? {}) });
  }

  const triggerCalls: string[] = [];
  const flagSequence: boolean[] = [];
  const progressCalls: { done: number; total: number }[] = [];
  const logs: string[] = [];
  const callOrder: string[] = [];

  const plugin: BulkWritePlugin = { bulkWriteInProgress: false };
  const events: BulkWriteEventBus = { trigger: (name) => { triggerCalls.push(name); } };

  const fileManager: BulkWriteFileManager = {
    async processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void) {
      flagSequence.push(plugin.bulkWriteInProgress);
      const id = file.path.split("/").pop()!.replace(/\.md$/, "");
      callOrder.push(`pfm:${file.path}`);
      if (opts.failIds?.has(id)) throw new Error(`pfm fail: ${id}`);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const current = fmStore.get(file.path) ?? {};
      const draft = { ...current };
      fn(draft);
      fmStore.set(file.path, draft);
    },
  };

  return {
    fileManager, plugin, events, files, fmStore,
    triggerCalls, flagSequence, progressCalls, logs, callOrder,
    log: (m) => { logs.push(m); },
  };
}

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `i${i}`);
}

function assignments(n: number): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) m.set(`i${i}`, "Music");
  return m;
}

describe("bulkWriteAssignments", () => {
  it("writes all items and returns counts", async () => {
    const h = mkHarness({ ids: ids(5) });
    const result = await bulkWriteAssignments({
      itemAssignments: assignments(5),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value, roost_subcategory: null, roost_assigned_by: "auto" }),
      log: h.log,
      setProgress: (done, total) => { h.progressCalls.push({ done, total }); },
    });
    expect(result.tagged).toBe(5);
    expect(result.errors).toBe(0);
    expect(result.alreadySet).toBe(0);
    expect(result.notFound).toBe(0);
    // Each file's frontmatter got the assigned category.
    for (let i = 0; i < 5; i++) {
      expect(h.fmStore.get(`Bookmarks/i${i}.md`)?.roost_category).toBe("Music");
    }
  });

  it("fires events.trigger('resolved') exactly once after writes", async () => {
    const h = mkHarness({ ids: ids(3) });
    await bulkWriteAssignments({
      itemAssignments: assignments(3),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
    });
    expect(h.triggerCalls).toEqual(["resolved"]);
  });

  it("flips bulkWriteInProgress true during writes, false at end", async () => {
    const h = mkHarness({ ids: ids(3), delayMs: 5 });
    expect(h.plugin.bulkWriteInProgress).toBe(false);
    await bulkWriteAssignments({
      itemAssignments: assignments(3),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
    });
    expect(h.flagSequence.every(v => v === true)).toBe(true);
    expect(h.flagSequence.length).toBe(3);
    expect(h.plugin.bulkWriteInProgress).toBe(false);
  });

  it("calls setProgress monotonically with total = N", async () => {
    const h = mkHarness({ ids: ids(7) });
    await bulkWriteAssignments({
      itemAssignments: assignments(7),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: (done, total) => { h.progressCalls.push({ done, total }); },
    });
    expect(h.progressCalls.length).toBeGreaterThan(0);
    for (const c of h.progressCalls) expect(c.total).toBe(7);
    let prev = -1;
    for (const c of h.progressCalls) {
      expect(c.done).toBeGreaterThanOrEqual(prev);
      prev = c.done;
    }
    expect(h.progressCalls[h.progressCalls.length - 1].done).toBe(7);
  });

  it("processes files concurrently up to the concurrency limit", async () => {
    let peak = 0;
    let inflight = 0;
    const h = mkHarness({ ids: ids(8), delayMs: 20 });
    const original = h.fileManager.processFrontMatter;
    h.fileManager.processFrontMatter = async (file, fn) => {
      inflight++;
      if (inflight > peak) peak = inflight;
      try {
        return await original.call(h.fileManager, file, fn);
      } finally {
        inflight--;
      }
    };
    await bulkWriteAssignments({
      itemAssignments: assignments(8),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
      concurrency: 3,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("counts notFound items without invoking processFrontMatter", async () => {
    const h = mkHarness({ ids: ids(3) });
    const m = new Map<string, string>();
    m.set("i0", "Music");
    m.set("missing-id", "Music");
    m.set("i1", "Music");
    const result = await bulkWriteAssignments({
      itemAssignments: m,
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
    });
    expect(result.notFound).toBe(1);
    expect(result.tagged).toBe(2);
    // Missing key never reached the file manager.
    expect(h.callOrder).not.toContain("pfm:Bookmarks/missing-id.md");
  });

  it("alreadySet when patch matches existing frontmatter", async () => {
    const initial = new Map<string, Record<string, unknown>>([
      ["i0", { roost_category: "Music" }],
      ["i1", { roost_category: "Anime" }],
    ]);
    const h = mkHarness({ ids: ids(2), initialFm: initial });
    const result = await bulkWriteAssignments({
      itemAssignments: new Map([["i0", "Music"], ["i1", "Music"]]),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
    });
    // i0 already has roost_category=Music → alreadySet. i1 has Anime → tagged.
    expect(result.alreadySet).toBe(1);
    expect(result.tagged).toBe(1);
  });

  it("null in patch removes the field", async () => {
    const initial = new Map<string, Record<string, unknown>>([
      ["i0", { roost_category: "Music", roost_subcategory: "Pop" }],
    ]);
    const h = mkHarness({ ids: ids(1), initialFm: initial });
    await bulkWriteAssignments({
      itemAssignments: new Map([["i0", "ignored"]]),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: () => ({ roost_category: null, roost_subcategory: null }),
      log: h.log,
      setProgress: () => {},
    });
    const fm = h.fmStore.get("Bookmarks/i0.md")!;
    expect("roost_category" in fm).toBe(false);
    expect("roost_subcategory" in fm).toBe(false);
  });

  it("processFrontMatter failures don't abort the batch", async () => {
    const h = mkHarness({ ids: ids(5), failIds: new Set(["i2"]) });
    const result = await bulkWriteAssignments({
      itemAssignments: assignments(5),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
    });
    expect(result.tagged).toBe(4);
    expect(result.errors).toBe(1);
    expect(h.triggerCalls).toEqual(["resolved"]);
    expect(h.plugin.bulkWriteInProgress).toBe(false);
  });

  it("calls patchFor with key and value for each item", async () => {
    const h = mkHarness({ ids: ids(3) });
    const calls: { key: string; value: string }[] = [];
    await bulkWriteAssignments({
      itemAssignments: new Map([["i0", "Music"], ["i1", "Anime"], ["i2", "Gaming"]]),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (key, value) => {
        calls.push({ key, value });
        return { roost_category: value };
      },
      log: h.log,
      setProgress: () => {},
    });
    expect(calls.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "i0", value: "Music" },
      { key: "i1", value: "Anime" },
      { key: "i2", value: "Gaming" },
    ]);
  });

  it("runUnderGuard runs after writes and observes flag still true", async () => {
    const h = mkHarness({ ids: ids(3) });
    let flagDuringCallback = false;
    let pfmCallsBeforeGuard = 0;
    await bulkWriteAssignments({
      itemAssignments: new Map([["i0", "A"], ["i1", "B"], ["i2", "C"]]),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
      runUnderGuard: () => {
        flagDuringCallback = h.plugin.bulkWriteInProgress;
        pfmCallsBeforeGuard = h.callOrder.length;
      },
    });
    expect(flagDuringCallback).toBe(true);
    expect(pfmCallsBeforeGuard).toBe(3);
    expect(h.plugin.bulkWriteInProgress).toBe(false);
  });

  it("runUnderGuard error still flips flag off and propagates", async () => {
    const h = mkHarness({ ids: ids(2) });
    let caught: Error | null = null;
    try {
      await bulkWriteAssignments({
        itemAssignments: new Map([["i0", "X"], ["i1", "Y"]]),
        fileByKey: h.files,
        fileManager: h.fileManager,
        plugin: h.plugin,
        events: h.events,
        patchFor: (_, value) => ({ roost_category: value }),
        log: h.log,
        setProgress: () => {},
        runUnderGuard: () => { throw new Error("callback boom"); },
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("callback boom");
    expect(h.plugin.bulkWriteInProgress).toBe(false);
  });

  it("custom concurrency doesn't break correctness", async () => {
    const h = mkHarness({ ids: ids(5) });
    const result = await bulkWriteAssignments({
      itemAssignments: assignments(5),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
      concurrency: 2,
    });
    expect(result.tagged).toBe(5);
  });
});

describe.skip("bulkWriteAssignments — speed benchmarks", () => {
  async function timedRun(n: number, concurrency: number, delayMs: number) {
    const h = mkHarness({ ids: ids(n), delayMs });
    const t0 = Date.now();
    const result = await bulkWriteAssignments({
      itemAssignments: assignments(n),
      fileByKey: h.files,
      fileManager: h.fileManager,
      plugin: h.plugin,
      events: h.events,
      patchFor: (_, value) => ({ roost_category: value }),
      log: h.log,
      setProgress: () => {},
      concurrency,
    });
    const elapsed = Date.now() - t0;
    return { result, elapsed, fmStore: h.fmStore };
  }

  it("concurrent (10) is ≥3x faster than sequential for 100 items @ 10ms I/O", async () => {
    const seq = await timedRun(100, 1, 10);
    const par = await timedRun(100, 10, 10);

    expect(seq.result.tagged).toBe(100);
    expect(par.result.tagged).toBe(100);
    expect(par.elapsed).toBeLessThan(seq.elapsed / 3);
  });

  it("concurrent (10) is ≥5x faster than sequential for 500 items @ 5ms I/O", async () => {
    const seq = await timedRun(500, 1, 5);
    const par = await timedRun(500, 10, 5);

    expect(seq.result.tagged).toBe(500);
    expect(par.result.tagged).toBe(500);
    expect(par.elapsed).toBeLessThan(seq.elapsed / 5);
  });

  it("higher concurrency (20) still improves over default (10) for 200 items @ 10ms I/O", async () => {
    const c10 = await timedRun(200, 10, 10);
    const c20 = await timedRun(200, 20, 10);

    expect(c10.result.tagged).toBe(200);
    expect(c20.result.tagged).toBe(200);
    expect(c20.elapsed).toBeLessThan(c10.elapsed);
  });

  it("correctness holds at scale: all 500 items written with concurrency=10", async () => {
    const { result, fmStore } = await timedRun(500, 10, 1);

    expect(result.tagged).toBe(500);
    expect(result.errors).toBe(0);
    for (let i = 0; i < 500; i++) {
      expect(fmStore.get(`Bookmarks/i${i}.md`)?.roost_category).toBe("Music");
    }
  });

  it("concurrency=1 runs no faster than sequential baseline (sanity check)", async () => {
    const N = 50;
    const DELAY = 10;
    const { elapsed } = await timedRun(N, 1, DELAY);
    expect(elapsed).toBeGreaterThanOrEqual(N * DELAY * 0.8);
  });
});
