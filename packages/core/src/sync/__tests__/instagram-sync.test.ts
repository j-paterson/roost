import { describe, it, expect, vi } from "vitest";
import { paginateSaved, paginateCollections, type IgFetch } from "@/sync/instagram-sync";

function page(items: { code: string }[], next: string | null) {
  return {
    status: 200,
    body: JSON.stringify({
      items: items.map((i) => ({ media: { code: i.code, pk: i.code, media_type: 1, taken_at: 1700000000, user: { username: "u" } } })),
      more_available: next != null,
      next_max_id: next,
      num_results: items.length,
    }),
  };
}

function collPage(items: { id: string; name: string }[], next: string | null) {
  return {
    status: 200,
    body: JSON.stringify({
      items: items.map((c) => ({ collection_id: c.id, collection_name: c.name, collection_media_count: 1 })),
      more_available: next != null,
      next_max_id: next,
    }),
  };
}

describe("paginateCollections", () => {
  it("follows next_max_id across pages and merges all collections", async () => {
    const igFetch: IgFetch = vi.fn()
      .mockResolvedValueOnce(collPage([{ id: "1", name: "Recipes" }, { id: "2", name: "Travel" }], "CUR1"))
      .mockResolvedValueOnce(collPage([{ id: "3", name: "Art" }], null));
    const map = await paginateCollections(igFetch, async () => {}, () => {});
    expect(map.size).toBe(3);
    expect(map.get("2")?.name).toBe("Travel");
    expect(map.get("3")?.name).toBe("Art");
    // second call carries the cursor verbatim
    expect((igFetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("max_id=CUR1");
  });

  it("stops on a single page when more_available is false", async () => {
    const igFetch: IgFetch = vi.fn().mockResolvedValue(collPage([{ id: "1", name: "Only" }], null));
    const map = await paginateCollections(igFetch, async () => {}, () => {});
    expect(map.size).toBe(1);
    expect((igFetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("paginateSaved", () => {
  const collMap = new Map<string, { name: string; count: number }>();

  it("follows next_max_id until more_available is false", async () => {
    const igFetch: IgFetch = vi.fn()
      .mockResolvedValueOnce(page([{ code: "a" }, { code: "b" }], "CURSOR1"))
      .mockResolvedValueOnce(page([{ code: "c" }], null));
    const emitted: string[] = [];
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async (recs) => { emitted.push(...recs.map((r) => r.id)); },
      collMap, knownIds: new Set(), mode: "full", batchSize: 1,
      maxItems: null, isStopped: () => false, onLog: () => {}, onProgress: () => {},
    });
    expect(res.totalFetched).toBe(3);
    expect(emitted).toEqual(["instagram:a", "instagram:b", "instagram:c"]);
    // second call carries the cursor verbatim
    expect((igFetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("max_id=CURSOR1");
  });

  it("quick mode stops at the first already-known item", async () => {
    // Page 1: two new then one known; quick should emit only the two new and stop.
    const fetch = vi.fn().mockResolvedValue(
      page([{ code: "new1" }, { code: "new2" }, { code: "known1" }, { code: "new3" }], "MORE"),
    );
    const emitted: string[] = [];
    const res = await paginateSaved({
      igFetch: fetch, sleep: async () => {},
      onRecords: async (rs) => { emitted.push(...rs.map((r) => r.id)); },
      collMap: new Map(), knownIds: new Set(["instagram:known1"]), mode: "quick",
      batchSize: 10, maxItems: null, isStopped: () => false, onLog: () => {}, onProgress: () => {},
    });
    expect(res.earlyOut).toBe(true);
    expect(emitted).toEqual(["instagram:new1", "instagram:new2"]);
  });

  it("backs off then aborts on HTTP 429", async () => {
    const igFetch: IgFetch = vi.fn().mockResolvedValue({ status: 429, body: "" });
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {}, collMap,
      knownIds: new Set(), mode: "full", batchSize: 1,
      maxItems: null, isStopped: () => false, onLog: () => {}, onProgress: () => {}, maxBackoffRetries: 2,
    });
    expect(res.abortedRateLimited).toBe(true);
  });

  it("backs off then aborts on a 5xx throttle code (e.g. IG 572)", async () => {
    const igFetch: IgFetch = vi.fn().mockResolvedValue({ status: 572, body: "" });
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {}, collMap,
      knownIds: new Set(), mode: "full", batchSize: 1,
      maxItems: null, isStopped: () => false, onLog: () => {}, onProgress: () => {}, maxBackoffRetries: 2,
    });
    // 572 must be treated as retryable throttle (backoff → graceful abort),
    // NOT a hard stop. Retries = maxBackoffRetries + 1 attempts.
    expect(res.abortedRateLimited).toBe(true);
    expect((igFetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("honors maxItems cap", async () => {
    const igFetch: IgFetch = vi.fn().mockResolvedValue(page([{ code: "a" }, { code: "b" }], "MORE"));
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {}, collMap,
      knownIds: new Set(), mode: "full", batchSize: 10,
      maxItems: 2, isStopped: () => false, onLog: () => {}, onProgress: () => {},
    });
    expect(res.totalFetched).toBe(2);
  });
});
