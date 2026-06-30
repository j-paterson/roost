import { describe, it, expect, vi } from "vitest";
import { paginateSaved, type IgFetch } from "@/sync/instagram-sync";

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

describe("paginateSaved", () => {
  const collMap = new Map<string, { name: string; count: number }>();

  it("follows next_max_id until more_available is false", async () => {
    const igFetch: IgFetch = vi.fn()
      .mockResolvedValueOnce(page([{ code: "a" }, { code: "b" }], "CURSOR1"))
      .mockResolvedValueOnce(page([{ code: "c" }], null));
    const emitted: string[] = [];
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async (recs) => { emitted.push(...recs.map((r) => r.id)); },
      collMap, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3,
      maxItems: null, isStopped: () => false, onLog: () => {}, onProgress: () => {},
    });
    expect(res.totalFetched).toBe(3);
    expect(emitted).toEqual(["instagram:a", "instagram:b", "instagram:c"]);
    // second call carries the cursor verbatim
    expect((igFetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("max_id=CURSOR1");
  });

  it("early-outs after N consecutive all-known pages when prevComplete", async () => {
    const known = new Set(["instagram:a", "instagram:b", "instagram:c"]);
    const igFetch: IgFetch = vi.fn()
      .mockResolvedValue(page([{ code: "a" }, { code: "b" }, { code: "c" }], "MORE"));
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {},
      collMap: known.size ? collMap : collMap, knownIds: known, prevComplete: true,
      batchSize: 3, earlyOutThreshold: 2, maxItems: null, isStopped: () => false,
      onLog: () => {}, onProgress: () => {},
    });
    // stops after 2 all-known pages instead of looping forever
    expect((igFetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(res.earlyOut).toBe(true);
  });

  it("backs off then aborts on HTTP 429", async () => {
    const igFetch: IgFetch = vi.fn().mockResolvedValue({ status: 429, body: "" });
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {}, collMap,
      knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3,
      maxItems: null, isStopped: () => false, onLog: () => {}, onProgress: () => {}, maxBackoffRetries: 2,
    });
    expect(res.abortedRateLimited).toBe(true);
  });

  it("honors maxItems cap", async () => {
    const igFetch: IgFetch = vi.fn().mockResolvedValue(page([{ code: "a" }, { code: "b" }], "MORE"));
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {}, collMap,
      knownIds: new Set(), prevComplete: false, batchSize: 10, earlyOutThreshold: 3,
      maxItems: 2, isStopped: () => false, onLog: () => {}, onProgress: () => {},
    });
    expect(res.totalFetched).toBe(2);
  });

  it("does NOT early-out when all items on a page lack a code field (processedCount === 0)", async () => {
    // Items missing 'code' are skipped by the guard — processedCount stays 0 per page.
    // Even with prevComplete:true and earlyOutThreshold:2, the all-known path must not fire.
    const noCodePage = (moreAvailable: boolean, nextId?: string) => ({
      status: 200,
      body: JSON.stringify({
        items: [{ media: { pk: "x", media_type: 1 } }, { media: { pk: "y", media_type: 1 } }],
        more_available: moreAvailable,
        next_max_id: nextId ?? null,
      }),
    });
    const igFetch: IgFetch = vi.fn()
      .mockResolvedValueOnce(noCodePage(true, "C2"))
      .mockResolvedValueOnce(noCodePage(false));
    const res = await paginateSaved({
      igFetch, sleep: async () => {}, onRecords: async () => {},
      collMap, knownIds: new Set(), prevComplete: true,
      batchSize: 10, earlyOutThreshold: 2, maxItems: null,
      isStopped: () => false, onLog: () => {}, onProgress: () => {},
    });
    // processedCount === 0 on every page → earlyOut must be false
    expect(res.earlyOut).toBe(false);
  });
});
