import { describe, it, expect, vi } from "vitest";
import { paginateSaved, type RedditFetch } from "@/sync/reddit-sync";

function listing(ids: string[], after: string | null) {
  return { status: 200, body: JSON.stringify({ kind: "Listing", data: {
    after, dist: ids.length,
    children: ids.map(id => ({ kind: "t3", data: { id, name: "t3_" + id, permalink: "/r/x/comments/" + id + "/t/", created_utc: 1700000000, author: "u", subreddit: "x" } })),
  } }) };
}

describe("paginateSaved", () => {
  it("follows pagination to the empty end page; emits normalized records", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValueOnce(listing(["a", "b"], "t3_b")).mockResolvedValueOnce(listing(["c"], null)).mockResolvedValueOnce(listing([], null));
    const emitted: string[] = [];
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(res.totalFetched).toBe(3);
    expect(emitted).toEqual(["reddit:a", "reddit:b", "reddit:c"]);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("after=t3_b");
  });

  it("continues past a premature after:null using the last item's fullname", async () => {
    // Reddit's saved.json?type=links returns after:null prematurely on a short
    // page even though more items exist (confirmed live: a 99-item page reported
    // after:null, yet requesting after=<last item fullname> returned 100 more).
    const fetch: RedditFetch = vi.fn()
      .mockResolvedValueOnce(listing(["a", "b"], null))   // spurious null; last item = t3_b
      .mockResolvedValueOnce(listing(["c", "d"], null))   // resumed via after=t3_b; last = t3_d
      .mockResolvedValueOnce(listing([], null));          // genuine end: empty page
    const emitted: string[] = [];
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(emitted).toEqual(["reddit:a", "reddit:b", "reddit:c", "reddit:d"]);
    expect(res.totalFetched).toBe(4);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("after=t3_b");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[2][0]).toContain("after=t3_d");
  });

  it("stops on a genuinely empty page (no infinite loop on end-of-listing)", async () => {
    const fetch: RedditFetch = vi.fn()
      .mockResolvedValueOnce(listing(["a"], null))
      .mockResolvedValueOnce(listing([], null));
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async () => {}, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(res.totalFetched).toBe(1);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("stops when a whole page is cross-page duplicates (loop guard)", async () => {
    // Same page returned forever: after the first, every item is a dup → must stop.
    const fetch: RedditFetch = vi.fn().mockResolvedValue(listing(["a", "b"], null));
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async () => {}, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(res.totalFetched).toBe(2); // a,b once; second identical page is all dupes → stop
  });

  it("stops at the 1000-item hard cap", async () => {
    // Distinct items per page (the realistic large-account case) so the run keeps
    // making progress until the raw-scan hard cap trips.
    let n = 0;
    const fetch: RedditFetch = vi.fn(async () => {
      const base = n * 100; n++;
      const ids = Array.from({ length: 100 }, (_, i) => "x" + (base + i));
      return listing(ids, "t3_" + ids[ids.length - 1]); // distinct advancing cursor per page
    });
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async () => {}, knownIds: new Set(), prevComplete: false, batchSize: 100, earlyOutThreshold: 3, maxItems: null, hardCap: 250, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(res.hitHardCap).toBe(true);
    expect(res.totalFetched).toBe(249); // returns on the item that hits rawCount===250, before emitting it
  });

  it("dedupes ids seen across pages", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValueOnce(listing(["a", "b"], "t3_b")).mockResolvedValueOnce(listing(["b", "c"], null)).mockResolvedValueOnce(listing([], null));
    const emitted: string[] = [];
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(emitted).toEqual(["reddit:a", "reddit:b", "reddit:c"]); // b not re-emitted
    expect(res.totalFetched).toBe(3);
  });

  it("filters non-t3 children", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify({ kind: "Listing", data: { after: null, children: [ { kind: "t1", data: { id: "cmt" } }, { kind: "t3", data: { id: "post", permalink: "/r/x/comments/post/t/", created_utc: 1700000000, author: "u", subreddit: "x" } } ] } }) });
    const emitted: string[] = [];
    await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(emitted).toEqual(["reddit:post"]);
  });

  it("backs off then aborts on 429", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValue({ status: 429, body: "" });
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async () => {}, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {}, maxBackoffRetries: 2 });
    expect(res.abortedRateLimited).toBe(true);
  });
});
